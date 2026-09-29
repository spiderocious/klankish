# Klankish — Feature Inventory

Legend: **[P1]** built in this pass · **[P2]** built if the pass gets there · **[L]** later, designed
for but not built.

The brief was "go wild — enterprise level, self-deployable, typed, scalable." This list is scoped so
that everything marked P1 is genuinely *finished* rather than half-built, because a half-built
feature is worse than an absent one — it looks like it works.

---

## 1. Identity & access

| # | Feature | Tier |
|---|---|---|
| 1.1 | Email + password registration, argon2id | P1 |
| 1.3 | Login, JWT access (15m) + opaque refresh (30d) | P1 |
| 1.4 | Refresh rotation, single-use; reuse revokes the session family + audit entry | P1 |
| 1.5 | Logout (this session) / logout-all | P1 |
| 1.6 | Password reset by emailed token | P1 |
| 1.7 | Change password (revokes other sessions) | P1 |
| 1.8 | Session list — device, IP, last seen; revoke individually | P1 |
| 1.9 | API keys, scoped, `klk_` prefixed, shown once, revocable | P1 |
| 1.10 | Roles: user / admin / super_admin, strict ladder | P1 |
| 1.11 | Suspend / reactivate user (admin) | P1 |
| 1.12 | Invite user by email (admin) | P2 |
| 1.13 | TOTP 2FA | L |
| 1.14 | OAuth / SSO / SAML | L |

## 2. Tasks

| # | Feature | Tier |
|---|---|---|
| 2.1 | CRUD, cursor-paginated, soft delete | P1 |
| 2.2 | Immutable versioning — every edit writes a new version | P1 |
| 2.3 | Version history + diff view + restore | P1 |
| 2.4 | Status: active / paused / archived | P1 |
| 2.5 | Tags, filter by tag | P1 |
| 2.6 | Graph validation on save: cycles, unknown targets, duplicate keys, orphans | P1 |
| 2.7 | Concurrency policy: skip / queue / allow + max concurrent | P1 |
| 2.8 | Task-level timeout | P1 |
| 2.9 | Manual "run now", optionally with override vars | P1 |
| 2.10 | Dry run — resolve interpolation + branches, execute nothing | P1 |
| 2.11 | Clone a task | P1 |
| 2.12 | Export / import as JSON | P1 |
| 2.13 | Task-level variables | P1 |
| 2.14 | Templates gallery (seeded with honest examples) | P2 |
| 2.15 | Visual drag-and-drop canvas | L (non-goal; see goals.md) |

## 3. Scheduling

| # | Feature | Tier |
|---|---|---|
| 3.1 | Cron expressions, 5-field, timezone-aware (IANA) | P1 |
| 3.2 | Fixed interval | P1 |
| 3.3 | One-shot at a timestamp | P1 |
| 3.4 | Manual only | P1 |
| 3.5 | Inbound webhook trigger (per-task URL + HMAC secret) | P1 |
| 3.6 | Jitter, to de-correlate many tasks on the same cron | P1 |
| 3.7 | Bounded catch-up after downtime (fire once, not 288 times) | P1 |
| 3.8 | Next-5-fires preview in the UI | P1 |
| 3.9 | Pause/resume a schedule independently of the task | P1 |
| 3.10 | DST-correct next-fire (spring gap + autumn duplicate tested) | P1 |
| 3.11 | Calendar/blackout windows ("not on Nigerian public holidays") | L |

## 4. Step kinds

