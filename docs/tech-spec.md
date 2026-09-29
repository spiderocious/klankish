# Klankish — Technical Specification

**Written for:** engineers implementing or reviewing this system.
**Status:** authoritative for the initial build. When this doc and the source disagree, the source
wins — but find out *why* they diverged before "fixing" either.

---

## 1. Stack, and why each piece

| Layer | Choice | Reasoning |
|---|---|---|
| Runtime | Node 22 LTS, TS strict | Work is I/O-bound (HTTP + subprocess), not CPU-bound — the event loop is the right model. The expression evaluator for user-authored conditions has mature sandboxing options here. One language across engine, API and client. |
| HTTP | Fastify 5 | Schema-first validation, ~2x Express throughput, native async error propagation, first-class TypeBox/JSON-Schema integration. |
| DB | Postgres 16 | `FOR UPDATE SKIP LOCKED` gives a correct work queue with no extra infrastructure. `jsonb` + GIN covers flexible step config and captured responses. Relational where the domain is relational. |
| Queue | Postgres table | See §5. Deliberately not Redis/BullMQ: the run record must be durable and queryable, and it already lives in Postgres. One less dependency to self-host. |
| Cache/locks | Redis 7 (**optional**) | Distributed rate limiting and advisory locks at >1 replica. Absent → in-process fallbacks. Never the source of truth. |
| Frontend | Vite + React 19 + TS | Stateful builder/inspector UI. No SSR need (authenticated internal tool), so a static SPA served by Fastify = one deployable. |
| Server state | TanStack Query v5 | Per persona: no bare `useEffect + fetch`, ever. |
| Router | React Router 7 (data mode) | Lazy-loaded routes, typed route constants. |
| Styling | Tailwind v4 + CSS custom properties | Tokens as CSS vars (light/dark swap without re-rendering); Tailwind for layout. |
| Live updates | SSE | One-directional server→client. Plain HTTP, self-reconnecting, survives proxies without config. No WS handshake complexity. |
| Migrations | Plain SQL, forward-only | No ORM. Explicit SQL is auditable; the queue query cannot be expressed cleanly in an ORM anyway. |
| DB driver | `pg` (node-postgres) | Parameterised SQL, explicit transactions, no abstraction between us and `SKIP LOCKED`. |
| Tests | Vitest + Testcontainers + Supertest-equivalent | Real Postgres for queue semantics. Mocks cannot reproduce `SKIP LOCKED`. |
| Email | Resend | As specified. Behind a `Mailer` port so it stubs in CI and no-ops when unconfigured. |
| Storage | S3-compatible (AWS S3 / Cloudflare R2) | As specified. One `ObjectStore` port, `@aws-sdk/client-s3` speaks to both. |

### Deliberate divergences from the persona skills

The skills in `dockito/skills/` describe **Express** (`express-validator`, `res.json`,
`ErrorRequestHandler`). This project uses Fastify per instruction. The *doctrine* is preserved and
the *mechanics* adapted. Each divergence, so it reads as a decision:

| Skill says | Here | Why |
|---|---|---|
| `express-validator` at HTTP boundary | TypeBox schemas on the Fastify route + Zod for internal contracts | Fastify validates from JSON Schema natively and compiles it; bolting on express-validator would bypass the framework's own pipeline. Field-error mapping is done in one `setErrorHandler`. |
| `asyncHandler(fn)` wrapper | Not needed | Fastify awaits handler promises and routes rejections to the error handler natively. The *intent* (no unhandled rejection escapes) is met by the framework. `no-floating-promises` still enforced by lint. |
| `res.json()` banned, use `ResponseUtil` | Same rule, `reply` | `ResponseUtil.ok(reply, data)` etc. `reply.send()` in a handler is a review failure, exactly as specified. |
| `app.use(...)` middleware order | Fastify hooks + plugin encapsulation | `onRequest` → `preValidation` → `preHandler`. Order is still load-bearing and still commented. |
| Money as `bigint` kobo | **No money in this product** | There is no money domain here. The `bigint` serialisation machinery in `ResponseUtil` is kept anyway, because `duration_ms` sums and byte counts can exceed `2^53` and the rule "serialise bigint centrally, never at 240 callsites" still applies. |

