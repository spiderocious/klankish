/**
 * Cursor pagination codec.
 *
 * Cursors are opaque base64url blobs. Clients store and echo them; they never parse or construct
 * one. Keeping them opaque is what lets the sort key change later without breaking every client.
 *
 * Offset pagination is banned: it silently skips or repeats rows when items are inserted between
 * page fetches, which in a run list — where new rows arrive constantly — is guaranteed rather than
 * theoretical.
 */

export interface Cursor {
  /** The last row's id, breaking ties when two rows share a sort key. */
  readonly last_id: string;
  /** The last row's sort value, usually an ISO timestamp. */
  readonly last_sort_key: string;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE_ADMIN = 100;

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify({ i: cursor.last_id, s: cursor.last_sort_key }));
}

/**
 * Decode a cursor. Returns null rather than throwing for ANY malformed input.
 *
 * A bad cursor is a client bug or a hand-edited URL, and the right response is to serve the first
 * page, not to 500. The caller decides whether to treat null as "start from the beginning".
 */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(raw));
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const id = obj['i'];
    const sort = obj['s'];
    if (typeof id !== 'string' || typeof sort !== 'string') return null;
    if (id === '' || sort === '') return null;
    return { last_id: id, last_sort_key: sort };
  } catch {
    return null;
  }
}

/** Clamp a client-supplied limit. Never trust it — an unclamped limit is a trivial DoS. */
export function clampLimit(raw: unknown, isAdmin = false): number {
  const max = isAdmin ? MAX_PAGE_SIZE_ADMIN : MAX_PAGE_SIZE;
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), max);
}

/**
 * Build a page from rows fetched with `limit + 1`.
 *
 * Fetching one extra row is how `has_more` is answered without a second COUNT query — the extra
 * row is dropped before serialising.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => Cursor,
): { items: T[]; next_cursor: string | null; has_more: boolean } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];
  return {
    items,
    next_cursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
    has_more: hasMore,
  };
}
