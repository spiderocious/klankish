# Deploying Klankish

**Written for:** whoever deploys this, including future you at 2am.

One service. One database. The web app and the API are the same process, because the SPA is an
authenticated internal tool with no SEO need — a separate static host would buy nothing and cost a
CORS configuration, a second domain and a second deploy to keep in sync.

---

## Railway — the short version

1. **New Project → Deploy from GitHub repo.** Railway reads `railway.toml` and builds the
   `Dockerfile`. Nothing else to configure for the build.
2. **Add a Postgres database** to the project (`+ New → Database → PostgreSQL`).
3. **Set the variables below** on the service.
4. Deploy. `preDeployCommand` runs the migrations before the new version takes traffic.
5. **Generate a domain** (Settings → Networking → Generate Domain), then set `APP_URL` and
   `CORS_ORIGINS` to it and redeploy.

The first account you register becomes `super_admin`. Register it immediately after the first
deploy, before anyone else can.

### Required variables

```bash
# Railway provides this automatically once a Postgres plugin is attached.
DATABASE_URL=${{Postgres.DATABASE_URL}}

# Generate each of these separately: openssl rand -base64 48
JWT_SECRET=<48+ random bytes, base64>
JWT_REFRESH_SECRET=<a DIFFERENT 48+ random bytes>
ENCRYPTION_KEY=<32 random bytes, base64>

# Your Railway domain, once generated.
APP_URL=https://klankish-production.up.railway.app
CORS_ORIGINS=https://klankish-production.up.railway.app

NODE_ENV=production
PROCESS_ROLE=all
```

**The server refuses to start in production** if `JWT_SECRET`, `JWT_REFRESH_SECRET` or
`ENCRYPTION_KEY` is still a dev placeholder, or if `CORS_ORIGINS` still contains `localhost`. That
is deliberate: a deploy that boots with a known key is worse than one that fails loudly.

`PORT` is injected by Railway — do not set it.

### Optional variables

```bash
# Email. Without these, email steps fail with `mail_not_configured` rather than
# silently doing nothing.
RESEND_API_KEY=re_...
MAIL_FROM=Klankish <noreply@yourdomain.com>

# Object storage (AWS S3 or Cloudflare R2). Same rule: absent means storage steps
# fail honestly.
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=klankish
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=auto
S3_FORCE_PATH_STYLE=true      # true for R2; false for AWS S3 itself

# Engine tuning
WORKER_CONCURRENCY=4
LEASE_TTL_MS=60000            # must exceed your slowest step, or a live run gets reaped
SCHEDULER_TICK_MS=5000
MAX_CATCHUP_FIRES=1           # after downtime, a daily job fires ONCE, not 288 times
RUN_RETENTION_DAYS=90

# Command execution. OFF by default — see the warning below.
SHELL_STEPS_ENABLED=false
```

---

## ⚠ Before you turn on `SHELL_STEPS_ENABLED`

A hosted, multi-user instance that executes arbitrary commands is a different security posture
from a personal one. The containment is real — argv arrays (no shell, so nothing to inject into),
a binary allow-list, a scrubbed environment, a confined working directory, a hard timeout that
kills the whole process group, and a non-root user — but the honest summary is:

> **Only enable this on an instance where you trust every user with shell access to the container.**

If you do enable it, also set `SHELL_ALLOWED_BINARIES` (e.g. `git,node,curl`) and
`SHELL_WORKSPACE_ROOT`.

---

## Scaling past one service

Nothing here needs a rewrite, because the queue lives in Postgres rather than in the process.

**More throughput, same service:** raise `WORKER_CONCURRENCY`, or `numReplicas` in
`railway.json`. `FOR UPDATE SKIP LOCKED` means replicas never double-claim a run — that is proven
by an integration test with 8 workers racing for 40 runs.

**Separate the worker:** create a second Railway service from the same repo with
`PROCESS_ROLE=worker`, and set the first to `PROCESS_ROLE=api`. Add a third with
`PROCESS_ROLE=scheduler` if you want the scheduler isolated. Every role still binds an HTTP
listener so the platform health check passes — a worker killed because nothing answered on the
port is a confusing outage.

Run **exactly one** scheduler service if you split it out. Several are safe (they take different
rows via `SKIP LOCKED`) but pointless.

---

## Other platforms

The `Dockerfile` is plain — nothing Railway-specific.

```bash
docker build -t klankish .
docker run -p 3000:3000 --env-file .env klankish
```

**Fly.io**: `fly launch --dockerfile Dockerfile`, attach Fly Postgres, set the same variables, and
put the migration command in a `[deploy] release_command`.

**Render / Koyeb / any container host**: point it at the Dockerfile, set the variables, and run
`node apps/api/dist/db/migrate-cli.js` as a pre-deploy step.

**Bare VPS**: `pnpm install && pnpm build && pnpm migrate:prod && pnpm start` behind nginx.

---

## Migrations

Forward-only, plain SQL, one file per change, run as a **separate release step** — never from
application startup, because N replicas booting simultaneously would race each other through the
same DDL.

The runner refuses to proceed if a previously-applied migration's checksum has changed. Editing a
committed migration means two environments silently have different schemas; fix forward with a new
file instead.

```bash
pnpm migrate:prod          # compiled — what production runs
pnpm migrate               # from source — local development
```

---

## Health checks

| Path | Answers | On failure |
|---|---|---|
| `/health` | Is the process alive? Never touches the database. | Restart me. |
| `/ready` | Can I serve? Checks the database. | Stop sending traffic — but do NOT restart. A database blip is not fixed by killing the app, and restart loops make an outage worse. |

Railway's healthcheck is set to `/health` in `railway.toml`, which is the right one: a process
that is alive but cannot reach Postgres should not be restarted in a loop.

---

## What a deploy actually does

1. Build the Docker image (deps → build → runtime; the runtime carries no compiler and no source)
2. `preDeployCommand` runs the migrations against the new schema
3. The new container starts, binds `$PORT`, and answers `/health`
4. Railway switches traffic
5. The old container gets `SIGTERM`; the worker stops claiming, drains in-flight runs for up to
   20s, releases its leases, and exits

**Runs in flight during a deploy are safe either way.** Draining is faster, but an abruptly killed
worker's runs are recovered by the reaper once their lease expires — which is exactly why the
lease exists.

---

## Costs, roughly

| | |
|---|---|
| Railway service | ~$5/mo at the starter tier for an idle-to-light instance |
| Railway Postgres | ~$5/mo at small volumes |
| Resend | free tier covers 3k emails/mo |
| Cloudflare R2 | free tier covers 10GB and has no egress charge |

So roughly **$10/month** for a working instance, less if you self-host Postgres.

---

## Things that will look wrong on a fresh deploy

- **"No runs yet" and `success_rate: —`.** Correct: null is not 0, because "never run" and "always
  fails" must not look alike.
- **Storage/email steps failing with `*_not_configured`.** Correct, and deliberate — an
  unconfigured integration fails honestly rather than pretending to succeed.
- **A `skipped` run with no steps.** The concurrency policy declined it before execution. It is
  RECORDED rather than dropped, so a task that never runs does not look like one that runs fine.
- **`scheduled_for` ≠ `started_at`.** The gap is queue latency, surfaced on purpose: a growing
  value is the earliest sign workers are saturated.