---

## 2. Repository layout

```
klankish/
├── docs/                          ← this folder, written before any code
├── apps/
│   ├── api/                       ← Fastify server + engine host
│   │   ├── src/
│   │   │   ├── features/          ← feature folders (see §3)
│   │   │   ├── engine/            ← scheduler, worker, step kinds
│   │   │   ├── platform/          ← ResponseUtil, errors, ctx, db, logger
│   │   │   ├── db/migrations/     ← NNNN_name.sql, forward-only
│   │   │   ├── app.ts             ← buildApp() factory
│   │   │   └── server.ts          ← entrypoint, reads PROCESS_ROLE
│   │   └── test/
│   └── web/                       ← Vite React SPA
│       └── src/
│           ├── features/          ← FSD (see §9)
│           ├── shared/
│           └── ui/
├── packages/
│   ├── shared/                    ← task schema, wire types, RBAC, error codes
│   └── expr/                      ← expression parser/evaluator (own package: heavily unit-tested, zero deps)
├── docker-compose.yml
├── Dockerfile                     ← multi-stage, one image, PROCESS_ROLE switch
└── railway.json
```

`apps/` never import from each other. Everything shared goes through `packages/`.

---

## 3. Backend feature anatomy

Per the persona, the unit of work is a feature folder, not a layer:

```
features/<name>/
  <name>.routes.ts       exports register(app) — owns its hook order
  <name>.controller.ts   thin: call service, bail() or ResponseUtil
  <name>.service.ts      business logic, ServiceResult<T>, never sees req/reply
  <name>.repo.ts         SQL only
  <name>.schema.ts       TypeBox (HTTP) + Zod (contract tests)
  <name>.types.ts        wire + row types
  <name>.messages.ts     message keys for this feature
  index.ts               re-exports register
```

Features: `auth`, `users`, `tasks`, `runs`, `secrets`, `connections`, `schedules`, `notifications`,
`webhooks`, `admin`, `health`, `events` (SSE).

### The three layers

```
Route (TypeBox validation, auth hook, rate limit)
  ↓
Controller — checks ServiceResult, calls bail() or ResponseUtil
  ↓
Service — all logic, returns ServiceResult<T>, reads AsyncLocalStorage for actor
  ↓
Repo — parameterised SQL, named columns, no SELECT *
```

Non-negotiable, restated: services never receive the request object; they read the actor from
`requestContext.getStore()`. Services never throw for domain failures.

---

## 4. Data model

ULID primary keys, resource-prefixed, TEXT. `TIMESTAMPTZ` everywhere. `created_at`/`updated_at` on
every table with a `touch_updated_at` trigger.

### Prefixes
`u_` user · `o_` org · `t_` task · `tv_` task_version · `st_` step · `sc_` schedule · `r_` run ·
`sr_` step_run · `sk_` secret · `cn_` connection · `ak_` api_key · `ss_` session · `al_` audit_log ·
`nt_` notification · `wh_` webhook · `af_` artifact · `ex_` http_exchange

### Core tables

