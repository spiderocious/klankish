/**
 * Redaction.
 *
 * This runs on EVERY path where a step's resolved input, output, or an error is persisted,
 * returned by the API, or logged. It is built in phase 1 rather than retrofitted, because
 * retrofitting redaction means auditing every write site in the codebase and being sure you found
 * them all.
 *
 * Two independent mechanisms, and both are needed:
 *
 *   1. BY NAME — a field called `authorization` or `password` is redacted whatever it contains.
 *      Catches secrets that never went through the interpolator (a user pasting a token straight
 *      into a header value).
 *
 *   2. BY VALUE — the literal strings the interpolator resolved from `{{ secrets.X }}` are
 *      replaced wherever they appear. Catches a secret that has been moved: interpolated into a
 *      URL, echoed back inside a response body, or quoted in an upstream error message.
 *
 * Name-based alone would miss a token echoed in a body. Value-based alone would miss a password
 * typed directly into a config. Together they cover both.
 */

export const REDACTED = '[REDACTED]';

/** Field names redacted regardless of content. Matched case-insensitively as substrings. */
const SENSITIVE_NAME_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'auth',
  'api_key',
  'apikey',
  'access_key',
  'secret_key',
  'private_key',
  'credential',
  'session',
  'cookie',
  'set-cookie',
  'x-api-key',
  'client_secret',
  'refresh_token',
  'id_token',
  'bearer',
  'signature',
  'pin',
  'otp',
  'cvv',
  'card_number',
];

/**
 * Names that CONTAIN a sensitive substring but are not themselves sensitive.
 *
 * Without this list, `token_count` and `auth_method` get redacted, which makes a run record
 * actively misleading — you would be hiding the thing you need to debug.
 */
const NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  'token_count',
  'tokens_used',
  'auth_method',
  'auth_type',
  'authenticated',
  'session_count',
  'secret_name',
  'secret_names',
  'has_token',
  'token_expires_at',
  'authorization_url',
]);

export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  if (NAME_ALLOWLIST.has(lower)) return false;
  return SENSITIVE_NAME_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Below this length a secret value is not replaced by value.
 *
 * A two-character secret would otherwise redact every occurrence of those characters across the
 * whole payload and destroy the record. Short secrets are still caught by name, and are a bad idea
 * regardless.
 */
const MIN_VALUE_LEN = 6;

export interface RedactOptions {
  /** Literal secret values to replace wherever they occur. */
  readonly values?: Iterable<string>;
  readonly maxDepth?: number;
  /** Strings longer than this are truncated; a huge body should not bloat a log line. */
  readonly maxStringLen?: number;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildValueMatcher(values: Iterable<string> | undefined): RegExp | null {
  if (values === undefined) return null;
  const usable = [...new Set(values)].filter((v) => v.length >= MIN_VALUE_LEN);
  if (usable.length === 0) return null;
  // Longest first, so an overlapping shorter secret cannot mask a longer one.
  usable.sort((a, b) => b.length - a.length);
  return new RegExp(usable.map(escapeRegExp).join('|'), 'g');
}

/**
 * Redact any JSON-shaped value.
 *
 * Returns a new structure; the input is never mutated, because the caller usually still needs the
 * real values to actually perform the request.
 */
export function redact<T>(value: T, opts: RedactOptions = {}): T {
  const matcher = buildValueMatcher(opts.values);
  const maxDepth = opts.maxDepth ?? 32;
  const maxStringLen = opts.maxStringLen ?? 20_000;
  return walk(value, matcher, maxDepth, maxStringLen, 0) as T;
}

function walk(
  value: unknown,
  matcher: RegExp | null,
  maxDepth: number,
  maxStringLen: number,
  depth: number,
): unknown {
  if (depth > maxDepth) return '[TRUNCATED: too deep]';

  if (typeof value === 'string') return redactString(value, matcher, maxStringLen);

  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value;

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, matcher, maxDepth, maxStringLen, depth + 1));
  }

  if (typeof value === 'object') {
    // Guard against exotic objects reaching a log serialiser.
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message, matcher, maxStringLen),
      };
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveName(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, matcher, maxDepth, maxStringLen, depth + 1);
    }
    return out;
  }

  // Functions and symbols should never appear in a task payload.
  return '[UNSERIALISABLE]';
}

function redactString(s: string, matcher: RegExp | null, maxStringLen: number): string {
  let out = s;
  if (matcher !== null) {
    matcher.lastIndex = 0;
    out = out.replace(matcher, REDACTED);
  }
  if (out.length > maxStringLen) {
    out = `${out.slice(0, maxStringLen)}… [TRUNCATED ${out.length - maxStringLen} chars]`;
  }
  return out;
}

/**
 * Redact HTTP headers.
 *
 * Separate from the generic walker because header names are flat and case-insensitive, and because
 * an `authorization` header must be redacted even though its VALUE may be a token the interpolator
 * never saw.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  values?: Iterable<string>,
): Record<string, string> {
  const matcher = buildValueMatcher(values);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const joined = Array.isArray(v) ? v.join(', ') : String(v);
    out[k] = isSensitiveName(k) ? REDACTED : redactString(joined, matcher, 4096);
  }
  return out;
}

/**
 * A URL with credentials or secret-looking query parameters neutralised.
 *
 * `https://api.test/x?api_key=abc` is a real and common way for a secret to end up in a run
 * record, and it is invisible to the name-based object walk because the whole thing is one string.
 */
export function redactUrl(raw: string, values?: Iterable<string>): string {
  const matcher = buildValueMatcher(values);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redactString(raw, matcher, 2048);
  }

  if (url.username !== '' || url.password !== '') {
    url.username = url.password === '' ? url.username : REDACTED;
    if (url.password !== '') url.password = REDACTED;
  }

  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveName(key)) url.searchParams.set(key, REDACTED);
  }

  // URLSearchParams percent-encodes the brackets, producing `%5BREDACTED%5D`. That is still
  // redacted, but it reads as noise in a run record and is not greppable, so put the literal
  // marker back. Only the marker is decoded — any other encoding in the URL is left alone.
  const serialised = url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);

  return redactString(serialised, matcher, 2048);
}

/** pino redact paths, for the structured logger. */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.current_password',
  'req.body.new_password',
  'req.body.token',
  'req.body.refresh_token',
  'req.body.value',
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.api_key',
  '*.access_token',
  '*.refresh_token',
  '*.private_key',
  '*.client_secret',
];
