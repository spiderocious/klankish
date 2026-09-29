import { createServer, type Server } from 'node:http';

import { newId, type TaskGraph } from '@klankish/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, query } from '../db/client.js';
import { runMigrations, truncateAll } from '../db/migrate.js';
import { RunContext } from './context.js';
import { executeRun } from './executor.js';
import { queue } from './queue.js';

/**
 * Executor integration tests.
 *
 * A real local HTTP server stands in for "some API out there" — not a fetch mock, because the
 * things worth testing here (status handling, header capture, redirect guarding, timeouts) are
 * exactly the things a mock would fake away.
 */

let server: Server;
let baseUrl: string;
let userId: string;
let taskId: string;

/** Request counter per path, so retry behaviour can be asserted rather than assumed. */
const hits = new Map<string, number>();

/** What the /echo-auth endpoint last received, for asserting the real outbound value. */
let lastAuthHeader: string | null = null;

/** The signature the /created endpoint last received, for asserting webhook signing. */
let lastWebhookSignature: string | null = null;

beforeAll(async () => {
  await runMigrations();

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);

    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    switch (path) {
      case '/users':
        send(200, {
          count: 3,
          users: [
            { id: 'a', name: 'Ada', active: true },
            { id: 'b', name: 'Bello', active: false },
            { id: 'c', name: 'Chidi', active: true },
          ],
        });
        return;

      case '/empty':
        send(200, { count: 0, users: [] });
        return;

      case '/boom':
        send(500, { error: 'upstream exploded' });
        return;

      case '/not-found':
        send(404, { error: 'nope' });
        return;

      case '/flaky': {
        // Fails twice, then succeeds — so a retry policy can be observed working.
        const n = hits.get(path) ?? 0;
        if (n <= 2) send(503, { error: 'try later' });
        else send(200, { recovered: true, attempts: n });
        return;
      }

      case '/slow':
        // Never responds within the test's timeout.
        setTimeout(() => send(200, { late: true }), 5_000);
        return;

      case '/echo-auth':
        // Recorded server-side so a test can assert what the upstream REALLY received, without
        // reading it back through the (redacted) run record.
        lastAuthHeader = req.headers.authorization ?? null;
        send(200, { got: req.headers.authorization ?? null });
        return;

      case '/created':
        lastWebhookSignature =
          (req.headers['x-klankish-signature'] as string | undefined) ?? null;
        send(201, { id: 'new-thing' });
        return;

      default:
        send(404, { error: 'unknown path' });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  hits.clear();
  lastAuthHeader = null;
  lastWebhookSignature = null;

  userId = newId('user');
  await query(
    `INSERT INTO users (id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', 'Test', 'user')`,
    [userId, `${userId}@test.test`],
  );

  taskId = newId('task');
  await query(
    `INSERT INTO tasks (id, owner_id, name, slug, concurrency_policy)
     VALUES ($1, $2, 'Test', 'test', 'allow')`,
    [taskId, userId],
  );
});

/** Build a run from a graph and execute it, returning the run plus its recorded steps. */
async function runGraph(
  graph: TaskGraph,
  secrets: Record<string, string> = {},
): Promise<{
  result: Awaited<ReturnType<typeof executeRun>>;
  steps: Array<{
    step_key: string;
    status: string;
    output: unknown;
    input: unknown;
    error: unknown;
    next_step_key: string | null;
    attempt: number;
  }>;
}> {
  const versionId = newId('task_version');
  await query(
    'INSERT INTO task_versions (id, task_id, version, graph) VALUES ($1, $2, 1, $3)',
    [versionId, taskId, JSON.stringify(graph)],
  );

  const run = await queue.enqueue({
    taskId,
    taskVersionId: versionId,
    trigger: 'manual',
    createdBy: userId,
  });
  const claimed = await queue.claimNext('test-worker');
  if (claimed === null) throw new Error('could not claim the run');

  const ctx = new RunContext(
    claimed,
    graph,
    { id: taskId, name: 'Test', owner_id: userId },
    secrets,
  );
  const result = await executeRun(ctx);
  await queue.complete(run.id, result.status, result.error);

  const steps = await query(
    `SELECT step_key, status, output, input, error, next_step_key, attempt
     FROM step_runs WHERE run_id = $1 ORDER BY idx`,
    [run.id],
  );

  return { result, steps: steps as never };
}

