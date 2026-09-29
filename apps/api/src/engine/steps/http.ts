import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { ExprValue } from '@klankish/expr';
import { ERROR_CODES, redactHeaders, redactUrl, type HttpStep } from '@klankish/shared';

import { env } from '../../platform/env.js';
import type { RunContext, StepResult } from '../context.js';

/**
 * The `http` step.
 *
 * Two things here are load-bearing beyond "make a request":
 *
 *   1. SSRF DEFENCE. This step takes a user-supplied URL and fetches it from inside our network.
 *      Without a guard, any user could read `http://169.254.169.254/latest/meta-data/` and walk
 *      off with the instance's cloud credentials. The check must also re-run after EVERY redirect,
 *      because a public host is free to 302 you straight at the metadata endpoint.
 *
 *   2. THE RECORD. The full exchange — request, response, headers, timing, bytes — is captured for
 *      the run record, with secrets redacted by value as well as by name.
 */

/** Ranges that must never be reachable from a user-authored URL. */
function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
    if (a === 0) return true; // "this network"
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    // IPv4-mapped IPv6 (::ffff:169.254.169.254) would otherwise slip straight past the v4 checks.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isBlockedAddress(mapped[1]);
    return false;
  }

  return false;
}

async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new StepError(ERROR_CODES.HTTP_REQUEST_FAILED, `Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StepError(
      ERROR_CODES.HTTP_BLOCKED_TARGET,
      `Only http and https are allowed (got ${url.protocol}).`,
    );
  }

  if (env.HTTP_STEP_ALLOW_PRIVATE) return url;

  // Resolve the hostname ourselves rather than trusting its textual form: `localtest.me` and a
  // thousand other public names resolve to 127.0.0.1.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new StepError(
        ERROR_CODES.HTTP_BLOCKED_TARGET,
        `That address is not allowed: ${host} is private or loopback.`,
      );
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new StepError(ERROR_CODES.HTTP_REQUEST_FAILED, `Could not resolve ${host}.`);
  }

  // EVERY resolved address must be allowed. A name with both a public and a private A record
  // would otherwise be usable to reach the private one.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new StepError(
        ERROR_CODES.HTTP_BLOCKED_TARGET,
        `${host} resolves to a private address (${address}), which is not allowed.`,
      );
    }
  }

  return url;
}

export class StepError extends Error {
  constructor(
    readonly identity: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === '') return null;
  if (contentType !== null && contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A malformed body from an upstream is data, not a crash. Keep the text so the record shows
      // exactly what arrived.
      return text;
    }
  }
  return text;
}

export async function executeHttp(
  step: HttpStep,
  resolved: Record<string, unknown>,
  ctx: RunContext,
  timeoutMs: number,
): Promise<StepResult> {
  const rawUrl = String(resolved['url'] ?? step.url);
  const method = (resolved['method'] ?? step.method) as string;

  const url = await assertUrlAllowed(rawUrl);

  // Query params merge into the URL rather than replacing it, so a URL that already has a query
  // string keeps it.
  const query = resolved['query'] as Record<string, unknown> | undefined;
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  // Header values must be strings. The interpolator preserves types by design (a captured number
  // stays a number), so the coercion belongs here, at the point where the wire format demands it.
  const headers: Record<string, string> = {};
  const rawHeaders = (resolved['headers'] ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v !== undefined && v !== null) headers[k] = String(v);
  }

  const bodyType = step.body_type ?? (step.body === undefined ? 'none' : 'json');
  const rawBody = resolved['body'];
  let body: string | undefined;

  if (bodyType !== 'none' && rawBody !== undefined && rawBody !== null) {
    if (bodyType === 'json') {
      body = JSON.stringify(rawBody);
      headers['content-type'] ??= 'application/json';
    } else if (bodyType === 'form') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
        params.set(k, String(v));
      }
      body = params.toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else {
      body = String(rawBody);
      headers['content-type'] ??= 'text/plain';
    }
  }

  const maxRedirects = step.max_redirects ?? env.HTTP_STEP_MAX_REDIRECTS;
  const followRedirects = step.follow_redirects ?? true;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let currentUrl = url;
  let response: Response;
  let redirects = 0;

  try {
    for (;;) {
      response = await fetch(currentUrl, {
        method,
        headers,
        ...(body !== undefined && { body }),
        // Manual redirect handling so each hop can be re-checked against the SSRF rules. With
        // `redirect: 'follow'` a public host could bounce us to 169.254.169.254 unchecked.
        redirect: 'manual',
        signal: controller.signal,
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect || !followRedirects) break;

      const location = response.headers.get('location');
      if (location === null) break;

      redirects += 1;
      if (redirects > maxRedirects) {
        throw new StepError(
          ERROR_CODES.HTTP_TOO_MANY_REDIRECTS,
          `More than ${maxRedirects} redirects.`,
        );
      }

      const next = new URL(location, currentUrl);
      currentUrl = await assertUrlAllowed(next.toString());
    }

    const contentType = response.headers.get('content-type');
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');

    // Cap what is stored. A 40MB response must not bloat the database; the cap is recorded so the
    // record never silently lies about completeness.
    const truncated = bytes > env.HTTP_STEP_MAX_BYTES;
    const stored = truncated ? text.slice(0, env.HTTP_STEP_MAX_BYTES) : text;
    const parsed = parseBody(stored, contentType);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    const durationMs = Date.now() - started;

    const expected = step.expect_status;
    const succeeded =
      expected !== undefined
        ? expected.includes(response.status)
        : response.status >= 200 && response.status < 300;

    const output: ExprValue = {
      status: response.status,
      ok: succeeded,
      headers: responseHeaders as ExprValue,
      body: parsed as ExprValue,
      bytes,
      truncated,
      duration_ms: durationMs,
    };

    const exchange = {
      request_method: method,
      // Redacted by NAME (an api_key query param) and by VALUE (a secret interpolated into the
      // path), because either alone leaves a hole.
      request_url: redactUrl(currentUrl.toString(), ctx.secretValues),
      request_headers: redactHeaders(headers, ctx.secretValues),
      request_body: body === undefined ? null : truncateForRecord(body),
      response_status: response.status,
      response_headers: responseHeaders,
      response_body: parsed,
      bytes,
      duration_ms: durationMs,
      truncated,
    };

    if (!succeeded) {
      return {
        status: 'failed',
        output,
        error: {
          identity: ERROR_CODES.HTTP_REQUEST_FAILED,
          message: `The request returned ${response.status}.`,
          // Conditional spread, not `detail: undefined`: under exactOptionalPropertyTypes an
          // explicit undefined is NOT the same as an absent key.
          ...(typeof parsed === 'string' && { detail: parsed.slice(0, 500) }),
        },
        http: exchange,
      };
    }

    return { status: 'succeeded', output, http: exchange };
  } catch (err) {
    const durationMs = Date.now() - started;

    if (err instanceof StepError) throw err;

    // An abort here is our own timeout firing, not the upstream refusing.
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        status: 'timed_out',
        output: { duration_ms: durationMs } as ExprValue,
        error: {
          identity: ERROR_CODES.STEP_TIMEOUT,
          message: `No response within ${timeoutMs}ms.`,
        },
      };
    }

    return {
      status: 'failed',
      output: { duration_ms: durationMs } as ExprValue,
      error: {
        identity: ERROR_CODES.HTTP_REQUEST_FAILED,
        message: 'The request could not be completed.',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function truncateForRecord(value: string): string {
  const LIMIT = 16_384;
  return value.length > LIMIT
    ? `${value.slice(0, LIMIT)}… [TRUNCATED ${value.length - LIMIT} chars]`
    : value;
}

export { isBlockedAddress, assertUrlAllowed };