```
users              id, email (unique, citext), password_hash (argon2id), name,
                   role (user|admin|super_admin), status (active|suspended|invited),
                   timezone (IANA), last_login_at,
                   deleted_at, is_deleted, created_at, updated_at
                   -- NOTE: no email verification. Dropped by product decision: this is a
                   -- self-hosted tool where accounts are created by the operator or by invite,
                   -- so a verification round-trip adds friction without adding safety.

sessions           id, user_id, refresh_token_hash (sha256), user_agent, ip,
                   expires_at, revoked_at, replaced_by_id, created_at
                   ← refresh-token rotation; reuse of a rotated token revokes the whole family

api_keys           id, user_id, name, key_hash, prefix (shown in UI), scopes jsonb,
                   last_used_at, expires_at, revoked_at, created_at

tasks              id, owner_id, name, slug, description, status (active|paused|archived),
                   current_version_id, concurrency_policy (allow|skip|queue),
                   max_concurrent_runs, timeout_ms, tags text[],
                   deleted_at, is_deleted, created_at, updated_at

task_versions      id, task_id, version int, graph jsonb, created_by, note, created_at
                   ← IMMUTABLE. Editing a task writes a new version. A run pins the version it
                     ran, so the record stays truthful after the task is edited.

schedules          id, task_id, kind (cron|interval|once|manual|webhook),
                   cron_expr, interval_ms, run_at, timezone (IANA),
                   enabled bool, next_fire_at, last_fire_at, jitter_ms, created_at, updated_at

runs               id, task_id, task_version_id, schedule_id (nullable),
                   trigger (schedule|manual|api|webhook|retry|subtask),
                   status (queued|running|succeeded|failed|cancelled|timed_out|skipped),
                   scheduled_for, started_at, finished_at, duration_ms,
                   claimed_by (worker id), claimed_at, lease_expires_at,
                   attempt int, parent_run_id, root_run_id,
                   error_identity, error_message, context jsonb, created_by, created_at

step_runs          id, run_id, step_key, step_kind, idx int, status,
                   started_at, finished_at, duration_ms, attempt,
                   input jsonb (resolved, REDACTED), output jsonb, error jsonb,
                   next_step_key (what the branch decided), created_at

http_exchanges     id, step_run_id, request_method, request_url, request_headers jsonb (REDACTED),
                   request_body_ref, response_status, response_headers jsonb,
                   response_body_ref, response_body_inline jsonb, bytes int, duration_ms, created_at
                   ← bodies ≤256KB inline; larger spill to artifacts and store a ref

artifacts          id, owner_id, run_id, step_run_id, kind, storage_key, bytes,
                   content_type, checksum_sha256, expires_at, created_at

secrets            id, owner_id, name, ciphertext bytea, iv bytea, auth_tag bytea,
                   key_version int, last_used_at, created_at, updated_at
                   ← plaintext NEVER returned by any endpoint, not even to the owner

connections        id, owner_id, name, kind (http_basic|bearer|oauth2|header|aws|smtp),
                   config jsonb (secret fields encrypted), created_at, updated_at

audit_log          id, actor_id, actor_role, action, subject_type, subject_id,
                   before jsonb, after jsonb, ip, user_agent, created_at
                   ← append-only, enforced by trigger

notifications      id, user_id, kind, channel (email|webhook|inapp), subject_type, subject_id,
                   payload jsonb, read_at, created_at

outbox             id, topic, payload jsonb, available_at, attempts, locked_by, locked_at,
                   delivered_at, last_error, created_at
                   ← transactional outbox: side effects (email, webhook) written in the same
                     transaction as the state change, delivered by a worker

webhook_endpoints  id, owner_id, url, secret, events text[], enabled, created_at
webhook_deliveries id, endpoint_id, event, payload jsonb, status, response_status,
                   attempts, next_attempt_at, delivered_at, created_at

idempotency_keys   id, key unique, user_id, endpoint, request_hash,
                   response_status, response_body jsonb, expires_at, created_at

schema_migrations  version, name, applied_at, checksum
```

### Why `task_versions` is immutable

A run must record *what it actually ran*. If a task is edited after a run, and the run points at
the live task, the record retroactively lies. Pinning `task_version_id` per run is the only way the
record stays honest. This is the same reason the ledger in the persona's money guidance is
append-only, applied to task definitions.

### Key indexes

```sql
-- The queue query. Partial index: only rows the claim query can see.
CREATE INDEX idx_runs_claimable ON runs (scheduled_for)
  WHERE status = 'queued';

-- Lease reaper.
CREATE INDEX idx_runs_leased ON runs (lease_expires_at)
  WHERE status = 'running';

-- Scheduler tick.
CREATE INDEX idx_schedules_due ON schedules (next_fire_at)
  WHERE enabled = TRUE;

-- Run history list: equality then range, per persona.
CREATE INDEX idx_runs_task_created ON runs (task_id, created_at DESC);
CREATE INDEX idx_runs_owner_created ON runs (created_by, created_at DESC);
CREATE INDEX idx_step_runs_run ON step_runs (run_id, idx);
CREATE INDEX idx_tasks_owner ON tasks (owner_id) WHERE is_deleted = FALSE;
CREATE INDEX idx_outbox_pending ON outbox (available_at) WHERE delivered_at IS NULL;
```