describe('linear execution', () => {
  it('runs a single http step and records the result', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'fetch',
      steps: [{ kind: 'http', key: 'fetch', method: 'GET', url: `${baseUrl}/users`, next: null }],
    });

    expect(result.status).toBe('succeeded');
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe('succeeded');
    const output = steps[0]?.output as { status: number; body: { count: number } };
    expect(output.status).toBe(200);
    expect(output.body.count).toBe(3);
  });

  it('runs steps in sequence and passes data between them', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'fetch',
      steps: [
        {
          kind: 'http',
          key: 'fetch',
          method: 'GET',
          url: `${baseUrl}/users`,
          next: 'summarise',
          capture: [{ name: 'user_count', from: 'steps.fetch.output.body.count' }],
        },
        {
          kind: 'transform',
          key: 'summarise',
          set: { doubled: 'vars.user_count * 2', label: '"count=" + vars.user_count' },
          next: null,
        },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(steps).toHaveLength(2);
    const out = steps[1]?.output as { doubled: number; label: string };
    expect(out.doubled).toBe(6);
    expect(out.label).toBe('count=3');
  });

  it('records the resolved input, not the raw template', async () => {
    // The record must show what was ACTUALLY sent, or it cannot be used to debug.
    const { steps } = await runGraph({
      version: 1,
      entry: 'a',
      steps: [
        {
          kind: 'http',
          key: 'a',
          method: 'GET',
          url: `${baseUrl}/users`,
          next: 'b',
          capture: [{ name: 'n', from: 'steps.a.output.body.count' }],
        },
        {
          kind: 'http',
          key: 'b',
          method: 'GET',
          url: `${baseUrl}/users?n={{ vars.n }}`,
          next: null,
        },
      ],
    });

    const input = steps[1]?.input as { url: string };
    expect(input.url).toBe(`${baseUrl}/users?n=3`);
    expect(input.url).not.toContain('{{');
  });
});

describe('branching', () => {
  it('takes the matching branch and records WHICH condition matched', async () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'fetch',
      steps: [
        { kind: 'http', key: 'fetch', method: 'GET', url: `${baseUrl}/users`, next: 'check' },
        {
          kind: 'branch',
          key: 'check',
          cases: [
            { when: 'steps.fetch.output.body.count > 10', goto: 'many' },
            { when: 'steps.fetch.output.body.count > 0', goto: 'some' },
          ],
          otherwise: 'none',
        },
        { kind: 'transform', key: 'many', set: { path: '"many"' }, next: null },
        { kind: 'transform', key: 'some', set: { path: '"some"' }, next: null },
        { kind: 'transform', key: 'none', set: { path: '"none"' }, next: null },
      ],
    };

    const { result, steps } = await runGraph(graph);
    expect(result.status).toBe('succeeded');

    const branch = steps.find((s) => s.step_key === 'check');
    expect(branch?.next_step_key).toBe('some');
    // The recorded decision includes the condition text, which is what makes a branch debuggable
    // months later.
    const out = branch?.output as { matched: boolean; case_index: number; condition: string };
    expect(out.matched).toBe(true);
    expect(out.case_index).toBe(1);
    expect(out.condition).toContain('> 0');

    // Only the taken path ran.
    expect(steps.map((s) => s.step_key)).toEqual(['fetch', 'check', 'some']);
  });

  it('falls through to otherwise when nothing matches', async () => {
    const { steps } = await runGraph({
      version: 1,
      entry: 'fetch',
      steps: [
        { kind: 'http', key: 'fetch', method: 'GET', url: `${baseUrl}/empty`, next: 'check' },
        {
          kind: 'branch',
          key: 'check',
          cases: [{ when: 'steps.fetch.output.body.count > 0', goto: 'some' }],
          otherwise: 'none',
        },
        { kind: 'transform', key: 'some', set: { p: '"some"' }, next: null },
        { kind: 'transform', key: 'none', set: { p: '"none"' }, next: null },
      ],
    });

    expect(steps.map((s) => s.step_key)).toEqual(['fetch', 'check', 'none']);
  });

  it('ends the run when otherwise is null and nothing matched', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'check',
      steps: [
        { kind: 'branch', key: 'check', cases: [{ when: 'false', goto: 'x' }], otherwise: null },
        { kind: 'noop', key: 'x', next: null },
      ],
    });
    expect(result.status).toBe('succeeded');
    expect(steps.map((s) => s.step_key)).toEqual(['check']);
  });
});

