import Ajv from 'ajv';
import addAjvFormats from 'ajv-formats';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { newId } from '@klankish/shared';
import Fastify, { type FastifyInstance } from 'fastify';

import { register as registerAuth } from './features/auth/auth.routes.js';
import { register as registerDashboard } from './features/dashboard/dashboard.routes.js';
import { register as registerHealth } from './features/health/health.routes.js';
import { register as registerRuns } from './features/runs/runs.routes.js';
import { register as registerSecrets } from './features/secrets/secrets.routes.js';
import { register as registerTasks } from './features/tasks/tasks.routes.js';
import { runWithContext, setContextActor, type RequestContext } from './platform/context.js';
import { env, isProd } from './platform/env.js';
import { registerErrorHandler } from './platform/error-handler.js';
import { logger } from './platform/logger.js';

/**
 * buildApp() — the application factory.
 *
 * Returns a configured instance WITHOUT listening, so tests can drive it via `app.inject()` with
 * no port, no sockets, and no teardown races.
 *
 * HOOK ORDER IS LOAD-BEARING. The order below is the contract:
 *   1. security headers
 *   2. request id + context      ← everything after this can log with a request id
 *   3. route-level auth hooks    ← declared per route, not globally
 *   4. route-level rate limits   ← after auth, so they can key by user
 *   5. handler
 *   6. error handler             ← registered last; anything after it cannot catch errors
 */
/** Strict validator for request BODIES: no coercion, so a wrong type is reported, not hidden. */
const strictAjv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: true,
});
addAjvFormats(strictAjv);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we log through our own pino instance, with redaction configured
    trustProxy: true, // Railway and every other PaaS terminates TLS upstream
    bodyLimit: env.BODY_LIMIT_BYTES,
    ajv: {
      customOptions: {
        // Return ALL validation errors, not just the first. The policy is decided once and
        // applied in BOTH places — here and in the error handler's fieldErrors mapper — because
        // splitting it is how a form shows one error on submit and five on re-render.
        allErrors: true,
        removeAdditional: false,
        // A query string is ALWAYS strings: `?all_users=true` arrives as "true", and without
        // coercion a boolean or integer query param can never validate. Bodies are a different
        // case — there, silent coercion hides a genuine client type error — so coercion is
        // applied per-schema below rather than globally.
        coerceTypes: false,
      },
    },
  });

  /**
   * Validator compilers, split by where the data came from.
   *
   * Query strings and path params are always strings on the wire, so `?limit=20` must be coerced
   * to a number to satisfy an integer schema. A JSON body carries real types already, so coercing
   * there would silently accept `{"limit": "20"}` from a buggy client and hide the mistake.
   */
  const ajvCoercing = new Ajv({
    allErrors: true,
    coerceTypes: true,
    removeAdditional: false,
    useDefaults: true,
  });
  addAjvFormats(ajvCoercing);

  app.setValidatorCompiler(({ schema, httpPart }) => {
    if (httpPart === 'querystring' || httpPart === 'params' || httpPart === 'headers') {
      return ajvCoercing.compile(schema);
    }
    return strictAjv.compile(schema);
  });

  await app.register(helmet, {
    // The SPA is served from this same origin; CSP is configured where static files are served.
    contentSecurityPolicy: false,
  });

  // OpenAPI. Registered BEFORE any route, because the generator only sees routes added after it.
  // This is also what makes `schema.tags` a valid property on a route definition.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Klankish API',
        description:
          'Scheduled, conditional task automation. Every run leaves a complete record of what ' +
          'executed, what was sent, and what came back.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'http', scheme: 'bearer', description: 'An API key: klk_…' },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await app.register(cors, {
    origin: isProd ? env.CORS_ORIGINS : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  /**
   * Seed the request context.
   *
   * onRequest is the earliest hook, so every log line and every service call downstream can read
   * the request id. This is also what makes "never pass req into a service" workable: the actor
   * lands here (via a later auth hook) and services read it from async storage.
   */
  app.addHook('onRequest', (request, reply, done) => {
    const headerId = request.headers['x-request-id'];
    const requestId = typeof headerId === 'string' && headerId !== '' ? headerId : newId('audit');

    void reply.header('X-Request-Id', requestId);

    const ctx: RequestContext = {
      request_id: requestId,
      ip: request.ip,
      ...(typeof request.headers['user-agent'] === 'string' && {
        user_agent: request.headers['user-agent'],
      }),
      ...(typeof request.headers['idempotency-key'] === 'string' && {
        idempotency_key: request.headers['idempotency-key'],
      }),
    };

    runWithContext(ctx, () => {
      done();
    });
  });

  /**
   * Publish the actor into the request context.
   *
   * A route's auth hook runs after `onRequest`, so the actor is not known when the store is
   * created. Rather than re-entering `runWithContext` (which would fork the async chain and lose
   * everything the handler does afterwards), the store object itself carries a mutable `actor`
   * slot that this hook fills. It is the one mutable field on the context, and it exists so that
   * services can read the actor without ever receiving the request object.
   *
   * Registered as `preHandler`, which Fastify runs AFTER the route's own preHandler array — so
   * requireAuth has already populated `request.actor` by the time this runs.
   */
  app.addHook('preHandler', (request, _reply, done) => {
    if (request.actor !== undefined) setContextActor(request.actor);
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    // One structured line per request. Health checks are excluded or they drown everything else.
    if (!request.url.startsWith('/health') && !request.url.startsWith('/ready')) {
      logger.info(
        {
          method: request.method,
          path: request.url,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
          actor: request.actor?.id,
        },
        'request',
      );
    }
    done();
  });

  // ---- features ----
  // Registered in a deliberate order. Health first so it is reachable even if a later
  // registration throws during boot.
  registerHealth(app);
  registerAuth(app);
  registerTasks(app);
  registerRuns(app);
  registerSecrets(app);
  registerDashboard(app);

  // MUST be last: anything registered after this cannot catch errors.
  registerErrorHandler(app);

  return app;
}
