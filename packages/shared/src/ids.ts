/**
 * ULIDs, resource-prefixed.
 *
 * Monotonically sortable (so `ORDER BY id` is chronological), URL-safe, unguessable, and opaque to
 * clients — they store and echo them back, never parse them.
 *
 * Implemented here rather than pulled from npm: it is ~60 lines, it removes a dependency from the
 * hot path of every insert, and `crypto.getRandomValues` is available in both Node and the browser.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export const ID_PREFIXES = {
  user: 'u_',
  session: 'ss_',
  api_key: 'ak_',
  task: 't_',
  task_version: 'tv_',
  schedule: 'sc_',
  run: 'r_',
  step_run: 'sr_',
  http_exchange: 'ex_',
  secret: 'sk_',
  connection: 'cn_',
  artifact: 'af_',
  audit: 'al_',
  notification: 'nt_',
  webhook: 'wh_',
  webhook_delivery: 'wd_',
  outbox: 'ob_',
  idempotency: 'ik_',
  worker: 'wk_',
} as const;

export type ResourceKind = keyof typeof ID_PREFIXES;

function encodeTime(now: number, len: number): string {
  let out = '';
  let t = now;
  for (let i = len - 1; i >= 0; i -= 1) {
    const mod = t % ENCODING_LEN;
    out = (ENCODING[mod] ?? '0') + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    // Mask to 5 bits so every byte maps into the 32-character alphabet without bias.
    out += ENCODING[(bytes[i] ?? 0) & 0x1f] ?? '0';
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

export function newId(kind: ResourceKind, now?: number): string {
  return ID_PREFIXES[kind] + ulid(now);
}

/**
 * Shape check only — it does NOT prove the row exists.
 *
 * Its real job is rejecting a malformed id at the validation boundary so it never reaches a query,
 * and catching the case where a client sends a run id where a task id belongs.
 */
export function isId(value: unknown, kind?: ResourceKind): value is string {
  if (typeof value !== 'string') return false;
  if (kind !== undefined) {
    const prefix = ID_PREFIXES[kind];
    if (!value.startsWith(prefix)) return false;
    return isUlid(value.slice(prefix.length));
  }
  const underscore = value.indexOf('_');
  if (underscore < 1) return false;
  return isUlid(value.slice(underscore + 1));
}

function isUlid(s: string): boolean {
  if (s.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of s) {
    if (!ENCODING.includes(ch)) return false;
  }
  return true;
}

/** Milliseconds encoded in a ULID's time component. Useful in admin tooling, never in logic. */
export function idTimestamp(id: string): number | null {
  const underscore = id.indexOf('_');
  const body = underscore >= 0 ? id.slice(underscore + 1) : id;
  if (!isUlid(body)) return null;
  let t = 0;
  for (const ch of body.slice(0, TIME_LEN)) {
    const idx = ENCODING.indexOf(ch);
    if (idx < 0) return null;
    t = t * ENCODING_LEN + idx;
  }
  return t;
}
