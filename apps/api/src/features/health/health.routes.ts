import type { FastifyInstance } from 'fastify';

import { healthCheck } from '../../db/client.js';
import { env } from '../../platform/env.js';

/**
 * Liveness and readiness.
 *
 * The distinction matters to any orchestrator:
 *
 *   /health  — is the PROCESS alive? Never touches the database. If this fails, restart me.
 *   /ready   — can I SERVE? Checks the database. If this fails, stop sending traffic, but do
 *              not restart me: the database being briefly unreachable is not fixed by killing
 *              the app, and restart loops during a database blip make an outage worse.
 */
export function register(app: FastifyInstance): void {
  app.get('/health', { schema: { tags: ['system'] } }, async (_request, reply) => {
    void reply.code(200).send({
      status: 'ok',
      role: env.PROCESS_ROLE,
      uptime_s: Math.round(process.uptime()),
    });
  });

  app.get('/ready', { schema: { tags: ['system'] } }, async (_request, reply) => {
    const dbOk = await healthCheck();
    void reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ready' : 'degraded',
      checks: { database: dbOk ? 'ok' : 'unreachable' },
    });
  });
}