describe('the if gate', () => {
  it('skips a gated step but still RECORDS the skip', async () => {
    // A gap in the timeline is not a record. "This did not run" is a fact the reader needs.
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'fetch',
      steps: [
        { kind: 'http', key: 'fetch', method: 'GET', url: `${baseUrl}/empty`, next: 'maybe' },
        {
          kind: 'transform',
          key: 'maybe',
          if: 'steps.fetch.output.body.count > 0',
          set: { x: '1' },
          next: 'done',
        },
        { kind: 'noop', key: 'done', next: null },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(steps.map((s) => s.step_key)).toEqual(['fetch', 'maybe', 'done']);
    expect(steps[1]?.status).toBe('skipped');
  });

  it('runs a gated step when the condition holds', async () => {
    const { steps } = await runGraph({
      version: 1,
      entry: 'fetch',
      steps: [
        { kind: 'http', key: 'fetch', method: 'GET', url: `${baseUrl}/users`, next: 'maybe' },
        {
          kind: 'transform',
          key: 'maybe',
          if: 'steps.fetch.output.body.count > 0',
          set: { x: '1' },
          next: null,
        },
      ],
    });
    expect(steps[1]?.status).toBe('succeeded');
  });
});

describe('failure handling', () => {
  it('fails the run on a 500 and stops there', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'boom',
      steps: [
        {
          kind: 'http',
          key: 'boom',
          method: 'GET',
          url: `${baseUrl}/boom`,
          next: 'after',
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
        { kind: 'noop', key: 'after', next: null },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.identity).toBe('http_request_failed');
    expect(steps).toHaveLength(1); // `after` never ran
    expect(steps[0]?.status).toBe('failed');
  });

  it('continues past a failure when on_error is continue', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'boom',
      steps: [
        {
          kind: 'http',
          key: 'boom',
          method: 'GET',
          url: `${baseUrl}/boom`,
          next: 'after',
          on_error: 'continue',
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
        { kind: 'transform', key: 'after', set: { ran: 'true' }, next: null },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(steps.map((s) => s.step_key)).toEqual(['boom', 'after']);
    expect(steps[0]?.status).toBe('failed');
    expect(steps[1]?.status).toBe('succeeded');
  });

  it('jumps to a handler step when on_error has a goto', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'boom',
      steps: [
        {
          kind: 'http',
          key: 'boom',
          method: 'GET',
          url: `${baseUrl}/boom`,
          next: 'normal',
          on_error: { goto: 'handler' },
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
        { kind: 'noop', key: 'normal', next: null },
        { kind: 'transform', key: 'handler', set: { handled: 'true' }, next: null },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(steps.map((s) => s.step_key)).toEqual(['boom', 'handler']);
  });

  it('retries a 503 and succeeds, recording the attempt count', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'flaky',
      steps: [
        {
          kind: 'http',
          key: 'flaky',
          method: 'GET',
          url: `${baseUrl}/flaky`,
          next: null,
          retry: { max_attempts: 5, backoff: 'fixed', base_ms: 10, max_ms: 20, jitter: false },
        },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(hits.get('/flaky')).toBe(3); // failed twice, succeeded on the third
    expect(steps[0]?.attempt).toBe(3);
  });

  it('does NOT retry a 404 (a client error is deterministic)', async () => {
    const { result } = await runGraph({
      version: 1,
      entry: 'nf',
      steps: [
        {
          kind: 'http',
          key: 'nf',
          method: 'GET',
          url: `${baseUrl}/not-found`,
          next: null,
          retry: { max_attempts: 5, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
      ],
    });

    expect(result.status).toBe('failed');
    // Retrying would fail identically, so it must not have been attempted again.
    expect(hits.get('/not-found')).toBe(1);
  });

  it('times out a slow request', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'slow',
      steps: [
        {
          kind: 'http',
          key: 'slow',
          method: 'GET',
          url: `${baseUrl}/slow`,
          timeout_ms: 300,
          next: null,
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
      ],
    });

    expect(result.status).toBe('timed_out');
    expect(steps[0]?.status).toBe('timed_out');
  });

  it('fails an assertion with its message', async () => {
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'fetch',
      steps: [
        { kind: 'http', key: 'fetch', method: 'GET', url: `${baseUrl}/empty`, next: 'check' },
        {
          kind: 'assert',
          key: 'check',
          condition: 'steps.fetch.output.body.count > 0',
          message: 'Expected at least one user.',
          next: null,
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.identity).toBe('assertion_failed');
    expect(result.error?.message).toBe('Expected at least one user.');
    const err = steps[1]?.error as { identity: string; message: string };
    expect(err.message).toBe('Expected at least one user.');
  });

  it('fails clearly when a template references something that does not exist', async () => {
    // Strict interpolation: a silent `undefined` in an outbound call is how you corrupt a
    // downstream system, so this must be a loud failure.
    const { result } = await runGraph({
      version: 1,
      entry: 'a',
      steps: [
        {
          kind: 'http',
          key: 'a',
          method: 'GET',
          url: `${baseUrl}/users?x={{ steps.ghost.output.id }}`,
          next: null,
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.identity).toBe('interpolation_failed');
  });
});

describe('secrets', () => {
  it('sends the real secret but NEVER records it', async () => {
    // The whole point of the redaction design, end to end.
    const SECRET = 'sk_live_do_not_leak_me_123456';
    const { result, steps } = await runGraph(
      {
        version: 1,
        entry: 'a',
        steps: [
          {
            kind: 'http',
            key: 'a',
            method: 'GET',
            url: `${baseUrl}/echo-auth`,
            headers: { Authorization: 'Bearer {{ secrets.API_KEY }}' },
            next: null,
          },
        ],
      },
      { API_KEY: SECRET },
    );

    expect(result.status).toBe('succeeded');

    // The upstream really received the plaintext — asserted from the SERVER's own record, not
    // from the run record, which is redacted by design.
    expect(lastAuthHeader).toBe(`Bearer ${SECRET}`);

    // The echo endpoint sent the secret straight back in its response body, and redaction caught
    // it there too. That is by-VALUE redaction doing its job: a secret that has moved out of the
    // header it started in is still scrubbed.
    const output = steps[0]?.output as { body: { got: string } };
    expect(output.body.got).toBe('Bearer [REDACTED]');

    // ...and it is nowhere in the stored record.
    const serialised = JSON.stringify(steps);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain('[REDACTED]');

    // Nor in the http_exchanges row.
    const exchanges = await query<{ request_headers: unknown; response_body_inline: unknown }>(
      'SELECT request_headers, response_body_inline FROM http_exchanges',
    );
    expect(JSON.stringify(exchanges)).not.toContain(SECRET);
  });
});

// NOTE: SSRF protection is tested in `src/engine/steps/ssrf.test.ts`, as a unit test of the
// address rules. It cannot be tested here: this suite sets HTTP_STEP_ALLOW_PRIVATE=true so that
// the executor tests can reach their local 127.0.0.1 test server.

describe('cancellation', () => {
  it('stops between steps when cancellation is requested', async () => {
    const versionId = newId('task_version');
    const graph: TaskGraph = {
      version: 1,
      entry: 'wait',
      steps: [
        { kind: 'delay', key: 'wait', ms: 150, next: 'after' },
        { kind: 'noop', key: 'after', next: null },
      ],
    };
    await query(
      'INSERT INTO task_versions (id, task_id, version, graph) VALUES ($1, $2, 1, $3)',
      [versionId, taskId, JSON.stringify(graph)],
    );

    const run = await queue.enqueue({
      taskId,
      taskVersionId: versionId,
      trigger: 'manual',
      createdBy: userId,
    });
    const claimed = await queue.claimNext('test-worker');
    if (claimed === null) throw new Error('claim failed');

    // Cancel while the first step is in its delay.
    setTimeout(() => void queue.requestCancel(run.id), 50);

    const ctx = new RunContext(claimed, graph, { id: taskId, name: 'T', owner_id: userId }, {});
    const result = await executeRun(ctx);

    expect(result.status).toBe('cancelled');
    // The first step completed and was recorded; the second never started. Cancellation is
    // cooperative precisely so the record is never left half-written.
    const steps = await query<{ step_key: string }>(
      'SELECT step_key FROM step_runs WHERE run_id = $1 ORDER BY idx',
      [run.id],
    );
    expect(steps.map((s) => s.step_key)).toEqual(['wait']);
  });
});

describe('the record', () => {
  it('writes a complete http exchange', async () => {
    await runGraph({
      version: 1,
      entry: 'a',
      steps: [
        {
          kind: 'http',
          key: 'a',
          method: 'POST',
          url: `${baseUrl}/created`,
          body: { hello: 'world' },
          expect_status: [201],
          next: null,
        },
      ],
    });

    const rows = await query<{
      request_method: string;
      request_url: string;
      response_status: number;
      bytes: number;
      duration_ms: number;
      response_body_inline: unknown;
    }>('SELECT * FROM http_exchanges');

    expect(rows).toHaveLength(1);
    const ex = rows[0];
    expect(ex?.request_method).toBe('POST');
    expect(ex?.response_status).toBe(201);
    expect(ex?.bytes).toBeGreaterThan(0);
    expect(ex?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(ex?.response_body_inline).toEqual({ id: 'new-thing' });
  });

  it('records every step in execution order with timings', async () => {
    const { steps } = await runGraph({
      version: 1,
      entry: 'a',
      steps: [
        { kind: 'noop', key: 'a', next: 'b' },
        { kind: 'delay', key: 'b', ms: 20, next: 'c' },
        { kind: 'noop', key: 'c', next: null },
      ],
    });

    expect(steps.map((s) => s.step_key)).toEqual(['a', 'b', 'c']);

    const durations = await query<{ duration_ms: number; idx: number }>(
      'SELECT duration_ms, idx FROM step_runs ORDER BY idx',
    );
    expect(durations.map((d) => d.idx)).toEqual([0, 1, 2]);
    expect(durations[1]?.duration_ms).toBeGreaterThanOrEqual(15);
  });
});

describe('integration steps', () => {
  it('fails an email step with a clear identity when mail is not configured', async () => {
    // Degrade honestly: an unconfigured instance must say so, not pretend the email went out.
    const { result, steps } = await runGraph({
      version: 1,
      entry: 'mail',
      steps: [
        {
          kind: 'email',
          key: 'mail',
          to: ['someone@example.test'],
          subject: 'Test',
          text: 'Body',
          next: null,
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.identity).toBe('mail_not_configured');
    const err = steps[0]?.error as { identity: string; message: string };
    expect(err.message).toContain('not set up');
  });

  it('fails a storage step with a clear identity when storage is not configured', async () => {
    const { result } = await runGraph({
      version: 1,
      entry: 'put',
      steps: [
        {
          kind: 'storage_put',
          key: 'put',
          object_key: 'reports/daily.json',
          content: 'hello',
          next: null,
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.identity).toBe('storage_not_configured');
  });

  it('fails a webhook step when the named endpoint does not exist', async () => {
    const { result } = await runGraph({
      version: 1,
      entry: 'hook',
      steps: [
        {
          kind: 'webhook',
          key: 'hook',
          endpoint: 'nonexistent',
          event: 'test.event',
          next: null,
          retry: { max_attempts: 1, backoff: 'fixed', base_ms: 1, max_ms: 1, jitter: false },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.identity).toBe('not_found');
  });

  it('delivers a webhook to a registered endpoint with an HMAC signature', async () => {
    await query(
      `INSERT INTO webhook_endpoints (id, owner_id, name, url, secret, enabled)
       VALUES ($1, $2, 'local', $3, 'shhh', TRUE)`,
      [newId('webhook'), userId, `${baseUrl}/created`],
    );

    const { result, steps } = await runGraph({
      version: 1,
      entry: 'hook',
      steps: [
        {
          kind: 'webhook',
          key: 'hook',
          endpoint: 'local',
          event: 'run.finished',
          payload: { hello: 'world' },
          next: null,
        },
      ],
    });

    expect(result.status).toBe('succeeded');
    const out = steps[0]?.output as { status: number; ok: boolean };
    expect(out.ok).toBe(true);
    expect(out.status).toBe(201);
    expect(lastWebhookSignature).not.toBe(null);
  });
});
