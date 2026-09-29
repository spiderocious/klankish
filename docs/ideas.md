# Klankish — Ideas & Open Questions

Not commitments. A place for things considered, so a later reader knows they were considered rather
than missed.

---

## Ideas worth building next

**Run diff.** Two runs of the same task side by side, step by step, highlighting where the outputs
diverged. This is the natural next feature after the inspector, and it is what you actually want at
3am when "it worked yesterday."

**Assertions as first-class monitors.** An `assert` step already exists. If a task is *only*
assertions, it is a monitor — and the product could present it as one: uptime history, an incident
timeline, a status page. This is a genuinely different product surface reachable with almost no new
engine work.

**Step library.** Users re-configure the same HTTP call repeatedly. A saved, parameterised step
usable across tasks. The versioning model already supports it; the UI does not.

**Backfill.** "Run this task once for every day between X and Y, with `{{ run.scheduled_for }}` set
to that day." Standard in data orchestration (Airflow calls it backfill) and cheap here because
`scheduled_for` is already a column rather than an implicit `now()`.

**Cost / quota accounting.** Count outbound HTTP calls, bytes stored, emails sent per user per month.
Not for billing — for spotting the task that quietly makes 400k calls.

**A real CLI.** `klankish run <task>`, `klankish logs <run>`, `klankish import task.json`. The API
is already complete enough; this is a thin client. It would make the product usable from the place
tasks are usually born: a terminal.

**Terraform / declarative provider.** Tasks as code in a repo, applied to an instance. The
export/import JSON is already the data model for this.

---

## Ideas deliberately rejected

**Arbitrary JS steps in a shared runtime.** Tempting, and it would collapse `transform`, `branch` and
`assert` into one step. Rejected while multi-tenant: `isolated-vm` or QuickJS is a real sandbox but
a real ongoing security commitment, and a scheduler that runs arbitrary code for multiple users is a
different threat model than one that evaluates a restricted expression grammar. Revisit only as a
single-tenant, deploy-flag feature.

**An LLM step.** Obvious given the surrounding work, and genuinely useful ("summarise this response,
decide whether to page someone"). Held back only because non-determinism inside a scheduled
automation is a debugging hazard, and the record-keeping story needs thought first: you would want
the prompt, the model id, the temperature and the full completion all in the step record, or the run
is no longer reproducible. Worth doing properly later, not bolted on.

**Multi-region execution.** The queue design does not prevent it. The ops burden is not justified for
a self-hosted single-instance product.

**Replacing the expression language with JSONata or JMESPath.** Both are more capable. Both are also
a dependency with a much larger grammar to sandbox and to teach. A 300-line hand-written parser that
does exactly what is documented is easier to reason about, and it is the thing most likely to be
attacked.

---

## Open questions

**Should a run pin its secrets' values?** Currently a run resolves secrets at execution time. If a
secret rotates between two runs, the record shows `[REDACTED]` for both and cannot distinguish
which value was used. Recording a key *version* per step_run would fix it without storing plaintext.
Leaning: yes, add `secret_versions_used jsonb`. Not P1.

**Is `403` on cross-user access right?** The persona's edge-case table says `403 forbidden`, not
`404`, for cross-tenant access, and this build follows it. The counter-argument is that it confirms a
resource exists. With unguessable ULIDs and an authenticated caller, that leak is negligible — but
it is a real trade-off and it is written down here rather than being silently inherited.

**How long should artifacts live?** Run rows are pruned on a retention policy, but an artifact in
S3/R2 costs money indefinitely. Currently: artifacts expire with their run. Open question whether a
user should be able to pin one.

**Does `queue` concurrency policy need a bound?** A task that always overruns its schedule under
`queue` grows an unbounded backlog. There is a `max_queued` guard but the right default is unclear —
too low silently drops work, too high hides a broken task. Currently 10, and it is recorded as
`skipped` with a reason when exceeded, so at least it is visible.

**Timezone for the digest.** Sent per-user-timezone, which means the digest job fires hourly and
picks the users whose local time is 08:00. Correct but slightly surprising in the run history (24
runs a day for one logical job). Alternative is one job per distinct timezone. Left as-is; noted
because it will look like a bug to whoever sees it first.

---

## Bugs found by testing (kept as a record)

Three real defects surfaced while verifying, not while writing. Recorded because each one is the
kind that would otherwise have shipped and been found at 3am.

**Scheduler/queue deadlock.** `processOneDue` held a transaction with `FOR UPDATE` on `schedules`
and then called `queue.enqueue`, which opened a SECOND transaction taking `FOR UPDATE` on `tasks`.
A concurrent scheduler taking those locks in the other order deadlocked, and the tick hung forever.
Found by a test that runs three schedulers concurrently. Fixed by making `enqueue` accept the
caller's client and join the existing transaction — which also makes the run and the schedule
advance atomic, so a crash between them can no longer double-fire.

**`describeCron` rendered step expressions positionally.** `*/15 * * * *` came out as
"Every hour at :*/15". Found by looking at a real task's schedule card in the browser. A step
expression describes a FREQUENCY and needs its own phrasing; there is now a test asserting that no
description ever contains a raw `*` or `/`.

**Query params could not be booleans.** Ajv ran with `coerceTypes: false` globally, which is right
for request bodies (silent coercion hides a client type error) and impossible for query strings,
where everything arrives as a string. `?all_users=true` failed validation with "Must be boolean".
Fixed by splitting the validator compiler: coercion for querystring/params, strict for bodies.

---

## Things that will look wrong but are not

Recorded because each one will otherwise cost the next engineer an hour.

- **`task_versions` grows forever.** By design. A run pins a version; deleting versions retroactively
  falsifies the record. Pruning follows run retention, not its own policy.
- **`runs.scheduled_for` differs from `started_at`.** Deliberate. The first is when it was *due*, the
  second when a worker *picked it up*. The gap is queue latency, and it is a metric worth seeing.
- **A `skipped` run with no step_runs.** Correct. Concurrency policy rejected it before execution.
  It is recorded rather than dropped precisely so the skip is visible.
- **The digest job appears 24× daily in run history.** See the open question above.
- **`prefers-color-scheme` is mostly ignored.** Light is the stated default; the OS preference is
  consulted only when nothing is stored. This is a product decision, not a bug.
- **Mixed casing inside captured outputs.** Payload and envelope are `snake_case`, but keys inside a
  captured third-party response are whatever that API returned. We do not rewrite someone else's
  response shape. Stated in tech-spec.md §7.