---

## 5. The queue — correctness under concurrency

This is the part most likely to be subtly wrong, so it is specified exactly.

### Claiming

```sql
UPDATE runs r
SET status = 'running',
    claimed_by = $1,
    claimed_at = now(),
    started_at = COALESCE(r.started_at, now()),
    lease_expires_at = now() + ($2 || ' milliseconds')::interval
WHERE r.id = (
  SELECT id FROM runs
  WHERE status = 'queued' AND scheduled_for <= now()
  ORDER BY scheduled_for, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING r.*;
```

`FOR UPDATE SKIP LOCKED` is what makes this safe: a row locked by another worker's transaction is
skipped rather than waited on. Two workers polling simultaneously get different rows or nothing.
No Redis, no advisory lock, no lease-loop hand-rolling.

### Lease renewal and the reaper

A running step renews its lease every `LEASE_TTL/3`. If a worker dies, the lease expires and the
reaper re-queues:

```sql
UPDATE runs
SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
    lease_expires_at = NULL, attempt = attempt + 1
WHERE status = 'running' AND lease_expires_at < now()
  AND attempt < $1
RETURNING id;
```

Runs past `max_attempts` go to `failed` with identity `lease_expired`.

**Consequence, stated plainly:** delivery is at-least-once, so **every step handler must be
idempotent or explicitly marked unsafe-to-retry.** A `shell` step that is not idempotent is the
user's responsibility; the UI says so at the point of configuration.

### Concurrency policy per task

| Policy | Behaviour when a run is already in flight |
|---|---|
| `skip` (default) | New run is created with status `skipped`. Recorded, not silently dropped. |
| `queue` | Runs serially. Enqueued and picked up when the predecessor finishes. |
| `allow` | Runs in parallel, bounded by `max_concurrent_runs`. |

Enforced in the claim transaction, not the scheduler, so it holds under concurrent claims.

### Scheduler tick

Every `SCHEDULER_TICK_MS` (default 5000), in a transaction:
1. `SELECT ... FROM schedules WHERE enabled AND next_fire_at <= now() FOR UPDATE SKIP LOCKED`
2. For each: `INSERT INTO runs (status='queued', scheduled_for=next_fire_at, ...)`
3. `UPDATE schedules SET last_fire_at = next_fire_at, next_fire_at = <computed next>`

Both the insert and the advance happen in one transaction, so a crash mid-tick cannot double-fire
or skip. Catch-up is bounded: if the instance was down for a day, a schedule fires **once** on
recovery, not 288 times. `MAX_CATCHUP_FIRES=1` by default, configurable.

**DST correctness:** `next_fire_at` is computed in the schedule's IANA timezone, stored UTC. A
daily 02:30 job in `Africa/Lagos` has no DST, but `Europe/London` does — the cron library must be
timezone-aware, not offset-aware. Tested explicitly for a spring-forward gap and an autumn
fall-back duplicate.

---

## 6. The execution engine

### Task graph

```ts
interface TaskGraph {
  readonly version: 1;
  readonly entry: string;                 // step key to start at
  readonly steps: readonly Step[];
  readonly defaults?: { timeout_ms?: number; retry?: RetryPolicy };
}

interface StepBase {
  readonly key: string;                   // unique within task, [a-z0-9_-]+
  readonly name?: string;
  readonly kind: StepKind;
  readonly next?: string | null;          // null = terminal
  readonly on_error?: 'fail' | 'continue' | string;  // string = jump to that step
  readonly retry?: RetryPolicy;
  readonly timeout_ms?: number;
  readonly capture?: readonly CaptureRule[];
  readonly if?: string;                   // expression gate: skip step when falsy
}
```

Step kinds: `http` · `shell` · `branch` · `transform` · `delay` · `email` · `storage_put` ·
`storage_get` · `webhook` · `subtask` · `loop` · `assert` · `noop`.

A graph is a DAG **by validation, not by hope**: on save, the engine walks all `next`/`on_error`/
branch targets and rejects a cycle with `graph_has_cycle`. Reachability is also checked — an
unreachable step is a warning, not an error, since it may be a work in progress.

