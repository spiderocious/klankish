# Klankish — Goals

**Written for:** the engineer who picks this up next (including future me). Assumes no prior context.

---

## What this is

Klankish is a **self-hostable task automation engine**. You define a task as an ordered graph of
steps — call an HTTP API, run a shell command, branch on what came back, transform it, email
someone, write a file to object storage — attach a schedule, and the engine runs it, forever,
recording everything.

It is the category that contains cron, Zapier, n8n, Temporal and GitHub Actions, scoped to the
part one engineer actually needs: **scheduled, conditional, observable work against APIs and
commands.**

---

## The one-sentence goal

> Every run leaves a complete, immutable record of exactly what executed, what was sent, what came
> back, and why the engine decided what it decided next.

Everything else in this document is downstream of that sentence.

## Why that sentence and not "it runs tasks on a schedule"

Running things on a schedule is the easy half, and `cron` already does it. The reason people
abandon their own automation is not that it fails to fire — it is that **when it fires and
something is wrong, they cannot find out what happened.** A cron job that emails you its stdout is
not observable; it is a rumour.

So the *record* is the product, and the scheduler is a feature of it. Concretely this means:

- Every step persists its resolved input (post-interpolation, secrets redacted), its output, its
  timing, and its error — before the next step starts.
- A run is replayable and inspectable step by step, months later, without reading logs.
- A failed run tells you which step failed, what the payload actually was, and what the branch
  evaluated to.

If a design decision anywhere trades away the completeness of that record for convenience, the
decision is wrong.

---

## Goals, in priority order

### 1. Correctness under concurrency
Two workers must never execute the same scheduled run. A worker that dies mid-run must not leave
the run wedged in `running` forever. A task that overruns its own schedule must not stampede.

This is the hardest requirement and it is first because getting it wrong is silent. Everything is
built on one mechanism: `SELECT ... FOR UPDATE SKIP LOCKED` in Postgres, plus lease expiry and a
reaper.

### 2. Observability of the record
The run inspector is a first-class screen, not an afterthought. Built in phase 3, before the task
builder, because it is how every later phase gets debugged.

### 3. Multi-user with real isolation
Users own their tasks. Cross-user access returns `403 forbidden`, never `404`. An admin is a user
with elevated permissions — strictly a superset, never a separate surface with its own logic.

### 4. Self-hostable in one command
`docker compose up` gives a working instance. No managed-service dependency is required to run it:
Postgres is the only hard dependency. Resend, S3/R2 and Redis are optional and degrade gracefully
when unconfigured.

### 5. Secrets that never leak
Secrets are AES-256-GCM encrypted at rest, referenced as `{{ secrets.NAME }}`, and redacted on
every read path — API responses, persisted step inputs, logs, and error messages. Redaction is
built in phase 1, not retrofitted, because retrofitting it means auditing every write site.

### 6. Typed end to end
TS strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`. The task
definition schema is shared between server and client from one package, so the builder UI and the
engine cannot disagree about what a step is.

---

## Explicit non-goals

| Not doing | Why |
|---|---|
| Visual drag-and-drop canvas builder | A form-based step list with branch targets covers the real cases at a fraction of the cost. Revisit only if the step count per task genuinely outgrows a list. |
| Arbitrary user-supplied JS in a shared sandbox | A real multi-tenant risk. `transform` uses a restricted expression language. Arbitrary code is a single-tenant-only feature, gated behind a deploy flag. |
| Distributed multi-region execution | One region, N replicas. The queue design does not prevent it later; the ops burden is not worth it now. |
| Replacing CI | Steps can run commands; that does not make this a build system. No artifact caching, no matrix builds. |
| Billing / plans / quotas | Self-hosted and single-org-first. Per-user rate limits exist for safety, not monetisation. |

---

## Who uses it

| Role | What they do | Surface |
|---|---|---|
| **user** | Owns tasks, secrets, connections. Sees only their own runs. | App |
| **admin** | Everything a user can do, plus: sees all users, all tasks, all runs, queue depth, worker health, audit log. Can suspend a user or kill a run. | App + `/admin` |
| **super_admin** | Everything an admin can do, plus: change roles, delete users, rotate the instance encryption key, read the full audit log. | App + `/admin` |

Permissions are a strict ladder — `super_admin ⊃ admin ⊃ user`. There is no permission an admin has
that a super_admin lacks. This is checked in one place (`packages/shared/src/rbac.ts`) so it cannot
drift per endpoint.

---

## Definition of done

The build is done when all of these are true, verified by running them and not by reading the code:

- [ ] `docker compose up` boots a working instance from a clean checkout
- [ ] A task with an `http` step, a `branch`, and a second dependent step runs on a schedule and
      records every step's I/O
- [ ] Two concurrently running workers provably never double-claim a run (integration test)
- [ ] A killed worker's in-flight run is recovered by the reaper and retried
- [ ] A secret referenced in a step never appears in any API response, persisted row, or log line
- [ ] A non-owner gets `403` on another user's task; an admin gets it
- [ ] Light theme by default, dark theme via toggle, persisted per viewer
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` all pass
- [ ] The UI has been driven in a real browser and the screens work

---

## A note on what is deliberately not seeded

The origin of this project was automating a local shell routine that inflates npm download counts
for published packages. The engine here is fully general and its `shell` step will run any command
given to it — that is what a task runner is for.

That specific job is **not** shipped as seed data, an example task, or a fixture, because npm
download counts are a public signal that other people use to judge whether a package is
maintained, and inflating them from a scheduled cloud host misrepresents it at a scale a laptop
does not. Seed data uses honest examples instead: a health check, a digest, a backup.

This is recorded here so the omission reads as a decision rather than an oversight.
