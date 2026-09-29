/**
 * Environment parsing.
 *
 * Parsed once, at boot, and FAILS LOUDLY on anything missing or malformed. A server that starts
 * with a missing secret and only discovers it at the first request is much worse than one that
 * refuses to start.
 *
 * Hand-rolled rather than Zod so this module has no dependencies and can be imported by anything,
 * including the migration CLI, without pulling in the validation stack.
 */

export type ProcessRole = 'all' | 'api' | 'worker' | 'scheduler';

interface RawEnv {
  readonly [key: string]: string | undefined;
}

class EnvError extends Error {
  constructor(problems: readonly string[]) {
    super(
      `Environment is not valid:\n${problems.map((p) => `  • ${p}`).join('\n')}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    );
    this.name = 'EnvError';
  }
}

const problems: string[] = [];

function str(raw: RawEnv, key: string, fallback?: string): string {
  const v = raw[key];
  if (v === undefined || v.trim() === '') {
    if (fallback !== undefined) return fallback;
    problems.push(`${key} is required`);
    return '';
  }
  return v.trim();
}

function optional(raw: RawEnv, key: string): string | undefined {
  const v = raw[key];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function int(raw: RawEnv, key: string, fallback: number, min?: number, max?: number): number {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) {
    problems.push(`${key} must be a whole number (got "${v}")`);
    return fallback;
  }
  if (min !== undefined && n < min) {
    problems.push(`${key} must be at least ${min} (got ${n})`);
    return fallback;
  }
  if (max !== undefined && n > max) {
    problems.push(`${key} must be at most ${max} (got ${n})`);
    return fallback;
  }
  return n;
}

function bool(raw: RawEnv, key: string, fallback: boolean): boolean {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return fallback;
  const lower = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lower)) return true;
  if (['false', '0', 'no', 'off'].includes(lower)) return false;
  problems.push(`${key} must be true or false (got "${v}")`);
  return fallback;
}

function secret(raw: RawEnv, key: string, minLength: number, devFallback: string): string {
  const v = raw[key];
  const isProd = raw['NODE_ENV'] === 'production';

  if (v === undefined || v.trim() === '') {
    if (isProd) {
      problems.push(`${key} is required in production`);
      return '';
    }
    // Dev gets a deterministic placeholder so `pnpm dev` works from a clean checkout. Production
    // never does — that is the whole point of the branch.
    return devFallback;
  }
  if (v.trim().length < minLength) {
    problems.push(`${key} must be at least ${minLength} characters`);
  }
  return v.trim();
}

function list(raw: RawEnv, key: string, fallback: readonly string[]): string[] {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return [...fallback];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseEnv(raw: RawEnv) {
  const nodeEnv = str(raw, 'NODE_ENV', 'development');
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    problems.push(`NODE_ENV must be development, test or production (got "${nodeEnv}")`);
  }

  const role = str(raw, 'PROCESS_ROLE', 'all');
  if (!['all', 'api', 'worker', 'scheduler'].includes(role)) {
    problems.push(`PROCESS_ROLE must be all, api, worker or scheduler (got "${role}")`);
  }

  const encryptionKey = secret(
    raw,
    'ENCRYPTION_KEY',
    32,
    'dev-only-encryption-key-not-for-production!!',
  );

  return {
    NODE_ENV: nodeEnv as 'development' | 'test' | 'production',
    PROCESS_ROLE: role as ProcessRole,
    PORT: int(raw, 'PORT', 3000, 1, 65535),
    HOST: str(raw, 'HOST', '0.0.0.0'),
    APP_URL: str(raw, 'APP_URL', 'http://localhost:5173'),
    CORS_ORIGINS: list(raw, 'CORS_ORIGINS', ['http://localhost:5173', 'http://localhost:3000']),

    DATABASE_URL: str(raw, 'DATABASE_URL', 'postgres://localhost:5432/klankish_dev'),
    PG_POOL_MAX: int(raw, 'PG_POOL_MAX', 10, 1, 100),

    JWT_SECRET: secret(raw, 'JWT_SECRET', 32, 'dev-only-jwt-secret-change-me-in-production!!'),
    JWT_REFRESH_SECRET: secret(
      raw,
      'JWT_REFRESH_SECRET',
      32,
      'dev-only-refresh-secret-change-me-in-prod!!',
    ),
    ACCESS_TOKEN_TTL_S: int(raw, 'ACCESS_TOKEN_TTL_S', 900, 60, 86_400),
    REFRESH_TOKEN_TTL_S: int(raw, 'REFRESH_TOKEN_TTL_S', 2_592_000, 3600, 31_536_000),
    ENCRYPTION_KEY: encryptionKey,

    // --- engine ---
    WORKER_CONCURRENCY: int(raw, 'WORKER_CONCURRENCY', 4, 1, 64),
    LEASE_TTL_MS: int(raw, 'LEASE_TTL_MS', 60_000, 5_000, 600_000),
    SCHEDULER_TICK_MS: int(raw, 'SCHEDULER_TICK_MS', 5_000, 1_000, 60_000),
    WORKER_POLL_MS: int(raw, 'WORKER_POLL_MS', 1_000, 100, 30_000),
    // 1 by default: after a day of downtime a daily job fires ONCE on recovery, not 288 times.
    MAX_CATCHUP_FIRES: int(raw, 'MAX_CATCHUP_FIRES', 1, 0, 100),
    RUN_DEFAULT_TIMEOUT_MS: int(raw, 'RUN_DEFAULT_TIMEOUT_MS', 900_000, 1_000, 86_400_000),
    STEP_DEFAULT_TIMEOUT_MS: int(raw, 'STEP_DEFAULT_TIMEOUT_MS', 60_000, 1_000, 3_600_000),

    // --- http step ---
    HTTP_STEP_MAX_BYTES: int(raw, 'HTTP_STEP_MAX_BYTES', 262_144, 1024, 10_485_760),
    HTTP_STEP_MAX_REDIRECTS: int(raw, 'HTTP_STEP_MAX_REDIRECTS', 3, 0, 10),
    /**
     * SSRF guard. Private/loopback/link-local targets are blocked unless this is on — which a
     * self-hosted instance calling its own internal services legitimately needs.
     */
    HTTP_STEP_ALLOW_PRIVATE: bool(raw, 'HTTP_STEP_ALLOW_PRIVATE', false),

    // --- shell step ---
    // OFF by default: a hosted multi-user instance running arbitrary commands is a different
    // security posture from a personal one, and that should be an explicit choice.
    SHELL_STEPS_ENABLED: bool(raw, 'SHELL_STEPS_ENABLED', false),
    SHELL_ALLOWED_BINARIES: list(raw, 'SHELL_ALLOWED_BINARIES', []),
    SHELL_WORKSPACE_ROOT: optional(raw, 'SHELL_WORKSPACE_ROOT'),
    SHELL_MAX_OUTPUT_BYTES: int(raw, 'SHELL_MAX_OUTPUT_BYTES', 1_048_576, 1024, 52_428_800),
    SHELL_KILL_GRACE_MS: int(raw, 'SHELL_KILL_GRACE_MS', 5_000, 100, 60_000),

    // --- integrations (all optional; features degrade rather than crash) ---
    RESEND_API_KEY: optional(raw, 'RESEND_API_KEY'),
    MAIL_FROM: str(raw, 'MAIL_FROM', 'Klankish <noreply@localhost>'),

    S3_ENDPOINT: optional(raw, 'S3_ENDPOINT'),
    S3_REGION: str(raw, 'S3_REGION', 'auto'),
    S3_BUCKET: optional(raw, 'S3_BUCKET'),
    S3_ACCESS_KEY_ID: optional(raw, 'S3_ACCESS_KEY_ID'),
    S3_SECRET_ACCESS_KEY: optional(raw, 'S3_SECRET_ACCESS_KEY'),
    // R2 and most S3-compatibles need path-style addressing; AWS itself does not.
    S3_FORCE_PATH_STYLE: bool(raw, 'S3_FORCE_PATH_STYLE', true),

    // --- limits ---
    RATE_LIMIT_ANON_PER_MIN: int(raw, 'RATE_LIMIT_ANON_PER_MIN', 30, 1, 10_000),
    RATE_LIMIT_USER_PER_MIN: int(raw, 'RATE_LIMIT_USER_PER_MIN', 300, 1, 100_000),
    RATE_LIMIT_ADMIN_PER_MIN: int(raw, 'RATE_LIMIT_ADMIN_PER_MIN', 1_000, 1, 100_000),
    BODY_LIMIT_BYTES: int(raw, 'BODY_LIMIT_BYTES', 1_048_576, 1024, 52_428_800),

    RUN_RETENTION_DAYS: int(raw, 'RUN_RETENTION_DAYS', 90, 1, 3650),
    LOG_LEVEL: str(raw, 'LOG_LEVEL', 'info'),
    SERVE_WEB: bool(raw, 'SERVE_WEB', true),
  };
}

export const env = parseEnv(process.env);

if (problems.length > 0) {
  throw new EnvError(problems);
}

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';

/** Whether this process should run HTTP, the worker loop, and the scheduler, respectively. */
export const runsApi = env.PROCESS_ROLE === 'all' || env.PROCESS_ROLE === 'api';
export const runsWorker = env.PROCESS_ROLE === 'all' || env.PROCESS_ROLE === 'worker';
export const runsScheduler = env.PROCESS_ROLE === 'all' || env.PROCESS_ROLE === 'scheduler';

export const mailConfigured = env.RESEND_API_KEY !== undefined;
export const storageConfigured =
  env.S3_BUCKET !== undefined &&
  env.S3_ACCESS_KEY_ID !== undefined &&
  env.S3_SECRET_ACCESS_KEY !== undefined;

/**
 * Production-only assertions.
 *
 * Kept OUT of parseEnv deliberately: `pnpm dev` must boot from a clean checkout without a real
 * secret, while production must refuse to start with a placeholder. Called from server.ts.
 */
export function assertProductionReady(): void {
  if (!isProd) return;

  const fatal: string[] = [];
  if (env.JWT_SECRET.startsWith('dev-only')) fatal.push('JWT_SECRET is still the dev placeholder');
  if (env.JWT_REFRESH_SECRET.startsWith('dev-only')) {
    fatal.push('JWT_REFRESH_SECRET is still the dev placeholder');
  }
  if (env.ENCRYPTION_KEY.startsWith('dev-only')) {
    fatal.push('ENCRYPTION_KEY is still the dev placeholder — stored secrets would be readable');
  }
  if (env.CORS_ORIGINS.some((o) => o.includes('localhost'))) {
    fatal.push('CORS_ORIGINS still contains localhost');
  }
  if (fatal.length > 0) throw new EnvError(fatal);
}