### Execution
1. Load run + pinned `task_version.graph`.
2. Build a `RunContext`: `{ run, task, actor, vars: Map, steps: Map<key, StepResult> }`.
3. Start at `entry`, execute, persist the `step_run`, resolve `next`, repeat.
4. Resolution order per step: evaluate `if` → interpolate input → execute with timeout → apply
   `capture` → persist → pick next.
5. Terminate on `next: null`, an unrecoverable error, run timeout, or cancellation.

Persisting the `step_run` **before** moving to the next step is what makes a crash mid-run
inspectable. Non-negotiable.

### Interpolation

`{{ ... }}` over a read-only scope:

```
{{ steps.fetch_users.output.body.data[0].id }}
{{ secrets.STRIPE_KEY }}
{{ vars.threshold }}
{{ run.id }} {{ run.attempt }} {{ run.scheduled_for }}
{{ task.name }} {{ now.iso }} {{ now.epoch_ms }}
{{ env.DEPLOY_ENV }}          ← allow-listed env only
```

Interpolation is **string substitution with typed extraction**, not `eval`. A lone `{{ expr }}`
filling a whole value preserves the extracted type (number stays a number); embedded in a larger
string it stringifies. Missing paths are an error by default (`interpolation_unresolved`), not
silent `undefined` — silent undefined in an outbound API call is how you corrupt a downstream
system.

### The expression language (`packages/expr`)

Its own package because it is the highest-risk-per-line code here and gets the densest unit tests.

Hand-written Pratt parser → AST → tree-walking evaluator. **No `eval`, no `new Function`, no
dependency.** Grammar:

```
literals    123  1.5  "str"  true  false  null
paths       steps.x.output.status
operators   == != > >= < <= && || ! + - * / %
            in   contains   matches (regex, anchored + length-capped)
grouping    ( )
functions   len() lower() upper() trim() int() float() bool() json() has()
            now() coalesce() default()
```

Safety properties, all tested:
- No property access to `__proto__`, `constructor`, `prototype` — path segments are validated.
- Regex is length-capped and compiled with a step budget to prevent catastrophic backtracking.
- Evaluation has a node budget; exceeding it is `expression_too_complex`.
- No I/O, no host access. Pure function of `(ast, scope)`.

### Retries

Per-step: `{ max_attempts, backoff: 'fixed'|'linear'|'exponential', base_ms, max_ms, jitter: boolean }`

Exponential with full jitter, which is the variant that actually de-correlates retries:
`delay = random(0, min(max_ms, base_ms * 2^attempt))`

Retryable by default: network errors, timeouts, HTTP 408/429/5xx. Honours `Retry-After`.
Not retryable: 4xx other than 408/429, validation failures, non-zero exits from a step marked
non-idempotent.

### The `shell` step, and its containment

Commands run via `spawn` with an **argv array, never a shell string** — there is no shell to
inject into. Constraints:

- `SHELL_STEPS_ENABLED` must be true (default **false**). Off by default because a hosted
  multi-user instance running arbitrary commands is a different security posture than a personal
  one, and that should be an explicit choice.
- An allow-list of executable basenames (`SHELL_ALLOWED_BINARIES`) when set.
- Hard timeout with `SIGTERM` then `SIGKILL` after a grace period; the whole process group is
  killed so children do not survive.
- stdout/stderr captured with a byte cap (default 1MB, spilled to artifact above it).
- A scrubbed env: only an allow-list plus explicitly-passed secrets.
- Runs as a non-root user in the container.
- `cwd` confined to a configured workspace root; path traversal rejected.

---

## 7. Errors — the three-field envelope

Per the persona, an error does three jobs and each gets its own field.

```json
{
  "error": {
    "reason": "task_not_found",        // BRANCH — stable identity, snake_case, clients switch on this
    "message": "That task does not exist.",  // DISPLAY — resolved from message registry
    "severity": 40,                    // MEASURE — coarse band for dashboards
    "fieldErrors": { "cron_expr": ["Not a valid cron expression."] },  // validation only
    "rejection": "owner_mismatch",     // DIAGNOSTIC — operator-facing, NOT contract, never branch on it
    "request_id": "01HV..."
  }
}
```