| # | Kind | What it does | Tier |
|---|---|---|---|
| 4.1 | `http` | Method, URL, headers, body, auth via connection; capture rules; SSRF-guarded | P1 |
| 4.2 | `branch` | Evaluate expression → jump to a step; if/else-if/else chain | P1 |
| 4.3 | `transform` | Expression over prior outputs → named vars | P1 |
| 4.4 | `shell` | argv spawn, timeout, output capture, allow-listed, off by default | P1 |
| 4.5 | `delay` | Fixed or expression-computed wait | P1 |
| 4.6 | `email` | Resend; templated subject/body; multiple recipients | P1 |
| 4.7 | `storage_put` | Write a body/artifact to S3/R2, return the key | P1 |
| 4.8 | `storage_get` | Read an object into a var | P1 |
| 4.9 | `webhook` | POST a signed payload to a registered endpoint | P1 |
| 4.10 | `assert` | Expression must hold, else fail with a chosen identity | P1 |
| 4.11 | `noop` | Marker / placeholder | P1 |
| 4.12 | `subtask` | Invoke another task, wait or fire-and-forget; depth-capped | P2 |
| 4.13 | `loop` | Iterate a captured array, bounded; per-item step_runs | P2 |
| 4.14 | `http_poll` | Poll until an expression holds or budget exhausted | P2 |
| 4.15 | `sql` | Query a registered DB connection | L |
| 4.16 | `slack` / `telegram` | Direct integrations (achievable today via `http`) | L |

## 5. Execution

| # | Feature | Tier |
|---|---|---|
| 5.1 | Postgres queue, `FOR UPDATE SKIP LOCKED` | P1 |
| 5.2 | Lease + renewal + reaper for dead workers | P1 |
| 5.3 | Per-step retry: fixed / linear / exponential, full jitter | P1 |
| 5.4 | `Retry-After` honoured on 429/503 | P1 |
| 5.5 | Per-step and per-run timeouts | P1 |
| 5.6 | `on_error`: fail / continue / jump-to-step | P1 |
| 5.7 | Cancel a running run (cooperative, checked between steps) | P1 |
| 5.8 | Retry a failed run (fresh run, linked via `parent_run_id`) | P1 |
| 5.9 | Retry **from** a failed step, reusing prior outputs | P2 |
| 5.10 | Worker concurrency limit | P1 |
| 5.11 | Graceful shutdown: drain, release leases | P1 |
| 5.12 | Per-step `idempotent` flag gating auto-retry | P1 |
| 5.13 | Priority queue | L |

## 6. The record (the point of the product)

| # | Feature | Tier |
|---|---|---|
| 6.1 | Every step's resolved input persisted, secrets redacted | P1 |
| 6.2 | Every step's output, error, timing, attempt persisted | P1 |
| 6.3 | Full HTTP exchange: request + response, headers, status, bytes | P1 |
| 6.4 | Bodies ≤256KB inline; larger spill to object storage with a ref | P1 |
| 6.5 | Branch decisions recorded (`next_step_key` — what it chose and why) | P1 |
| 6.6 | Run list: filter by task, status, trigger, date; cursor-paginated | P1 |
| 6.7 | Run inspector: step timeline, per-step drawer, payload viewer | P1 |
| 6.8 | Live run updates via SSE | P1 |
| 6.9 | Metrics per task: success rate, p50/p95 duration, failure streak | P1 |
| 6.10 | Retention policy: prune runs older than N days, configurable | P1 |
| 6.11 | Export a run as JSON | P1 |
| 6.12 | Copy any step's request as a `curl` command | P1 |
| 6.13 | Structured log lines per step, searchable | P2 |
| 6.14 | Full-text search across payloads (GIN) | L |

## 7. Secrets & connections

| # | Feature | Tier |
|---|---|---|
| 7.1 | AES-256-GCM at rest, per-secret IV + auth tag | P1 |
| 7.2 | Write-only: plaintext never returned by any endpoint, ever | P1 |
| 7.3 | `{{ secrets.NAME }}` resolution at step execution | P1 |
| 7.4 | Redaction on every read path: responses, persisted inputs, logs, errors | P1 |
| 7.5 | Key versioning + rotation (re-encrypt under a new key) | P1 |
| 7.6 | `last_used_at` tracking; warn on unused secrets | P1 |
| 7.7 | Connections: bearer, basic, header, AWS sigv4 | P1 |
| 7.8 | OAuth2 client-credentials with token caching + refresh | P2 |
| 7.9 | External KMS / Vault backend | L |

## 8. Notifications

