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

## Phase 3 — Tasks & the record schema
- [ ] tasks, task_versions, schedules, runs, step_runs, http_exchanges migrations
- [ ] graph validation (cycles, unknown targets, dup keys)
- [ ] task CRUD + versioning + clone + export/import
- [ ] schedule CRUD, cron parsing, next-fire (timezone-aware), next-5 preview
- [ ] runs read API: list (cursor), detail, step detail
- [ ] contract tests for everything above

## Phase 4 — Engine
- [ ] queue: claim (`SKIP LOCKED`), lease renewal, reaper
- [ ] scheduler tick, bounded catch-up, concurrency policies
- [ ] DAG executor + RunContext
- [ ] interpolation + capture rules
- [ ] retries with full jitter, timeouts, cancellation
- [ ] step kinds: `noop`, `http`, `branch`, `transform`, `assert`, `delay`, `shell`
- [ ] **integration test: N workers × M runs, each executed exactly once**
- [ ] integration test: killed worker recovered by reaper
- [ ] worker heartbeat table + graceful shutdown

## Phase 5 — Secrets, storage, mail
- [ ] AES-256-GCM secret service, key versioning, rotation
- [ ] redaction helper + its unit tests; applied to responses, persisted inputs, logs
- [ ] connections CRUD (bearer/basic/header/aws)
- [ ] `ObjectStore` port + S3/R2 driver; artifacts; body spill-over
- [ ] `Mailer` port + Resend driver + templates
- [ ] outbox table + delivery worker
- [ ] step kinds: `email`, `storage_put`, `storage_get`, `webhook`
- [ ] alert rules, digest job, in-app notifications

## Phase 6 — Admin & platform polish
- [ ] admin overview, users, tasks, runs, workers, queue, audit, outbox
- [ ] instance settings
- [ ] Prometheus `/metrics`
- [ ] OpenAPI + Swagger UI
- [ ] retention / prune job
- [ ] SSE `/events` stream
- [ ] seed script (honest examples)

## Phase 7 — Frontend foundation
- [ ] Vite + React 19 + TS strict + Tailwind v4
- [ ] `_foundation.css` tokens, light + derived dark, no-flash theme script
- [ ] primitives: Button, Field, Input, Select, Pill, Flag, Sheet, Table, Modal, Toast, Drawer,
      Tabs, Spinner, EmptyState, RecordId, Readout, CodeBlock, JsonViewer
- [ ] app shell: sidebar, topbar, ⌘K palette, theme toggle
- [ ] api client (typed, envelope-aware, error-identity branching), TanStack Query setup
- [ ] `ROUTES` + `EP` constants, `@icons` proxy, `cn()`
- [ ] auth screens + guards

## Phase 8 — Frontend app
- [ ] dashboard
- [ ] task list
- [ ] task builder (per-kind step forms, branch targets, live validation)
- [ ] task detail (schedule, metrics, version history + diff)
- [ ] run history
- [ ] **run inspector** (timeline, step drawer, payload viewer, copy-as-curl)
- [ ] live run via SSE
- [ ] secrets, connections, api keys
- [ ] notifications, settings
- [ ] admin screens
- [ ] empty/loading/error on every screen

## Phase 9 — Verify
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` green
- [ ] `pnpm test:integration` green (real Postgres)
- [ ] boot the stack, exercise the API end to end
- [ ] drive the UI in a browser; check both themes
- [ ] seam audit: casing, cursor names, nullables, error identities
- [ ] RBAC matrix walked by hand
- [ ] QA handoff docs + known-bugs.md