Severity bands (numeric, coarse, answer "should this page someone?"):

| Band | Code | Pages? |
|---|---|---|
| body-validation | 10 | no |
| suspicious-validation | 15 | reviewed |
| auth | 20 | no |
| forbidden | 30 | no |
| not-found | 40 | no |
| conflict | 50 | watched |
| business-rule | 60 | no |
| rate-limited | 70 | watched |
| upstream | 80 | **yes** |
| server-fault | 90 | **yes** |

`suspicious-validation` is used here for: referencing another user's secret, a step key that is not
in the graph, a cross-user task id. All are client bugs or probing, not typos.

**Validation policy, decided once:** return **all** invalid fields, in both the Fastify validation
hook and the error handler. The builder form shows every problem at once; showing one at a time in
a multi-step form is hostile.

### Field casing, decided once

- **Payload + envelope: `snake_case`.** Including `next_cursor`, `has_more`, `request_id`.
- One exception, deliberate: keys **inside** a user's captured `output` jsonb are whatever the
  upstream API returned. We do not rewrite a third party's response shape.

Verified by reading the serialiser (`toView` per feature), not this doc.

---

## 8. Auth and RBAC

- Password hashing: **argon2id**, `m=19456 KiB, t=2, p=1` (OWASP 2024 baseline).
- Access token: JWT HS256, 15 min, claims `{ sub, role, sid, jti }`.
- Refresh token: opaque 256-bit random, sha256-hashed at rest, 30 days, **single-use with
  rotation**. Reuse of a rotated token revokes the entire session family and writes an audit entry
  — this is the classic stolen-refresh-token detection and it is tested.
- API keys: `klk_<prefix>_<secret>`, sha256 at rest, shown once at creation, scoped.
- Rate limits: token bucket (not fixed window — fixed window permits a 2x burst across the
  boundary). Per-IP on unauthenticated routes, per-user on authenticated, higher ceiling for admin.
  `429` carries a real `Retry-After`.

RBAC is one function, in `packages/shared`, so it cannot drift:

```ts
const ROLE_RANK = { user: 0, admin: 1, super_admin: 2 } as const;
export const atLeast = (actual: Role, required: Role): boolean =>
  ROLE_RANK[actual] >= ROLE_RANK[required];
```

Ownership: a non-admin sees only rows where `owner_id = actor.id`. Cross-user access is **`403`
forbidden, not `404`** — per the persona's edge-case table. (The information-leak argument for 404
does not apply here: the caller is authenticated, and knowing "some task with this ULID exists" is
not sensitive when ULIDs are unguessable. Consistency with the persona wins.)

---

## 9. Frontend

FSD per the skill. Rules restated because they are enforced in review:

