# QA Handoff — Klankish v0.1

**Written for:** whoever tests or picks this up next.
**Date:** 2026-09-29
**Build:** Typecheck ✅ (4 packages) · Unit 220 ✅ · Integration 58 ✅ · Driven in a real browser ✅

---

## Running it

```bash
# 1. Postgres must be reachable. On this machine that is Postgres.app on :5432 —
#    Docker is NOT running here, so there is no compose path verified yet.
createdb klankish_dev   # already exists on this machine
createdb klankish_test  # already exists on this machine

# 2. Env
cp .env.example .env    # .env already exists with generated dev secrets

# 3. Migrate
pnpm migrate

# 4. Run (API + worker + scheduler in one process, PROCESS_ROLE=all)
cd apps/api && npx tsx --env-file=../../.env src/server.ts

# 5. Frontend
cd apps/web && npx vite
```

| Surface | URL |
|---|---|
| API | http://localhost:**3100** |
| Web | http://localhost:5173 |
| OpenAPI / Swagger | http://localhost:3100/docs |
| Liveness | http://localhost:3100/health |
| Readiness (checks DB) | http://localhost:3100/ready |

**Port 3100, not 3000.** Another local app ("Loans Backoffice") holds `[::1]:3000` on this
machine, and IPv6 localhost resolves to it first — so Klankish bound `*:3000` but every request
went to the other app. Moved to 3100 rather than disturbing it.

---

## Test accounts

| Email | Password | Role |
|---|---|---|
| `feranmi@klankish.test` | `correct-horse-battery` | super_admin (first user) |
| `second@klankish.test` | `another-long-password` | user |

**The first user to register becomes `super_admin`.** On a self-hosted instance somebody has to
hold the keys, and requiring a manual DB edit to bootstrap an admin is worse than this, which is
visible and happens exactly once.

---

## What is verified, and how

Not "it compiles" — each of these was run.

### Identity
- [x] Register → first user gets `super_admin`, second gets `user`
- [x] Login, `GET /me` returns the right user with resolved permissions
- [x] **Refresh rotation**: each refresh issues a new token and invalidates the old one
- [x] **Reuse detection**: presenting an already-rotated refresh token revokes the ENTIRE session
      family, logs an audit entry, and returns `token_reused` at severity 15
      (suspicious-validation, so it surfaces on a dashboard rather than blending into auth noise)
- [x] Wrong password and unknown email return the SAME `reason` (`invalid_credentials`); they
      differ only in the operator-facing `rejection` field
- [x] Timing: a missing account still burns argon2-equivalent time, so the endpoint cannot be used
      to enumerate users

### RBAC
- [x] User B listing tasks sees zero of user A's
- [x] User B `GET`ting user A's task → **403 `forbidden`, not 404** (the caller is authenticated
      and ULIDs are unguessable, so a truthful 403 leaks nothing and is far easier to debug)
- [x] User B running user A's task → 403
- [x] Admin with `?all_users=true` sees everything
- [x] An admin can READ and PAUSE another user's task but cannot EDIT it — that is super_admin only

### The engine
- [x] **8 workers racing for 40 queued runs: zero double-claims** (the invariant everything rests on)
- [x] A killed worker's lease expires; the reaper re-queues the run and bumps `attempt`
- [x] A run past its attempt cap fails with `lease_expired` rather than sitting in `running` forever
- [x] Concurrency `skip`: 10 concurrent enqueues → exactly 1 queued, 9 recorded as `skipped`
- [x] Branch takes the right path and records WHICH condition matched
- [x] 503 retried to success (3 attempts); 404 never retried (a client error is deterministic)
- [x] An ambiguous failure (timeout) is NOT retried on a non-idempotent step
- [x] Timeout, cancellation, `on_error: continue`, `on_error: {goto}` all behave
- [x] Strict interpolation: an unresolvable `{{ }}` fails loudly rather than sending `undefined`
- [x] Scheduler fires a due cron, enqueues, and ADVANCES `next_fire_at`
- [x] Bounded catch-up: a schedule 3 hours behind fires once, not 180 times
- [x] Three concurrent schedulers → one run (no duplicates)
- [x] A paused task does not run but its schedule still advances (so resuming does not stampede)

