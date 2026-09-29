import { LOG_REDACT_PATHS } from '@klankish/shared';
import pino from 'pino';

import { env, isDev } from './env.js';

/**
 * The structured logger.
 *
 * `console.log` is banned by lint (`no-console: error`) because console output is never
 * structured, never redacted, and never machine-parseable — and this is a product whose entire
 * value proposition is a readable record of what happened.
 *
 * Redaction here is the LAST line of defence, not the first. Step inputs are already redacted
 * before they are persisted; these paths catch anything that reaches a log by another route.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [...LOG_REDACT_PATHS],
    censor: '[REDACTED]',
  },
  base: {
    role: env.PROCESS_ROLE,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,role',
        singleLine: false,
      },
    },
  }),
});

/** A child logger tagged with a subsystem name, so engine logs are filterable from HTTP logs. */
export function subLogger(name: string): pino.Logger {
  return logger.child({ subsystem: name });
}