- Icons **only** from `@icons` proxy. Never `lucide-react` directly.
- No bare `useEffect + fetch`. TanStack Query only.
- No `&&` for conditional rendering → `<Show>`. No `.map()` in JSX → `<Repeat>`. Both from
  `meemaw` (the user's own library).
- No inline paths: `ROUTES` for links, `EP` for endpoints.
- No Redux/Zustand. Context + `useState`.
- `cn()` for conditional classes.
- Branch on `error.reason`; display `error.message`. Never render a raw identity to a user.

Screens: login/register/reset · dashboard · tasks list · task builder · task detail · run history ·
**run inspector** · secrets · connections · api keys · notifications · settings · admin (overview,
users, tasks, runs, workers, queue, audit).

### Theming
Light default. Dark via toggle, persisted in `localStorage` (wrapped in try/catch — it throws in
private mode), `data-theme` attribute on `<html>`, `prefers-color-scheme` as the initial guess only
when nothing is stored. Tokens are CSS custom properties so the swap costs no re-render.

---

## 10. Deployment

One image, `PROCESS_ROLE` switch: `all` (default, dev/small), `api`, `worker`, `scheduler`.
In `worker`/`scheduler` mode a minimal health listener still binds, or the platform's TCP
healthcheck fails the deploy — a lesson the persona states explicitly.

Railway: one service + Postgres to start; splitting the worker out later is a config change, not a
rewrite, because the queue is in Postgres.

Migrations run as a **separate release step**, never in app startup — concurrent replicas racing
migrations on boot is a real failure mode.

Graceful shutdown on `SIGTERM`: stop claiming, finish or checkpoint in-flight steps, release
leases, close the pool, exit. A worker killed without releasing leases is still safe (the reaper
covers it) — but releasing is faster.

### Env

```
NODE_ENV  PORT  PROCESS_ROLE  DATABASE_URL  REDIS_URL?
JWT_SECRET (≥32)  JWT_REFRESH_SECRET (≥32)  ENCRYPTION_KEY (32-byte base64)
APP_URL  CORS_ORIGINS
RESEND_API_KEY?  MAIL_FROM?
S3_ENDPOINT?  S3_REGION?  S3_BUCKET?  S3_ACCESS_KEY_ID?  S3_SECRET_ACCESS_KEY?  S3_FORCE_PATH_STYLE?
SHELL_STEPS_ENABLED=false  SHELL_ALLOWED_BINARIES?  SHELL_WORKSPACE_ROOT?
WORKER_CONCURRENCY=4  LEASE_TTL_MS=60000  SCHEDULER_TICK_MS=5000  MAX_CATCHUP_FIRES=1
HTTP_STEP_MAX_BYTES=262144  LOG_LEVEL=info
```

`env.ts` parses with Zod at boot and **fails loudly**. Production-only requirements are asserted in
`server.ts`, not `env.ts`, so dev boots without prod secrets.

**SSRF defence on the `http` step** — it takes user-supplied URLs, so this is required, not
optional: resolve DNS, reject loopback/link-local/private ranges (`127/8`, `10/8`, `172.16/12`,
`192.168/16`, `169.254/16`, `::1`, `fc00::/7`) unless `HTTP_STEP_ALLOW_PRIVATE=true` for
self-hosted internal use. Re-check after redirects (a public host can 302 to `169.254.169.254` to
reach cloud metadata). Redirect count capped.

---

## 11. Testing

Per the persona: **verify the harness exists before claiming a tier.** This project builds it, so
it will exist, and the docs will not claim a tier that has no tests in it.

| Tier | Tool | Covers |
|---|---|---|
| Unit | Vitest | expression parser/evaluator (densest), cron next-fire incl. DST, interpolation, cursor codec, backoff+jitter, redaction, RBAC ladder, graph cycle detection |
| Integration | Vitest + Testcontainers (real PG) | **concurrent claim never double-claims**, lease expiry + reaper, concurrency policies, idempotency replay, refresh-token reuse revocation, audit append-only trigger, soft-delete filtering |
| Contract | Vitest + Zod | every handler's response parses against its schema; casing and cursor names asserted |
| E2E | Vitest + Fastify `inject` | register→login→create task→run→inspect; RBAC matrix; admin actions |
| QA | live server + browser | the screens actually work; handoff docs written |

The concurrency test is the one that matters most: N parallel workers against M queued runs,
asserting each run executed exactly once. That is the invariant the whole design rests on.

---

## 12. Risks, honestly

| Risk | Mitigation |
|---|---|
| `shell` step is a large attack surface on a shared instance | Off by default, allow-list, non-root, scrubbed env, argv-only, confined cwd. Documented as single-tenant-first. |
| `http` step enables SSRF | Private-range blocking with post-redirect re-checks (§10). |
| Response bodies bloat Postgres | 256KB inline cap, spill to object storage, retention job. |
| At-least-once delivery double-executes a non-idempotent step | Documented; per-step `idempotent: boolean`; non-idempotent steps are not auto-retried after an ambiguous failure. |
| A task scheduled every minute that takes 5 minutes | `concurrency_policy` default `skip`, recorded as `skipped` so it is visible rather than silent. |
| Expression language becomes a mini-programming-language by accretion | Grammar frozen in this doc; additions need a written reason. No `eval` ever. |
| Clock skew across replicas | All time from Postgres `now()`, never the app clock, for anything that gates claiming. |