### Secrets
- [x] Encrypted AES-256-GCM at rest — confirmed by reading the raw `ciphertext` column
- [x] No endpoint returns a plaintext; `SecretView` has no value field at all
- [x] A secret is sent to the upstream in full, and appears NOWHERE in the run record —
      including when the upstream echoes it back in a response body (by-value redaction)
- [x] Tampered ciphertext fails to decrypt rather than yielding garbage

### The record
- [x] Every step persists resolved input, output, timing, error, and the branch decision
- [x] Full HTTP exchange captured: method, URL, headers, status, bytes, duration
- [x] Resolved input shows the INTERPOLATED value, not the raw template

### Browser
- [x] Login → dashboard → task list → task detail → run inspector all render with real data
- [x] Built a task through the BUILDER FORM, saved it, ran it, and inspected the record
- [x] Cron preview shows the next 5 fires, computed server-side by the same code the scheduler uses
- [x] Light default; dark via toggle, persisted, no flash on reload
- [x] Accessibility tree is well-formed (labelled controls, landmarks, real `<table>`)

---

## Known gaps — NOT built

Stated plainly rather than left for someone to discover:

| Gap | Status |
|---|---|
| `subtask` step | Declared and validated, but the executor refuses it. Needs depth limiting and cycle detection ACROSS tasks, plus a decision on whether the parent waits — not worth improvising. |
| Resend / S3 credentials | The `email`, `storage_put`, `storage_get` and `webhook` steps ARE implemented. Without `RESEND_API_KEY` / `S3_*` they fail with `mail_not_configured` / `storage_not_configured` rather than pretending to succeed. Tested in both states. |
| Admin screens (`/admin/*`) | Nav links exist; the screens are not built. The API behind them partially is. |
| Settings screen | Nav link exists; screen not built. |
| Notifications, alert rules, digest | Outbox table + repo exist; no delivery worker. |
| SSE live stream | Runs poll every 1–2s instead. Functionally live; not the SSE design in the spec. |
| Idempotency middleware | Table exists; middleware not wired to routes. |
| Prometheus `/metrics` | Not built. |
| API keys UI | Backend auth path works; no screen. |
| Docker / compose | Not verified — no Docker daemon on this machine. |
| Task export/import, version diff/restore UI | API exists; no UI. |

---

## Bugs found during QA (all fixed)

1. **Scheduler/queue deadlock.** `processOneDue` held `FOR UPDATE` on `schedules` then opened a
   SECOND transaction taking `FOR UPDATE` on `tasks`. A concurrent scheduler taking them the other
   way round deadlocked and hung the tick. Found by a test running three schedulers at once. Fixed
   by letting `enqueue` join the caller's transaction — which also makes the run insert and the
   schedule advance atomic.
2. **`describeCron` rendered step expressions positionally** — `*/15 * * * *` became "Every hour at
   :*/15". Found by looking at a real schedule card in the browser.
3. **Boolean query params could never validate.** Ajv ran `coerceTypes: false` globally; query
   strings are always strings. Fixed by splitting the validator compiler — coercion for
   querystring/params, strict for bodies.
4. **`storage_put` was unusable.** Its object key was named `key`, which every step already has as
   its graph identifier. The two collided silently, the step key won, and the object key was
   unreachable. Found by writing the first test for that step. Renamed to `object_key`.

---

## Things that look wrong but are not

- `scheduled_for` ≠ `started_at`. Deliberate: the gap is queue latency, and it is surfaced because
  a growing value is the earliest sign workers are saturated.
- A `skipped` run with no steps. Correct — the concurrency policy declined it before execution, and
  it is RECORDED rather than dropped so the skip is visible.
- `success_rate: null` on a new task. Not 0 — "no runs yet" and "always fails" must not look alike.
- A `curl` copied from the inspector carries `[REDACTED]`, not the real secret. Correct: a curl
  line with a live credential is one paste away from a chat log.
