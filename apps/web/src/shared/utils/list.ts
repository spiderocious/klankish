/**
 * Widen a readonly array for a component that declares a mutable one.
 *
 * The wire types are `readonly` on purpose — server data should not be mutated in place — but
 * meemaw's `Repeat` declares `each?: T[]`. This is the one adapter between those two facts, so
 * the cast lives HERE rather than being scattered as `as T[]` across every screen.
 */
export function list<T>(items: readonly T[] | undefined): T[] {
  return items === undefined ? [] : (items as T[]);
}
