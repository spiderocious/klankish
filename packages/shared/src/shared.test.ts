import { describe, expect, it } from 'vitest';

import { applyRetryAfter, computeBackoffMs, parseRetryAfter, shouldRetry } from './backoff.js';
import { describeCron, nextFireAt, nextFires, parseCron } from './cron.js';
import { buildPage, clampLimit, decodeCursor, encodeCursor } from './cursor.js';
import { ERROR_CODES, severityFor, SEVERITY, statusFor } from './errors.js';
import { validateGraph } from './graph-validate.js';
import { DEFAULT_RETRY, isIdempotent, outgoingTargets, type Step, type TaskGraph } from './graph.js';
import { idTimestamp, isId, newId, ulid } from './ids.js';
import { ERROR_MESSAGES } from './messages.js';
import { atLeast, can, canAccessOwned, canAssignRole, canMutateOwned, type Actor } from './rbac.js';
import { isSensitiveName, redact, redactHeaders, redactUrl, REDACTED } from './redact.js';

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

describe('ids', () => {
  it('generates prefixed, sortable ids', () => {
    const a = newId('run', 1_700_000_000_000);
    const b = newId('run', 1_700_000_001_000);
    expect(a.startsWith('r_')).toBe(true);
    expect(a < b).toBe(true); // lexicographic order === chronological order
  });

  it('validates shape and prefix', () => {
    const id = newId('task');
    expect(isId(id)).toBe(true);
    expect(isId(id, 'task')).toBe(true);
    expect(isId(id, 'run')).toBe(false); // right shape, wrong resource
    expect(isId('not-an-id')).toBe(false);
    expect(isId('t_short')).toBe(false);
    expect(isId(42)).toBe(false);
    expect(isId(null)).toBe(false);
  });

  it('round-trips the embedded timestamp', () => {
    const now = 1_700_000_000_000;
    expect(idTimestamp(newId('run', now))).toBe(now);
    expect(idTimestamp('garbage')).toBe(null);
  });

  it('does not collide across many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(ulid());
    expect(seen.size).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// RBAC — the ladder must hold in every direction
// ---------------------------------------------------------------------------

describe('rbac', () => {
  const user: Actor = { id: 'u_1', role: 'user', status: 'active' };
  const admin: Actor = { id: 'u_2', role: 'admin', status: 'active' };
  const superAdmin: Actor = { id: 'u_3', role: 'super_admin', status: 'active' };
  const suspended: Actor = { id: 'u_4', role: 'admin', status: 'suspended' };

  it('is a strict ladder', () => {
    expect(atLeast('user', 'user')).toBe(true);
    expect(atLeast('user', 'admin')).toBe(false);
    expect(atLeast('admin', 'user')).toBe(true);
    expect(atLeast('super_admin', 'admin')).toBe(true);
    expect(atLeast('super_admin', 'super_admin')).toBe(true);
  });

  it('gives super_admin every permission an admin has', () => {
    // The invariant that matters: super_admin ⊇ admin. Enumerated rather than asserted.
    const perms = [
      'task.read.any', 'task.pause.any', 'run.read.any', 'run.kill.any',
      'user.read.any', 'user.suspend', 'audit.read', 'worker.read', 'queue.manage',
    ] as const;
    for (const p of perms) {
      if (can(admin, p)) expect(can(superAdmin, p)).toBe(true);
    }
  });

  it('restricts super_admin-only permissions', () => {
    expect(can(admin, 'user.delete')).toBe(false);
    expect(can(superAdmin, 'user.delete')).toBe(true);
    expect(can(admin, 'user.role.change')).toBe(false);
    expect(can(superAdmin, 'user.role.change')).toBe(true);
    expect(can(admin, 'encryption.rotate')).toBe(false);
    expect(can(superAdmin, 'encryption.rotate')).toBe(true);
  });

  it('denies everything to a suspended actor regardless of role', () => {
    expect(can(suspended, 'task.read.any')).toBe(false);
    expect(canAccessOwned(suspended, suspended.id)).toBe(false);
    expect(canMutateOwned(suspended, suspended.id)).toBe(false);
  });

  it('scopes ownership: users see their own, admins see all', () => {
    expect(canAccessOwned(user, 'u_1')).toBe(true);
    expect(canAccessOwned(user, 'u_other')).toBe(false);
    expect(canAccessOwned(admin, 'u_other')).toBe(true);
  });

  it('lets an admin read but not edit another user task', () => {
    // Deliberate asymmetry: an admin can see and pause, but silently editing someone else's
    // automation belongs to super_admin.
    expect(canAccessOwned(admin, 'u_other')).toBe(true);
    expect(canMutateOwned(admin, 'u_other')).toBe(false);
    expect(canMutateOwned(superAdmin, 'u_other')).toBe(true);
    expect(canMutateOwned(user, 'u_1')).toBe(true);
  });

  it('prevents privilege escalation when assigning roles', () => {
    expect(canAssignRole(admin, 'user')).toBe(false); // admin cannot change roles at all
    expect(canAssignRole(superAdmin, 'admin')).toBe(true);
    expect(canAssignRole(superAdmin, 'super_admin')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('errors', () => {
  it('has a real message for every identity', () => {
    // A generic default is a bug, not a fallback — so every code must be present.
    for (const code of Object.values(ERROR_CODES)) {
      const msg = ERROR_MESSAGES[code];
      expect(msg, `missing message for ${code}`).toBeTruthy();
      expect(msg).not.toBe('Request failed');
    }
  });

  it('maps identities to sensible statuses', () => {
    expect(statusFor(ERROR_CODES.NOT_FOUND)).toBe(404);
    expect(statusFor(ERROR_CODES.FORBIDDEN)).toBe(403);
    expect(statusFor(ERROR_CODES.RATE_LIMITED)).toBe(429);
    expect(statusFor(ERROR_CODES.VALIDATION_ERROR)).toBe(422);
    // 410 Gone, not 404: it existed and expired.
    expect(statusFor(ERROR_CODES.GONE)).toBe(410);
  });

  it('bands suspicious validation apart from ordinary validation', () => {
    // The distinction that lets a dashboard separate typos from probing.
    expect(severityFor(ERROR_CODES.VALIDATION_ERROR)).toBe(SEVERITY.BODY_VALIDATION);
    expect(severityFor(ERROR_CODES.SECRET_NOT_FOUND)).toBe(SEVERITY.SUSPICIOUS_VALIDATION);
    expect(severityFor(ERROR_CODES.HTTP_BLOCKED_TARGET)).toBe(SEVERITY.SUSPICIOUS_VALIDATION);
    expect(severityFor(ERROR_CODES.TOKEN_REUSED)).toBe(SEVERITY.SUSPICIOUS_VALIDATION);
  });

  it('pages only on upstream and server faults', () => {
    expect(severityFor(ERROR_CODES.INTERNAL_ERROR)).toBe(SEVERITY.SERVER_FAULT);
    expect(severityFor(ERROR_CODES.HTTP_REQUEST_FAILED)).toBe(SEVERITY.UPSTREAM);
    expect(severityFor(ERROR_CODES.INVALID_CREDENTIALS)).toBe(SEVERITY.AUTH);
  });
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

describe('cursor', () => {
  it('round-trips without loss', () => {
    const c = { last_id: 'r_01HV8QJZ', last_sort_key: '2026-09-28T12:00:00.000Z' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('returns null for malformed input rather than throwing', () => {
    // A hand-edited URL must serve page one, not a 500.
    expect(decodeCursor('not-base64!!')).toBe(null);
    expect(decodeCursor('')).toBe(null);
    expect(decodeCursor(btoa('{"nope":1}'))).toBe(null);
    expect(decodeCursor(btoa('not json'))).toBe(null);
  });

  it('clamps limits and never trusts the client', () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(9999)).toBe(50);
    expect(clampLimit(9999, true)).toBe(100);
    expect(clampLimit(-5)).toBe(20);
    expect(clampLimit('30')).toBe(30);
    expect(clampLimit('abc')).toBe(20);
  });

  it('builds a page from limit+1 rows', () => {
    const rows = [1, 2, 3, 4].map((n) => ({ id: `r_${n}`, at: `2026-01-0${n}` }));
    const page = buildPage(rows, 3, (r) => ({ last_id: r.id, last_sort_key: r.at }));
    expect(page.items).toHaveLength(3);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).not.toBe(null);

    const last = buildPage(rows.slice(0, 2), 3, (r) => ({ last_id: r.id, last_sort_key: r.at }));
    expect(last.has_more).toBe(false);
    expect(last.next_cursor).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Redaction — a secret must never survive any path
// ---------------------------------------------------------------------------

describe('redaction', () => {
  it('redacts by field name', () => {
    const out = redact({ password: 'hunter2', api_key: 'abc', name: 'ok' });
    expect(out.password).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out.name).toBe('ok');
  });

  it('redacts by value wherever it appears', () => {
    // The case name-matching alone would miss: a token echoed back inside a response body.
    const secret = 'sk_live_supersecret';
    const out = redact(
      { url: `https://api.test?k=${secret}`, note: `used ${secret} here`, nested: { deep: secret } },
      { values: [secret] },
    );
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.note).toBe(`used ${REDACTED} here`);
    expect(out.nested.deep).toBe(REDACTED);
  });

  it('does not redact allowlisted names that merely contain a sensitive word', () => {
    // Redacting token_count would hide the thing you need in order to debug.
    expect(isSensitiveName('token_count')).toBe(false);
    expect(isSensitiveName('auth_method')).toBe(false);
    expect(isSensitiveName('secret_name')).toBe(false);
    expect(isSensitiveName('authorization')).toBe(true);
    expect(isSensitiveName('X-API-Key')).toBe(true);
  });

  it('ignores very short secret values to avoid destroying the record', () => {
    const out = redact({ text: 'aaa bbb aaa' }, { values: ['aaa'] });
    expect(out.text).toBe('aaa bbb aaa');
  });

  it('prefers the longest match when secrets overlap', () => {
    const out = redact({ t: 'abcdefghij' }, { values: ['abcdef', 'abcdefghij'] });
    expect(out.t).toBe(REDACTED);
  });

  it('redacts headers case-insensitively', () => {
    const out = redactHeaders({ Authorization: 'Bearer x', 'content-type': 'application/json' });
    expect(out['Authorization']).toBe(REDACTED);
    expect(out['content-type']).toBe('application/json');
  });

  it('redacts url credentials and secret-looking query params', () => {
    expect(redactUrl('https://api.test/x?api_key=abc123&page=2')).toContain(REDACTED);
    expect(redactUrl('https://api.test/x?api_key=abc123&page=2')).toContain('page=2');
    expect(redactUrl('https://user:pass@api.test/x')).toContain(REDACTED);
    // A non-URL string must not throw.
    expect(redactUrl('{{ vars.url }}')).toBe('{{ vars.url }}');
  });

  it('handles arrays, dates, errors and depth without throwing', () => {
    const out = redact({
      list: [{ token: 'x' }, { ok: 1 }],
      when: new Date('2026-01-01T00:00:00Z'),
      err: new Error('boom'),
    });
    expect(out.list[0]?.token).toBe(REDACTED);
    expect(out.when).toBe('2026-01-01T00:00:00.000Z');

    let deep: unknown = 'x';
    for (let i = 0; i < 50; i += 1) deep = { n: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('truncates very long strings', () => {
    const out = redact({ big: 'x'.repeat(30_000) }, { maxStringLen: 100 });
    expect(out.big.length).toBeLessThan(200);
    expect(out.big).toContain('TRUNCATED');
  });
});

// ---------------------------------------------------------------------------
// Cron — including the DST cases that motivated hand-writing this
// ---------------------------------------------------------------------------

describe('cron parsing', () => {
  it('accepts standard expressions', () => {
    for (const e of ['* * * * *', '0 0 * * *', '*/15 * * * *', '0 9-17 * * 1-5', '0 0 1 1 *']) {
      expect(parseCron(e).ok, e).toBe(true);
    }
  });

  it('accepts macros and aliases', () => {
    expect(parseCron('@daily').ok).toBe(true);
    expect(parseCron('@hourly').ok).toBe(true);
    expect(parseCron('0 0 * jan mon').ok).toBe(true);
  });

  it('rejects malformed expressions', () => {
    for (const e of ['', '* * *', '60 * * * *', '* 24 * * *', '* * 32 * *', 'a b c d e', '*/0 * * * *']) {
      expect(parseCron(e).ok, e).toBe(false);
    }
  });

  it('treats 0 and 7 as Sunday', () => {
    const a = parseCron('0 0 * * 0');
    const b = parseCron('0 0 * * 7');
    expect([...(a.fields?.daysOfWeek ?? [])]).toEqual([...(b.fields?.daysOfWeek ?? [])]);
  });

  it('expands steps and ranges', () => {
    expect([...(parseCron('*/15 * * * *').fields?.minutes ?? [])]).toEqual([0, 15, 30, 45]);
    expect([...(parseCron('0 9-12 * * *').fields?.hours ?? [])]).toEqual([9, 10, 11, 12]);
    expect([...(parseCron('0 0-23/6 * * *').fields?.hours ?? [])]).toEqual([0, 6, 12, 18]);
  });
});

describe('cron next fire', () => {
  it('computes the next minute', () => {
    const after = new Date('2026-09-28T10:30:20.000Z');
    expect(nextFireAt('* * * * *', after, 'UTC')?.toISOString()).toBe('2026-09-28T10:31:00.000Z');
  });

  it('computes a daily fire in UTC', () => {
    const after = new Date('2026-09-28T10:00:00.000Z');
    expect(nextFireAt('0 2 * * *', after, 'UTC')?.toISOString()).toBe('2026-09-29T02:00:00.000Z');
  });

  it('respects a non-UTC timezone', () => {
    // Africa/Lagos is UTC+1 year-round, so 02:30 local === 01:30Z.
    const after = new Date('2026-09-28T00:00:00.000Z');
    expect(nextFireAt('30 2 * * *', after, 'Africa/Lagos')?.toISOString()).toBe(
      '2026-09-28T01:30:00.000Z',
    );
  });

  it('is strictly after the given instant', () => {
    const at = new Date('2026-09-28T10:00:00.000Z');
    const next = nextFireAt('0 10 * * *', at, 'UTC');
    expect(next?.getTime()).toBeGreaterThan(at.getTime());
    expect(next?.toISOString()).toBe('2026-09-29T10:00:00.000Z');
  });

  it('handles the spring-forward gap without inventing a fire', () => {
    // Europe/London: 2026-03-29 01:00Z, clocks jump 01:00 -> 02:00 local. 01:30 local never
    // happens that day, so a "daily 01:30" job must skip to the next day rather than fire twice
    // or fire at a time that did not exist.
    const after = new Date('2026-03-28T12:00:00.000Z');
    const next = nextFireAt('30 1 * * *', after, 'Europe/London');
    expect(next).not.toBe(null);
    const iso = next?.toISOString() ?? '';
    // Must not land inside the skipped hour.
    expect(iso).not.toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(iso).getTime()).toBeGreaterThan(after.getTime());
  });

  it('fires once, not twice, across the autumn fall-back', () => {
    // Europe/London 2026-10-25: 02:00 local occurs twice. A daily 01:30 must produce exactly one
    // fire for that calendar day.
    const start = new Date('2026-10-24T12:00:00.000Z');
    const fires = nextFires('30 1 * * *', start, 'Europe/London', 4);
    const onThe25th = fires.filter((f) => {
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(f);
      return local === '25/10/2026';
    });
    expect(onThe25th).toHaveLength(1);
  });

  it('applies the DOM/DOW OR rule', () => {
    // `0 0 13 * 5` means the 13th OR any Friday — never "Friday the 13th" only.
    const after = new Date('2026-11-01T00:00:00.000Z');
    const fires = nextFires('0 0 13 * 5', after, 'UTC', 8);
    const days = fires.map((f) => f.getUTCDay());
    const dates = fires.map((f) => f.getUTCDate());
    // Every fire is either a Friday (5) or the 13th.
    for (let i = 0; i < fires.length; i += 1) {
      expect(days[i] === 5 || dates[i] === 13).toBe(true);
    }
    // And there are more of them than "Friday the 13th" alone would give.
    expect(fires.length).toBe(8);
  });

  it('produces strictly increasing fires', () => {
    const fires = nextFires('*/7 * * * *', new Date('2026-09-28T10:00:00.000Z'), 'UTC', 10);
    for (let i = 1; i < fires.length; i += 1) {
      expect(fires[i]!.getTime()).toBeGreaterThan(fires[i - 1]!.getTime());
    }
  });

  it('returns null for an invalid expression or timezone', () => {
    expect(nextFireAt('nonsense', new Date(), 'UTC')).toBe(null);
    expect(nextFireAt('* * * * *', new Date(), 'Not/AZone')).toBe(null);
  });

  it('finds a distant valid date (Feb 29)', () => {
    const next = nextFireAt('0 0 29 2 *', new Date('2026-03-01T00:00:00.000Z'), 'UTC');
    expect(next?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it.each<[string, string]>([
    ['* * * * *', 'Every minute'],
    ['0 9 * * *', 'Every day at 09:00'],
    ['0 * * * *', 'Every hour at :00'],
    // Step expressions describe a FREQUENCY. Rendering them positionally produced
    // "Every hour at :*/15", which is how this bug was found — on a real task's schedule card.
    ['*/15 * * * *', 'Every 15 minutes'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['0 */6 * * *', 'Every 6 hours at :00'],
    ['30 2 * * 1-5', 'Weekdays at 02:30'],
    ['0 0 * * 6,0', 'Weekends at 00:00'],
    ['0 0 * * 0', 'Every Sunday at 00:00'],
    ['@daily', 'Every day at 00:00'],
    ['bad', 'Invalid schedule'],
  ])('describes %s as "%s"', (expr, want) => {
    expect(describeCron(expr)).toBe(want);
  });

  it('never renders a raw step expression into a description', () => {
    // The class of bug, not just the instance: no description should leak cron syntax.
    for (const expr of ['*/15 * * * *', '*/2 * * * *', '0 */3 * * *', '*/30 * * * *']) {
      const described = describeCron(expr);
      expect(described, expr).not.toContain('*');
      expect(described, expr).not.toContain('/');
    }
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe('backoff', () => {
  const policy = { ...DEFAULT_RETRY, jitter: false, base_ms: 1000, max_ms: 30_000 };

  it('grows exponentially and caps', () => {
    expect(computeBackoffMs({ policy, attempt: 1 })).toBe(1000);
    expect(computeBackoffMs({ policy, attempt: 2 })).toBe(2000);
    expect(computeBackoffMs({ policy, attempt: 3 })).toBe(4000);
    expect(computeBackoffMs({ policy, attempt: 10 })).toBe(30_000); // capped
  });

  it('supports fixed and linear', () => {
    expect(computeBackoffMs({ policy: { ...policy, backoff: 'fixed' }, attempt: 5 })).toBe(1000);
    expect(computeBackoffMs({ policy: { ...policy, backoff: 'linear' }, attempt: 3 })).toBe(3000);
  });

  it('uses FULL jitter, spanning the whole window', () => {
    // Full jitter means random(0, capped) — not capped ± a few percent. Verified at the extremes.
    const jittered = { ...policy, jitter: true };
    expect(computeBackoffMs({ policy: jittered, attempt: 3, random: () => 0 })).toBe(0);
    expect(computeBackoffMs({ policy: jittered, attempt: 3, random: () => 1 })).toBe(4000);
    expect(computeBackoffMs({ policy: jittered, attempt: 3, random: () => 0.5 })).toBe(2000);
  });

  it('never returns a negative delay', () => {
    expect(computeBackoffMs({ policy: { ...policy, base_ms: 0 }, attempt: 1 })).toBe(0);
  });

  it('stops retrying once attempts are exhausted', () => {
    const p = { ...DEFAULT_RETRY, max_attempts: 3 };
    expect(shouldRetry({ policy: p, attempt: 3, idempotent: true, failure: 'network' })).toBe(false);
    expect(shouldRetry({ policy: p, attempt: 2, idempotent: true, failure: 'network' })).toBe(true);
  });

  it('never retries deterministic or client failures', () => {
    const p = DEFAULT_RETRY;
    expect(shouldRetry({ policy: p, attempt: 1, idempotent: true, failure: 'client' })).toBe(false);
    expect(
      shouldRetry({ policy: p, attempt: 1, idempotent: true, failure: 'deterministic' }),
    ).toBe(false);
  });

  it('retries a network failure even when not idempotent', () => {
    // The request provably never landed, so replaying it cannot duplicate anything.
    expect(
      shouldRetry({ policy: DEFAULT_RETRY, attempt: 1, idempotent: false, failure: 'network' }),
    ).toBe(true);
  });

  it('refuses to retry an AMBIGUOUS failure on a non-idempotent step', () => {
    // The bug this prevents: a timeout on a POST that actually succeeded, retried, sending twice.
    const p = DEFAULT_RETRY;
    expect(shouldRetry({ policy: p, attempt: 1, idempotent: false, failure: 'timeout' })).toBe(false);
    expect(shouldRetry({ policy: p, attempt: 1, idempotent: false, failure: 'server' })).toBe(false);
    expect(shouldRetry({ policy: p, attempt: 1, idempotent: true, failure: 'timeout' })).toBe(true);
  });

  it('parses Retry-After in both forms', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter(null)).toBe(null);
    expect(parseRetryAfter('')).toBe(null);
    const now = Date.parse('2026-09-28T10:00:00Z');
    expect(parseRetryAfter('Mon, 28 Sep 2026 10:01:00 GMT', now)).toBe(60);
  });

  it('takes the longer of computed and requested delay', () => {
    expect(applyRetryAfter(1000, 60)).toBe(60_000); // server asked for longer
    expect(applyRetryAfter(30_000, 1)).toBe(30_000); // server asked for shorter; keep ours
    expect(applyRetryAfter(1000, null)).toBe(1000);
    expect(applyRetryAfter(1000, 99_999)).toBe(3_600_000); // one-hour ceiling
  });
});

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

const httpStep = (key: string, next?: string | null): Step => ({
  kind: 'http',
  key,
  method: 'GET',
  url: 'https://api.test/x',
  ...(next !== undefined && { next }),
});

describe('graph validation', () => {
  it('accepts a simple valid graph', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [httpStep('a', 'b'), httpStep('b', null)],
    };
    const res = validateGraph(graph);
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
  });

  it('rejects an empty graph', () => {
    const res = validateGraph({ version: 1, entry: 'a', steps: [] });
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe(ERROR_CODES.GRAPH_EMPTY);
  });

  it('rejects a missing entry step', () => {
    const res = validateGraph({ version: 1, entry: 'nope', steps: [httpStep('a', null)] });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === ERROR_CODES.GRAPH_UNKNOWN_STEP)).toBe(true);
  });

  it('rejects duplicate keys', () => {
    const res = validateGraph({
      version: 1,
      entry: 'a',
      steps: [httpStep('a', null), httpStep('a', null)],
    });
    expect(res.errors.some((e) => e.code === ERROR_CODES.GRAPH_DUPLICATE_KEY)).toBe(true);
  });

  it('rejects a dangling next target', () => {
    const res = validateGraph({ version: 1, entry: 'a', steps: [httpStep('a', 'ghost')] });
    expect(res.errors.some((e) => e.code === ERROR_CODES.GRAPH_UNKNOWN_STEP)).toBe(true);
  });

  it('detects a direct self-loop', () => {
    const res = validateGraph({ version: 1, entry: 'a', steps: [httpStep('a', 'a')] });
    expect(res.errors.some((e) => e.code === ERROR_CODES.GRAPH_HAS_CYCLE)).toBe(true);
  });

  it('detects a multi-step cycle', () => {
    const res = validateGraph({
      version: 1,
      entry: 'a',
      steps: [httpStep('a', 'b'), httpStep('b', 'c'), httpStep('c', 'a')],
    });
    const cycle = res.errors.find((e) => e.code === ERROR_CODES.GRAPH_HAS_CYCLE);
    expect(cycle).toBeDefined();
    expect(cycle?.message).toContain('→');
  });

  it('detects a cycle through a branch target', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        httpStep('a', 'check'),
        { kind: 'branch', key: 'check', cases: [{ when: '1 == 1', goto: 'a' }], otherwise: null },
      ],
    };
    expect(validateGraph(graph).errors.some((e) => e.code === ERROR_CODES.GRAPH_HAS_CYCLE)).toBe(
      true,
    );
  });

  it('detects a cycle through an on_error jump', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        { ...httpStep('a', 'b') },
        { ...httpStep('b', null), on_error: { goto: 'a' } },
      ],
    };
    expect(validateGraph(graph).errors.some((e) => e.code === ERROR_CODES.GRAPH_HAS_CYCLE)).toBe(
      true,
    );
  });

  it('allows a diamond (converging paths are not a cycle)', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        {
          kind: 'branch',
          key: 'a',
          cases: [{ when: '1 == 1', goto: 'b' }],
          otherwise: 'c',
        },
        httpStep('b', 'd'),
        httpStep('c', 'd'),
        httpStep('d', null),
      ],
    };
    const res = validateGraph(graph);
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
  });

  it('warns (but does not fail) on an unreachable step', () => {
    const res = validateGraph({
      version: 1,
      entry: 'a',
      steps: [httpStep('a', null), httpStep('orphan', null)],
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.step_key === 'orphan')).toBe(true);
  });

  it('rejects a malformed step key', () => {
    const res = validateGraph({ version: 1, entry: 'A B', steps: [httpStep('A B', null)] });
    expect(res.ok).toBe(false);
  });

  it('rejects a bad expression in a branch', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [{ kind: 'branch', key: 'a', cases: [{ when: '1 +', goto: 'a' }], otherwise: null }],
    };
    expect(
      validateGraph(graph).errors.some((e) => e.code === ERROR_CODES.INVALID_EXPRESSION),
    ).toBe(true);
  });

  it('catches a template referencing a step that does not exist', () => {
    // The check that earns its keep: a typo'd step name is otherwise invisible until 3am.
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        { ...httpStep('a', 'b') },
        {
          kind: 'http',
          key: 'b',
          method: 'POST',
          url: 'https://api.test/{{ steps.typo.output.id }}',
          next: null,
        },
      ],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.message.includes('typo'))).toBe(true);
  });

  it('catches an unknown scope root', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        { kind: 'http', key: 'a', method: 'GET', url: 'https://x.test/{{ bogus.thing }}', next: null },
      ],
    };
    expect(validateGraph(graph).ok).toBe(false);
  });

  it('catches a reference to an unknown secret when the secret list is supplied', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        {
          kind: 'http',
          key: 'a',
          method: 'GET',
          url: 'https://x.test',
          headers: { Authorization: 'Bearer {{ secrets.MISSING }}' },
          next: null,
        },
      ],
    };
    const res = validateGraph(graph, { knownSecrets: new Set(['PRESENT']) });
    expect(res.errors.some((e) => e.code === ERROR_CODES.SECRET_NOT_FOUND)).toBe(true);

    const ok = validateGraph(graph, { knownSecrets: new Set(['MISSING']) });
    expect(ok.errors.some((e) => e.code === ERROR_CODES.SECRET_NOT_FOUND)).toBe(false);
  });

  it('validates per-kind shape', () => {
    const bad: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        { kind: 'email', key: 'a', to: [], subject: '', next: null },
      ],
    };
    expect(validateGraph(bad).ok).toBe(false);

    const badShell: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [{ kind: 'shell', key: 'a', command: [], next: null }],
    };
    expect(validateGraph(badShell).ok).toBe(false);
  });

  it('warns when a branch has no otherwise', () => {
    const graph: TaskGraph = {
      version: 1,
      entry: 'a',
      steps: [
        { kind: 'branch', key: 'a', cases: [{ when: 'true', goto: 'b' }] },
        httpStep('b', null),
      ],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.field === 'otherwise')).toBe(true);
  });
});

describe('graph helpers', () => {
  it('lists outgoing targets from every branch mechanism', () => {
    const step: Step = {
      kind: 'branch',
      key: 'b',
      next: 'n',
      on_error: { goto: 'e' },
      cases: [{ when: 'true', goto: 'c1' }, { when: 'false', goto: 'c2' }],
      otherwise: 'o',
    };
    expect(outgoingTargets(step).sort()).toEqual(['c1', 'c2', 'e', 'n', 'o']);
  });

  it('defaults idempotency by kind, and honours an override', () => {
    // Reads are replayable; writes are not, unless the author says so.
    expect(isIdempotent({ kind: 'http', key: 'a', method: 'GET', url: 'x' })).toBe(true);
    expect(isIdempotent({ kind: 'email', key: 'a', to: ['x@y.z'], subject: 's', text: 't' })).toBe(
      false,
    );
    expect(isIdempotent({ kind: 'shell', key: 'a', command: ['ls'] })).toBe(false);
    expect(
      isIdempotent({ kind: 'shell', key: 'a', command: ['ls'], idempotent: true }),
    ).toBe(true);
  });
});
