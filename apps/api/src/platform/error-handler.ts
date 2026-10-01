import {
  ERROR_CODES,
  resolveErrorMessage,
  severityFor,
  type ErrorEnvelope,
} from '@klankish/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getRequestId } from './context.js';
import { isProd } from './env.js';
import { logger } from './logger.js';
import { AppError } from './result.js';

/**
 * The ONE place an error becomes a response.
 *
 * Every error — thrown AppError, Fastify validation failure, malformed JSON, unexpected crash —
 * lands here and leaves in the same three-field envelope. Nothing else in the codebase builds an
 * error body.
 */

interface FastifyValidationIssue {
  readonly instancePath?: string;
  readonly params?: { readonly missingProperty?: string };
  readonly message?: string;
}

/**
 * Map Fastify/Ajv validation output to per-field errors.
 *
 * Policy, decided ONCE and applied identically here and in the route schemas: return ALL invalid
 * fields, not just the first. A multi-step task builder showing one error at a time, then five
 * more on the next submit, is hostile. (This requires `allErrors: true` in the Ajv config — see
 * app.ts, where it is set for exactly this reason.)
 */
function fieldErrorsFrom(validation: readonly FastifyValidationIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of validation) {
    const fromPath = issue.instancePath?.replace(/^\//, '').replace(/\//g, '.');
    const field =
      fromPath !== undefined && fromPath !== ''
        ? fromPath
        : (issue.params?.missingProperty ?? '_');
    const message = issue.message ?? 'is not valid';
    (out[field] ??= []).push(capitalise(message));
  }
  return out;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function isFastifyError(err: unknown): err is FastifyError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/**
 * Where the built SPA lives, once `registerWebServing` has found it.
 *
 * Held here because Fastify allows exactly ONE notFoundHandler per instance, so the SPA fallback
 * and the JSON 404 must be the same function. Keeping both in one place also means there is only
 * one implementation of the error envelope.
 */
let spaRoot: string | null = null;

export function setSpaRoot(root: string | null): void {
  spaRoot = root;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const request_id = getRequestId();

    // --- our own errors ---
    if (err instanceof AppError) {
      // Domain failures are expected. warn, not error: they are not incidents, and logging them
      // at error level trains everyone to ignore the error log.
      logger.warn(
        {
          request_id,
          reason: err.reason,
          rejection: err.rejection,
          status: err.httpStatus,
          path: request.url,
        },
        'request failed',
      );

      if (err.retryAfter !== undefined) {
        void reply.header('Retry-After', String(err.retryAfter));
      }

      const envelope: ErrorEnvelope = {
        error: {
          reason: err.reason,
          // Resolved display text — never err.message, which is the internal diagnostic.
          message: err.displayMessage,
          severity: err.severity,
          ...(err.fieldErrors !== undefined && { fieldErrors: err.fieldErrors }),
          ...(err.rejection !== undefined && { rejection: err.rejection }),
          ...(request_id !== undefined && { request_id }),
          ...(err.retryAfter !== undefined && { retry_after: err.retryAfter }),
        },
      };
      void reply.code(err.httpStatus).send(envelope);
      return;
    }

    // --- framework errors ---
    if (isFastifyError(err)) {
      // Schema validation
      if (err.validation !== undefined && Array.isArray(err.validation)) {
        const fieldErrors = fieldErrorsFrom(err.validation as FastifyValidationIssue[]);
        logger.warn({ request_id, fieldErrors, path: request.url }, 'validation failed');
        void reply.code(422).send({
          error: {
            reason: ERROR_CODES.VALIDATION_ERROR,
            message: resolveErrorMessage(ERROR_CODES.VALIDATION_ERROR),
            severity: severityFor(ERROR_CODES.VALIDATION_ERROR),
            fieldErrors,
            ...(request_id !== undefined && { request_id }),
          },
        } satisfies ErrorEnvelope);
        return;
      }

      // Malformed JSON is a CLIENT error. Letting a body-parser SyntaxError fall through to the
      // generic handler returns 500 and inflates the error-rate alarm for what is really a 400.
      if (
        err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
        err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
        err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
        err instanceof SyntaxError
      ) {
        const tooLarge = err.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
        const reason = tooLarge ? ERROR_CODES.PAYLOAD_TOO_LARGE : ERROR_CODES.MALFORMED_JSON;
        void reply.code(tooLarge ? 413 : 400).send({
          error: {
            reason,
            message: resolveErrorMessage(reason),
            severity: severityFor(reason),
            ...(request_id !== undefined && { request_id }),
          },
        } satisfies ErrorEnvelope);
        return;
      }

      if (err.statusCode === 404) {
        void reply.code(404).send({
          error: {
            reason: ERROR_CODES.NOT_FOUND,
            message: resolveErrorMessage(ERROR_CODES.NOT_FOUND),
            severity: severityFor(ERROR_CODES.NOT_FOUND),
            ...(request_id !== undefined && { request_id }),
          },
        } satisfies ErrorEnvelope);
        return;
      }
    }

    // --- genuinely unexpected ---
    logger.error({ err, request_id, path: request.url, method: request.method }, 'unhandled error');

    void reply.code(500).send({
      error: {
        reason: ERROR_CODES.INTERNAL_ERROR,
        message: resolveErrorMessage(ERROR_CODES.INTERNAL_ERROR),
        severity: severityFor(ERROR_CODES.INTERNAL_ERROR),
        ...(request_id !== undefined && { request_id }),
        // Internals leak only outside production, where they save debugging time.
        ...(!isProd && err instanceof Error && { rejection: err.message }),
      },
    } satisfies ErrorEnvelope);
  });

  // An unmatched route must return the same envelope shape as everything else, or clients need
  // two parsers — UNLESS it is a browser navigation to a client-side route, which has no file on
  // disk and must receive the SPA shell instead.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const isApi =
      request.url.startsWith('/api/') ||
      request.url.startsWith('/health') ||
      request.url.startsWith('/ready') ||
      request.url.startsWith('/docs') ||
      request.url.startsWith('/metrics');

    const wantsHtml = (request.headers.accept ?? '').includes('text/html');

    // A hard refresh on /runs/r_01HV… must serve the shell, not a 404. A typo'd /api/ path must
    // still get the envelope, or a client would try to parse HTML as JSON.
    if (spaRoot !== null && !isApi && request.method === 'GET' && wantsHtml) {
      void reply.type('text/html').sendFile('index.html');
      return;
    }

    const request_id = getRequestId();
    void reply.code(404).send({
      error: {
        reason: ERROR_CODES.NOT_FOUND,
        message: `No route for ${request.method} ${request.url}`,
        severity: severityFor(ERROR_CODES.NOT_FOUND),
        ...(request_id !== undefined && { request_id }),
      },
    } satisfies ErrorEnvelope);
  });
}
