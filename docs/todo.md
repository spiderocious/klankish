# Klankish — Build Order

Sequenced so that each phase is independently verifiable and the next phase can be debugged with
what the previous one built. Checked off as they land.

**Rule for this build:** a phase is done when it runs, not when it compiles.

---

## Phase 0 — Docs
- [x] goals.md
- [x] tech-spec.md
- [x] design-guide.md
- [x] features.md
- [x] ideas.md
- [x] todo.md

## Phase 1 — Skeleton  ✅ (typecheck clean · 179 unit tests green)
- [x] pnpm workspace, `.npmrc` (`minimum-release-age=10080`)
- [x] `packages/shared`: error codes, message keys, RBAC, task-graph types, wire types
- [x] `packages/expr`: parser + evaluator + dense unit tests
- [x] `apps/api`: Fastify, env parsing, pino, `buildApp()`
- [x] Platform: `ResponseUtil`, `AppError`, `ServiceResult`, `bail`, request context, error handler
- [x] DB pool, migration runner, `0001_init.sql`
- [x] `/health`, `/ready`
- [x] tsconfig strict everywhere, eslint, prettier
- [ ] Dockerfile, docker-compose, railway.json

## Phase 2 — Identity  ✅ (verified live: rotation, reuse-revocation, RBAC, audit)
- [x] users + sessions + api_keys migrations
- [x] argon2id hashing, JWT issue/verify
- [x] register, login, refresh (rotating), logout, logout-all
- [x] password reset + change
- [x] auth hooks: `requireAuth`, `requireRole`, `requireOwnerOrAdmin`
- [x] rate limiter (token bucket), idempotency middleware
- [x] sessions list + revoke; api keys CRUD
- [x] audit log + append-only trigger

## Phase 3 — Tasks & the record schema  ✅
- [x] tasks, task_versions, schedules, runs, step_runs, http_exchanges migrations
- [x] graph validation (cycles, unknown targets, dup keys)
- [x] task CRUD + versioning + clone + export/import
- [x] schedule CRUD, cron parsing, next-fire (timezone-aware), next-5 preview
- [x] runs read API: list (cursor), detail, step detail
- [ ] contract tests for everything above

## Phase 4 — Engine  ✅ (54 integration tests · found + fixed a real deadlock)
- [x] queue: claim (`SKIP LOCKED`), lease renewal, reaper
- [x] scheduler tick, bounded catch-up, concurrency policies
- [x] DAG executor + RunContext
- [x] interpolation + capture rules
- [x] retries with full jitter, timeouts, cancellation
- [x] step kinds: `noop`, `http`, `branch`, `transform`, `assert`, `delay`, `shell`
- [x] **integration test: N workers × M runs, each executed exactly once**
- [x] integration test: killed worker recovered by reaper
- [x] worker heartbeat table + graceful shutdown

## Phase 5 — Secrets, storage, mail  ✅ (ports + drivers; degrade honestly when unconfigured)
- [x] AES-256-GCM secret service, key versioning, rotation
- [x] redaction helper + its unit tests; applied to responses, persisted inputs, logs
- [x] connections CRUD (bearer/basic/header/aws)
- [x] `ObjectStore` port + S3/R2 driver; artifacts; body spill-over
- [x] `Mailer` port + Resend driver + templates
- [ ] outbox table + delivery worker
- [x] step kinds: `email`, `storage_put`, `storage_get`, `webhook`
- [ ] alert rules, digest job, in-app notifications

## Phase 6 — Admin & platform polish
- [ ] admin overview, users, tasks, runs, workers, queue, audit, outbox
- [ ] instance settings
- [ ] Prometheus `/metrics`
- [x] OpenAPI + Swagger UI
- [ ] retention / prune job
- [ ] SSE `/events` stream
- [ ] seed script (honest examples)

## Phase 7 — Frontend foundation  ✅
- [x] Vite + React 19 + TS strict + Tailwind v4
- [x] `_foundation.css` tokens, light + derived dark, no-flash theme script
- [ ] primitives: Button, Field, Input, Select, Pill, Flag, Sheet, Table, Modal, Toast, Drawer,
      Tabs, Spinner, EmptyState, RecordId, Readout, CodeBlock, JsonViewer
- [x] app shell: sidebar, topbar, ⌘K palette, theme toggle
- [x] api client (typed, envelope-aware, error-identity branching), TanStack Query setup
- [x] `ROUTES` + `EP` constants, `@icons` proxy, `cn()`
- [x] auth screens + guards

## Phase 8 — Frontend app  ✅ (core screens; admin + settings deferred — see qa-handoff.md)
- [x] dashboard
- [x] task list
- [x] task builder (per-kind step forms, branch targets, live validation)
- [x] task detail (schedule, metrics, version history + diff)
- [x] run history
- [x] **run inspector** (timeline, step drawer, payload viewer, copy-as-curl)
- [ ] live run via SSE
- [x] secrets, connections, api keys
- [ ] notifications, settings
- [ ] admin screens
- [ ] empty/loading/error on every screen

## Phase 9 — Verify  ✅ (278 tests · driven in a real browser · 4 real bugs found and fixed)
- [x] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [x] `pnpm test` green
- [x] `pnpm test:integration` green (real Postgres)
- [x] boot the stack, exercise the API end to end
- [x] drive the UI in a browser; check both themes
- [ ] seam audit: casing, cursor names, nullables, error identities
- [x] RBAC matrix walked by hand
- [x] QA handoff docs + known-bugs.md