| # | Feature | Tier |
|---|---|---|
| 8.1 | Transactional outbox — side effects committed with state | P1 |
| 8.2 | Email on run failure (Resend) | P1 |
| 8.3 | Email on recovery (failed → succeeded) | P1 |
| 8.4 | Daily digest email, per-user timezone | P1 |
| 8.5 | Alert rules: N consecutive failures, duration over threshold | P1 |
| 8.6 | In-app notification centre, unread count | P1 |
| 8.7 | Outbound webhooks, HMAC-signed, with retry + backoff | P1 |
| 8.8 | Per-user notification preferences, per channel | P1 |
| 8.9 | Quiet hours | P2 |

## 9. Admin

An admin is a user with elevated permissions — the surface is strictly a superset, never a parallel
implementation.

| # | Feature | Tier |
|---|---|---|
| 9.1 | Overview: users, tasks, runs today, success rate, queue depth | P1 |
| 9.2 | User list: search, filter by role/status; detail with their tasks and runs | P1 |
| 9.3 | Suspend / reactivate; change role (super_admin) | P1 |
| 9.4 | All tasks across all users, read-only + pause | P1 |
| 9.5 | All runs across all users; kill any run | P1 |
| 9.6 | Worker health: id, last heartbeat, in-flight, claimed runs | P1 |
| 9.7 | Queue inspector: depth, oldest queued, stuck leases; force-reap | P1 |
| 9.8 | Audit log: filter by actor, action, subject; append-only | P1 |
| 9.9 | Instance settings: retention, shell enable, rate limits | P1 |
| 9.10 | Outbox / webhook delivery inspector, manual redrive | P1 |

## 10. Platform

| # | Feature | Tier |
|---|---|---|
| 10.1 | Three-field error envelope + severity bands | P1 |
| 10.2 | Message-key registry, no inline response strings | P1 |
| 10.3 | Cursor pagination everywhere (offset banned) | P1 |
| 10.4 | Idempotency keys on mutating POSTs | P1 |
| 10.5 | Token-bucket rate limiting, per-IP and per-user | P1 |
| 10.6 | `X-Request-Id` propagation via AsyncLocalStorage | P1 |
| 10.7 | Structured logging (pino) with PII redaction | P1 |
| 10.8 | `/health` liveness + `/ready` readiness (checks DB) | P1 |
| 10.9 | Prometheus `/metrics` | P1 |
| 10.10 | OpenAPI 3.1 spec generated from TypeBox + Swagger UI | P1 |
| 10.11 | Forward-only SQL migrations, run as a release step | P1 |
| 10.12 | Docker + compose, one-command self-host | P1 |
| 10.13 | `PROCESS_ROLE` switch (all / api / worker / scheduler) | P1 |
| 10.14 | Graceful shutdown | P1 |
| 10.15 | Seed script with honest example tasks | P1 |
| 10.16 | OpenTelemetry tracing | L |

## 11. Frontend

| # | Feature | Tier |
|---|---|---|
| 11.1 | Auth screens: login, register, password reset | P1 |
| 11.2 | Dashboard: recent runs, failing tasks, next fires | P1 |
| 11.3 | Task list: search, tag filter, status, inline pause/run | P1 |
| 11.4 | Task builder: step list, per-kind forms, branch targets, validation | P1 |
| 11.5 | Task detail: schedule, metrics, version history | P1 |
| 11.6 | Run history with filters | P1 |
| 11.7 | **Run inspector**: timeline, step drawer, payload viewer, copy-as-curl | P1 |
| 11.8 | Live run view via SSE | P1 |
| 11.9 | Secrets manager (write-only UX) | P1 |
| 11.10 | Connections manager | P1 |
| 11.11 | API keys | P1 |
| 11.12 | Notification centre | P1 |
| 11.13 | Settings: profile, password, sessions, timezone, notifications, theme | P1 |
| 11.14 | Admin screens (9.1–9.10) | P1 |
| 11.15 | Command palette (⌘K) | P1 |
| 11.16 | Light/dark toggle, persisted, no flash on load | P1 |
| 11.17 | Empty / loading / error states on every screen | P1 |
| 11.18 | Keyboard navigation on the step list | P2 |
