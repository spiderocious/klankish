import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import { env, isProd } from './env.js';
import { setSpaRoot } from './error-handler.js';
import { subLogger } from './logger.js';

/**
 * Serve the built SPA from the API process.
 *
 * ONE deployable instead of two. On Railway that is the difference between one service and a
 * second one plus a CORS configuration plus a separate domain — and since the SPA is an
 * authenticated internal tool with no SEO need, there is nothing a separate static host buys.
 *
 * Serving same-origin also removes the CORS preflight entirely in production, which is one fewer
 * thing to misconfigure.
 */

const log = subLogger('web');

/** Where the built SPA lands, relative to the compiled server. */
function findWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // Docker image layout: /app/apps/api/dist/platform -> /app/apps/web/dist
    resolve(here, '../../../web/dist'),
    // Local build from source: apps/api/dist/platform -> apps/web/dist
    resolve(here, '../../../../apps/web/dist'),
    // A flattened image that copied the SPA next to the server
    resolve(here, '../public'),
    resolve(here, '../../public'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export async function registerWebServing(app: FastifyInstance): Promise<void> {
  if (!env.SERVE_WEB) {
    log.info('SERVE_WEB is off — not serving the SPA from this process');
    return;
  }

  const root = findWebRoot();
  if (root === null) {
    // Not fatal: in development the SPA is served by Vite on its own port, and an API-only
    // deployment is a legitimate configuration. Say so rather than failing the boot.
    log.info('no built SPA found — API only (run `pnpm build` in apps/web to serve it here)');
    return;
  }

  await app.register(fastifyStatic, {
    root,
    // OFF, so our setHeaders below is authoritative. Left on, @fastify/static emits its own
    // `max-age=0` and the per-file rules below are silently overridden — which is exactly what
    // happened, and only showed up by reading the response headers.
    cacheControl: false,
    // Hashed asset filenames can be cached forever; index.html must never be, or a deploy ships
    // new assets that an old cached shell never requests.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        // Vite emits `name-HASH.ext` with a dash before the hash, not a dot. The earlier dot-based
        // pattern matched nothing, so every asset fell through to the short cache — which is the
        // kind of thing that only shows up when you look at the response headers.
      } else if (/-[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|svg|jpg)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  });

  // The SPA fallback itself lives in the error handler's notFoundHandler — Fastify permits only
  // ONE of those per instance, and registering a second is a boot crash. `setSpaRoot` tells that
  // handler a SPA exists so it can serve index.html for navigations.
  setSpaRoot(root);

  log.info({ root, production: isProd }, 'serving the SPA from this process');
}
