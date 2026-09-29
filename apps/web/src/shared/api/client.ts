import type { ErrorCode, PaginationMeta, Severity } from '@klankish/shared';

import { EP } from '../constants/endpoints.js';

/**
 * The API client.
 *
 * Two responsibilities beyond fetching:
 *
 *   1. UNWRAP THE ENVELOPE. Every success is `{ data, meta? }`; callers get `data` directly so no
 *      component has to remember the wrapper.
 *
 *   2. TURN AN ERROR ENVELOPE INTO A TYPED ERROR. `ApiError` carries the STABLE IDENTITY that
 *      code branches on, and the RESOLVED MESSAGE that a person reads. Those are different jobs
 *      and they never swap: branching on a message breaks when copy changes, and showing an
 *      identity puts `insufficient_role` in front of a user.
 */

export class ApiError extends Error {
  constructor(
    /** The contract. `switch` on this — never on `message`, never on `severity`. */
    readonly reason: ErrorCode | string,
    /** Resolved, user-facing. Render verbatim; never invent your own copy for a known error. */
    readonly displayMessage: string,
    readonly status: number,
    readonly severity?: Severity,
    readonly fieldErrors?: Record<string, string[]>,
    /** Operator diagnostic. NOT contract — never branch on it. */
    readonly rejection?: string,
    readonly retryAfter?: number,
    readonly requestId?: string,
  ) {
    super(displayMessage);
    this.name = 'ApiError';
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isValidation(): boolean {
    return this.fieldErrors !== undefined && Object.keys(this.fieldErrors).length > 0;
  }
}

interface TokenStore {
  access: string | null;
  refresh: string | null;
}

const STORAGE_KEY = 'klankish-tokens';

/**
 * Tokens live in localStorage.
 *
 * An httpOnly cookie would be better against XSS, but this SPA is served cross-origin in dev and
 * the refresh-rotation design already limits the blast radius: a stolen refresh token is single
 * use, and presenting it twice revokes the whole family. Every read is wrapped because
 * localStorage throws in some private modes.
 */
const tokens: TokenStore = { access: null, refresh: null };

function loadTokens(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw) as Partial<TokenStore>;
    tokens.access = typeof parsed.access === 'string' ? parsed.access : null;
    tokens.refresh = typeof parsed.refresh === 'string' ? parsed.refresh : null;
  } catch {
    /* unreadable storage is the same as no session */
  }
}

export function setTokens(access: string | null, refresh: string | null): void {
  tokens.access = access;
  tokens.refresh = refresh;
  try {
    if (access === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ access, refresh }));
  } catch {
    /* in-memory only; the session still works for this tab */
  }
}

export function getAccessToken(): string | null {
  return tokens.access;
}

export function hasSession(): boolean {
  return tokens.refresh !== null;
}

loadTokens();

/** Callback so the auth provider can react to a session ending without a circular import. */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: () => void): void {
  onSessionExpired = fn;
}

/**
 * A single in-flight refresh, shared by every caller.
 *
 * Without this, five queries failing with 401 at once fire five refreshes — and since refresh
 * tokens are SINGLE USE with reuse detection, four of them would present an already-rotated token
 * and the server would correctly revoke the entire session. The user would be logged out for
 * loading a page.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (refreshInFlight !== null) return refreshInFlight;
  if (tokens.refresh === null) return false;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(EP.AUTH.REFRESH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refresh }),
      });

      if (!res.ok) {
        setTokens(null, null);
        onSessionExpired?.();
        return false;
      }

      const body = (await res.json()) as {
        data: { access_token: string; refresh_token: string };
      };
      setTokens(body.data.access_token, body.data.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly params?: Record<string, string | number | boolean | undefined>;
  readonly signal?: AbortSignal;
  /** Set on mutations that must not double-apply if the network retries. */
  readonly idempotencyKey?: string;
  readonly skipAuth?: boolean;
}

export interface ApiResult<T> {
  readonly data: T;
  readonly meta?: PaginationMeta;
}

async function parseError(res: Response): Promise<ApiError> {
  let envelope: {
    error?: {
      reason?: string;
      message?: string;
      severity?: number;
      fieldErrors?: Record<string, string[]>;
      rejection?: string;
      request_id?: string;
      retry_after?: number;
    };
  } = {};

  try {
    envelope = (await res.json()) as typeof envelope;
  } catch {
    /* a non-JSON error body (a proxy 502, say) still needs to become an ApiError */
  }

  const err = envelope.error;
  return new ApiError(
    err?.reason ?? 'internal_error',
    // The server already resolved the right copy. Inventing our own here is how a frontend ends
    // up contradicting the backend about what went wrong.
    err?.message ?? `Something went wrong (${res.status}).`,
    res.status,
    err?.severity as Severity | undefined,
    err?.fieldErrors,
    err?.rejection,
    err?.retry_after,
    err?.request_id,
  );
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const { method = 'GET', body, params, signal, idempotencyKey, skipAuth } = options;

  const url = new URL(path, window.location.origin);
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    if (skipAuth !== true && tokens.access !== null) {
      headers['Authorization'] = `Bearer ${tokens.access}`;
    }

    return fetch(url.toString(), {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal !== undefined && { signal }),
    });
  };

  let res = await send();

  // One transparent refresh-and-retry on 401. Exactly one: a second failure means the session is
  // genuinely gone, and looping would hammer the endpoint.
  if (res.status === 401 && skipAuth !== true && tokens.refresh !== null) {
    if (await refreshTokens()) res = await send();
  }

  if (!res.ok) throw await parseError(res);

  // 204 has NO body. Calling .json() on it throws — the documented mistake this avoids.
  if (res.status === 204) return { data: undefined as T };

  const json = (await res.json()) as { data: T; meta?: PaginationMeta };
  return { data: json.data, ...(json.meta !== undefined && { meta: json.meta }) };
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', ...(body !== undefined && { body }) }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', ...(body !== undefined && { body }) }),

  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', ...(body !== undefined && { body }) }),

  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};
