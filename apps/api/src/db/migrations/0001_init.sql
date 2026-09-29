-- ============================================================================
-- 0001_init — identity, tasks, the record, and the queue.
--
-- Conventions, applied uniformly:
--   * IDs are TEXT ULIDs with a resource prefix (u_, t_, r_…). Never UUID, never a sequence:
--     ULIDs sort chronologically, so `ORDER BY id` is `ORDER BY created_at` for free.
--   * Every timestamp is TIMESTAMPTZ. The app never stores local time.
--   * Every table has created_at; mutable tables also have updated_at with a touch trigger.
--   * Flexible-but-queryable data is jsonb. Skeleton stays relational.
--   * No SELECT * anywhere in app code, so column order here is for humans, not machines.
-- ============================================================================

-- citext gives case-insensitive email uniqueness without LOWER() on every lookup.
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest.
-- Doing this in the DB rather than the app means it cannot be forgotten at a callsite.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TYPE user_role   AS ENUM ('user', 'admin', 'super_admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'invited');

CREATE TABLE users (
  id            TEXT        PRIMARY KEY,
  email         CITEXT      NOT NULL,
  password_hash TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  role          user_role   NOT NULL DEFAULT 'user',
  status        user_status NOT NULL DEFAULT 'active',
  timezone      TEXT        NOT NULL DEFAULT 'UTC',
  last_login_at TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  is_deleted    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index rather than a plain UNIQUE: a soft-deleted user must not hold their email
-- hostage forever, but two live accounts may never share one.
CREATE UNIQUE INDEX idx_users_email_active ON users (email) WHERE is_deleted = FALSE;
CREATE INDEX idx_users_role   ON users (role)   WHERE is_deleted = FALSE;
CREATE INDEX idx_users_status ON users (status) WHERE is_deleted = FALSE;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- sessions — refresh tokens, rotating and single-use
--
-- `replaced_by_id` forms a chain. Presenting a token that has already been replaced means it
-- leaked, so the whole family is revoked. That detection is the reason this is a table rather
-- than a stateless JWT.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                 TEXT        PRIMARY KEY,
  user_id            TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT        NOT NULL UNIQUE,
  user_agent         TEXT,
  ip                 TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  replaced_by_id     TEXT        REFERENCES sessions(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user    ON sessions (user_id, created_at DESC);
CREATE INDEX idx_sessions_expires ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- password_reset_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_user ON password_reset_tokens (user_id);

-- ---------------------------------------------------------------------------
-- api_keys
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id           TEXT        PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  key_hash     TEXT        NOT NULL UNIQUE,
  prefix       TEXT        NOT NULL,          -- the shown portion, e.g. klk_a1b2c3
  scopes       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_user ON api_keys (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- secrets — AES-256-GCM at rest
--
-- iv and auth_tag are stored per row. key_version lets rotation re-encrypt progressively rather
-- than in one transaction over the whole table.
-- ---------------------------------------------------------------------------
CREATE TABLE secrets (
  id           TEXT        PRIMARY KEY,
  owner_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  ciphertext   BYTEA       NOT NULL,
  iv           BYTEA       NOT NULL,
  auth_tag     BYTEA       NOT NULL,
  key_version  INTEGER     NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT secrets_name_per_owner UNIQUE (owner_id, name),
  -- Secret names are referenced as {{ secrets.NAME }}, so the charset must match what the
  -- expression lexer accepts as an identifier. Enforced here so a bad name cannot be stored.
  CONSTRAINT secrets_name_format CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$')
);

CREATE TRIGGER secrets_touch BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- connections — reusable auth for http steps
-- ---------------------------------------------------------------------------
CREATE TABLE connections (
  id         TEXT        PRIMARY KEY,
  owner_id   TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  kind       TEXT        NOT NULL,
  config     JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- secret fields hold secret REFERENCES
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT connections_name_per_owner UNIQUE (owner_id, name)
);

CREATE TRIGGER connections_touch BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
CREATE TYPE task_status        AS ENUM ('active', 'paused', 'archived');
CREATE TYPE concurrency_policy AS ENUM ('skip', 'queue', 'allow');

CREATE TABLE tasks (
  id                  TEXT               PRIMARY KEY,
  owner_id            TEXT               NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT               NOT NULL,
  slug                TEXT               NOT NULL,
  description         TEXT,
  status              task_status        NOT NULL DEFAULT 'active',
  current_version_id  TEXT,               -- FK added after task_versions exists (circular)
  concurrency_policy  concurrency_policy NOT NULL DEFAULT 'skip',
  max_concurrent_runs INTEGER            NOT NULL DEFAULT 1 CHECK (max_concurrent_runs BETWEEN 1 AND 50),
  max_queued          INTEGER            NOT NULL DEFAULT 10 CHECK (max_queued BETWEEN 1 AND 1000),
  timeout_ms          INTEGER            CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 86400000),
  tags                TEXT[]             NOT NULL DEFAULT '{}',
  deleted_at          TIMESTAMPTZ,
  is_deleted          BOOLEAN            NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ        NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_tasks_slug_per_owner ON tasks (owner_id, slug) WHERE is_deleted = FALSE;
CREATE INDEX idx_tasks_owner   ON tasks (owner_id, created_at DESC) WHERE is_deleted = FALSE;
CREATE INDEX idx_tasks_status  ON tasks (status) WHERE is_deleted = FALSE;
CREATE INDEX idx_tasks_tags    ON tasks USING GIN (tags);

CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- task_versions — IMMUTABLE
--
-- Editing a task writes a new version; a run pins the version it executed. Without this, editing
-- a task retroactively falsifies every historical run record, because the record would point at
-- a definition that no longer describes what ran.
-- ---------------------------------------------------------------------------
CREATE TABLE task_versions (
  id         TEXT        PRIMARY KEY,
  task_id    TEXT        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version    INTEGER     NOT NULL,
  graph      JSONB       NOT NULL,
  note       TEXT,
  created_by TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_versions_unique UNIQUE (task_id, version)
);

CREATE INDEX idx_task_versions_task ON task_versions (task_id, version DESC);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES task_versions(id) ON DELETE SET NULL;

-- Enforce immutability in the DB, not by convention. An UPDATE here is always a bug.
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER task_versions_immutable
  BEFORE UPDATE OR DELETE ON task_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- schedules
-- ---------------------------------------------------------------------------
CREATE TYPE schedule_kind AS ENUM ('cron', 'interval', 'once', 'manual', 'webhook');

CREATE TABLE schedules (
  id            TEXT          PRIMARY KEY,
  task_id       TEXT          NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind          schedule_kind NOT NULL,
  cron_expr     TEXT,
  interval_ms   BIGINT        CHECK (interval_ms IS NULL OR interval_ms >= 60000),
  run_at        TIMESTAMPTZ,
  timezone      TEXT          NOT NULL DEFAULT 'UTC',
  enabled       BOOLEAN       NOT NULL DEFAULT TRUE,
  jitter_ms     INTEGER       NOT NULL DEFAULT 0 CHECK (jitter_ms >= 0 AND jitter_ms <= 3600000),
  next_fire_at  TIMESTAMPTZ,
  last_fire_at  TIMESTAMPTZ,
  webhook_secret TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- One schedule per task keeps "when does this run" answerable without a join returning N rows.
  CONSTRAINT schedules_one_per_task UNIQUE (task_id),
  -- Each kind requires its own field. Checking here means a malformed schedule cannot be stored
  -- even if a service forgets to validate.
  CONSTRAINT schedules_kind_fields CHECK (
    (kind = 'cron'     AND cron_expr IS NOT NULL) OR
    (kind = 'interval' AND interval_ms IS NOT NULL) OR
    (kind = 'once'     AND run_at IS NOT NULL) OR
    (kind IN ('manual', 'webhook'))
  )
);

-- The scheduler's hot query. Partial: only enabled schedules can ever fire.
CREATE INDEX idx_schedules_due ON schedules (next_fire_at)
  WHERE enabled = TRUE AND next_fire_at IS NOT NULL;

CREATE TRIGGER schedules_touch BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- runs — the queue AND the record
-- ---------------------------------------------------------------------------
CREATE TYPE run_status  AS ENUM
  ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'skipped');
CREATE TYPE run_trigger AS ENUM
  ('schedule', 'manual', 'api', 'webhook', 'retry', 'subtask');

CREATE TABLE runs (
  id               TEXT        PRIMARY KEY,
  task_id          TEXT        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_version_id  TEXT        NOT NULL REFERENCES task_versions(id) ON DELETE RESTRICT,
  schedule_id      TEXT        REFERENCES schedules(id) ON DELETE SET NULL,
  trigger          run_trigger NOT NULL,
  status           run_status  NOT NULL DEFAULT 'queued',

  -- scheduled_for is when it was DUE; started_at is when a worker picked it up. The gap is queue
  -- latency, which is the earliest signal that workers are saturated — so they stay separate.
  scheduled_for    TIMESTAMPTZ NOT NULL,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  duration_ms      INTEGER,

  -- Lease fields. A worker holds a run for lease_expires_at; the reaper re-queues expired ones.
  claimed_by       TEXT,
  claimed_at       TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,

  attempt          INTEGER     NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  parent_run_id    TEXT        REFERENCES runs(id) ON DELETE SET NULL,
  root_run_id      TEXT,
  cancel_requested BOOLEAN     NOT NULL DEFAULT FALSE,

  error_identity   TEXT,
  error_message    TEXT,
  vars             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by       TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE queue index. Partial so it holds only claimable rows: on an instance with a million
-- historical runs and twelve queued, this index has twelve entries.
CREATE INDEX idx_runs_claimable ON runs (scheduled_for, created_at)
  WHERE status = 'queued';

-- The reaper's index — likewise only the rows it can act on.
CREATE INDEX idx_runs_leased ON runs (lease_expires_at)
  WHERE status = 'running';

-- History queries: equality first, range last.
CREATE INDEX idx_runs_task_created  ON runs (task_id, created_at DESC);
CREATE INDEX idx_runs_owner_created ON runs (created_by, created_at DESC);
CREATE INDEX idx_runs_status        ON runs (status, created_at DESC);
CREATE INDEX idx_runs_parent        ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

-- Concurrency policy checks ask "is a run of this task in flight?" constantly.
CREATE INDEX idx_runs_task_active ON runs (task_id)
  WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- step_runs — one row per executed step. THIS IS THE RECORD.
-- ---------------------------------------------------------------------------
CREATE TYPE step_run_status AS ENUM
  ('pending', 'running', 'succeeded', 'failed', 'skipped', 'timed_out');

CREATE TABLE step_runs (
  id            TEXT            PRIMARY KEY,
  run_id        TEXT            NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx           INTEGER         NOT NULL,      -- execution order within the run
  step_key      TEXT            NOT NULL,
  step_name     TEXT,
  step_kind     TEXT            NOT NULL,
  status        step_run_status NOT NULL DEFAULT 'pending',
  attempt       INTEGER         NOT NULL DEFAULT 1,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER,

  -- Resolved input AFTER interpolation and WITH secrets redacted. Never the raw config: the raw
  -- config is in the task version, and this column must be safe to show to anyone who can read
  -- the run.
  input         JSONB,
  output        JSONB,
  error         JSONB,

  -- What a branch decided. Recording the decision, not just the outcome, is what makes a branch
  -- debuggable after the fact.
  next_step_key TEXT,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT step_runs_idx_unique UNIQUE (run_id, idx)
);

CREATE INDEX idx_step_runs_run    ON step_runs (run_id, idx);
CREATE INDEX idx_step_runs_failed ON step_runs (run_id) WHERE status = 'failed';

-- ---------------------------------------------------------------------------
-- http_exchanges — the full request/response for an http step
-- ---------------------------------------------------------------------------
CREATE TABLE http_exchanges (
  id                   TEXT        PRIMARY KEY,
  step_run_id          TEXT        NOT NULL REFERENCES step_runs(id) ON DELETE CASCADE,
  request_method       TEXT        NOT NULL,
  request_url          TEXT        NOT NULL,     -- redacted
  request_headers      JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- redacted
  request_body         JSONB,
  response_status      INTEGER,
  response_headers     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Bodies up to HTTP_STEP_MAX_BYTES live inline; larger ones spill to object storage and only
  -- the key is kept, so a 40MB response cannot bloat the database.
  response_body_inline JSONB,
  response_body_ref    TEXT,
  bytes                INTEGER     NOT NULL DEFAULT 0,
  truncated            BOOLEAN     NOT NULL DEFAULT FALSE,
  duration_ms          INTEGER     NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_http_exchanges_step ON http_exchanges (step_run_id);

-- ---------------------------------------------------------------------------
-- artifacts — object-storage pointers
-- ---------------------------------------------------------------------------
CREATE TABLE artifacts (
  id              TEXT        PRIMARY KEY,
  owner_id        TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id          TEXT        REFERENCES runs(id) ON DELETE CASCADE,
  step_run_id     TEXT        REFERENCES step_runs(id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL,
  storage_key     TEXT        NOT NULL,
  bytes           BIGINT      NOT NULL DEFAULT 0,
  content_type    TEXT,
  checksum_sha256 TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_run     ON artifacts (run_id);
CREATE INDEX idx_artifacts_owner   ON artifacts (owner_id, created_at DESC);
CREATE INDEX idx_artifacts_expires ON artifacts (expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- workers — heartbeat registry, for admin visibility and the reaper
-- ---------------------------------------------------------------------------
CREATE TABLE workers (
  id                TEXT        PRIMARY KEY,
  hostname          TEXT        NOT NULL,
  role              TEXT        NOT NULL,
  pid               INTEGER,
  concurrency       INTEGER     NOT NULL DEFAULT 1,
  in_flight         INTEGER     NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at        TIMESTAMPTZ
);

CREATE INDEX idx_workers_heartbeat ON workers (last_heartbeat_at) WHERE stopped_at IS NULL;

-- ---------------------------------------------------------------------------
-- outbox — transactional side effects
--
-- An email or webhook written in the SAME transaction as the state change that caused it. Sending
-- inline means the side effect can fire for a transaction that later rolls back.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id           TEXT        PRIMARY KEY,
  topic        TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts     INTEGER     NOT NULL DEFAULT 0,
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox (available_at)
  WHERE delivered_at IS NULL;

-- ---------------------------------------------------------------------------
-- notifications, webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id           TEXT        PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT        NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user   ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE webhook_endpoints (
  id         TEXT        PRIMARY KEY,
  owner_id   TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  url        TEXT        NOT NULL,
  secret     TEXT        NOT NULL,
  events     TEXT[]      NOT NULL DEFAULT '{}',
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_endpoints_name_per_owner UNIQUE (owner_id, name)
);

CREATE TRIGGER webhook_endpoints_touch BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE webhook_deliveries (
  id              TEXT        PRIMARY KEY,
  endpoint_id     TEXT        NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event           TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending',
  response_status INTEGER,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL;

-- ---------------------------------------------------------------------------
-- audit_log — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           TEXT        PRIMARY KEY,
  actor_id     TEXT        REFERENCES users(id) ON DELETE SET NULL,
  actor_role   user_role,
  action       TEXT        NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  before       JSONB,
  after        JSONB,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_actor   ON audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_subject ON audit_log (subject_type, subject_id, created_at DESC);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

-- An audit log that can be edited is not an audit log.
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- idempotency_keys
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id              TEXT        PRIMARY KEY,
  key             TEXT        NOT NULL UNIQUE,
  user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER     NOT NULL,
  response_body   JSONB       NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- instance_settings — single-row config editable by a super_admin
-- ---------------------------------------------------------------------------
CREATE TABLE instance_settings (
  id                  INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  run_retention_days  INTEGER     NOT NULL DEFAULT 90,
  shell_steps_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  registration_open   BOOLEAN     NOT NULL DEFAULT TRUE,
  settings            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO instance_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
