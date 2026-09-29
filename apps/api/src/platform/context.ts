import { AsyncLocalStorage } from 'node:async_hooks';

import type { Actor } from '@klankish/shared';

/**
 * Per-request context, carried through the call stack without being passed as an argument.
 *
 * This is what makes "never pass `req` into a service" practical rather than aspirational. A
 * service that needs the acting user reads it from here; it never receives an HTTP object, so it
 * stays testable and has no idea it is running inside a web request. The same store works for the
 * worker, where there is no request at all.
 */

export interface RequestContext {
  readonly request_id: string;
  /**
   * The one MUTABLE field on the context.
   *
   * A route's auth hook resolves the actor after the store was created in `onRequest`. Re-entering
   * `runWithContext` there would fork the async chain and lose the handler's work, so instead this
   * slot is filled in place by `setContextActor`. Everything else here is immutable.
   */
  actor?: Actor;
  readonly ip?: string;
  readonly user_agent?: string;
  readonly idempotency_key?: string;
  /** Set when running inside the engine rather than an HTTP request. */
  readonly run_id?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attach the resolved actor to the live context.
 *
 * Called once per request by the `preHandler` hook in app.ts, after the route's auth hook has
 * run. A no-op outside a request (the worker seeds its own context with no actor).
 */
export function setContextActor(actor: Actor): void {
  const store = storage.getStore();
  if (store !== undefined) store.actor = actor;
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.request_id;
}

/**
 * The acting user, or undefined when unauthenticated.
 *
 * Services call this rather than receiving an actor parameter. The route's auth hook has already
 * run, so inside an authenticated handler this is present — but it returns `| undefined` anyway,
 * because a type that lies about that is worse than one that makes you check.
 */
export function getActor(): Actor | undefined {
  return storage.getStore()?.actor;
}

/**
 * The acting user, asserted.
 *
 * For service methods only reachable behind an auth hook. Throwing here means a route was
 * registered without its auth hook — a programming error, not a user error, so an exception
 * is the right response.
 */
export function requireActor(): Actor {
  const actor = getActor();
  if (actor === undefined) {
    throw new Error(
      'requireActor() called with no actor in context — the route is missing its auth hook.',
    );
  }
  return actor;
}
