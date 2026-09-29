import { spawn } from 'node:child_process';
import { basename, isAbsolute, resolve as resolvePath } from 'node:path';

import type { ExprValue } from '@klankish/expr';
import { ERROR_CODES, type ShellStep } from '@klankish/shared';

import { env } from '../../platform/env.js';
import { subLogger } from '../../platform/logger.js';
import type { StepResult } from '../context.js';
import { StepError } from './http.js';

/**
 * The `shell` step.
 *
 * This runs commands on the host, so every line here is a containment decision. The posture:
 *
 *   • OFF by default. A hosted multi-user instance executing arbitrary commands is a different
 *     security model from a personal one, and that must be an explicit choice.
 *   • argv ARRAY, never a shell string. There is no shell, so there is nothing to inject into:
 *     `["git", "status"]` cannot become `git status; rm -rf /`.
 *   • Optional binary allow-list.
 *   • cwd confined to a configured workspace root; traversal rejected.
 *   • Scrubbed environment — the process does NOT inherit DATABASE_URL, JWT_SECRET, or anything
 *     else this server holds.
 *   • Hard timeout with SIGTERM then SIGKILL, killing the whole process GROUP so children do not
 *     survive their parent.
 *   • Output capped, with truncation recorded rather than hidden.
 */

const log = subLogger('shell');

function assertEnabled(): void {
  if (!env.SHELL_STEPS_ENABLED) {
    throw new StepError(
      ERROR_CODES.SHELL_DISABLED,
      'Running commands is turned off on this instance.',
      'set SHELL_STEPS_ENABLED=true to allow it',
    );
  }
}

function assertBinaryAllowed(command: string): void {
  const allowed = env.SHELL_ALLOWED_BINARIES;
  if (allowed.length === 0) return; // empty list = no restriction beyond the master switch

  // Compare on the basename so an absolute path cannot smuggle a different binary past a
  // name-based list.
  const name = basename(command);
  if (!allowed.includes(name)) {
    throw new StepError(
      ERROR_CODES.SHELL_BINARY_NOT_ALLOWED,
      `"${name}" is not on the allowed list.`,
      `allowed: ${allowed.join(', ')}`,
    );
  }
}

function resolveCwd(requested: string | undefined): string | undefined {
  const root = env.SHELL_WORKSPACE_ROOT;

  if (requested === undefined) return root;
  if (root === undefined) {
    // Without a configured root there is nothing to confine against, so an absolute path is
    // refused outright rather than silently permitted.
    if (isAbsolute(requested)) {
      throw new StepError(
        ERROR_CODES.SHELL_PATH_ESCAPE,
        'An absolute working directory needs SHELL_WORKSPACE_ROOT to be configured.',
      );
    }
    return undefined;
  }

  const resolvedRoot = resolvePath(root);
  const target = resolvePath(resolvedRoot, requested);

  // The prefix check uses the root plus a separator: without it, `/workspace-evil` passes a naive
  // `startsWith('/workspace')`.
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}/`)) {
    throw new StepError(
      ERROR_CODES.SHELL_PATH_ESCAPE,
      'That working directory is outside the allowed workspace.',
      `${target} is not under ${resolvedRoot}`,
    );
  }

  return target;
}

/**
 * The environment a command receives.
 *
 * An allow-list built from nothing, not `process.env` with keys deleted — a deny-list forgets the
 * next secret someone adds.
 */
function buildEnv(stepEnv: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
    KLANKISH: '1',
  };
  for (const [k, v] of Object.entries(stepEnv ?? {})) {
    out[k] = String(v);
  }
  return out;
}

export async function executeShell(
  step: ShellStep,
  resolved: Record<string, unknown>,
  timeoutMs: number,
): Promise<StepResult> {
  assertEnabled();

  const command = (resolved['command'] ?? step.command) as unknown[];
  if (!Array.isArray(command) || command.length === 0) {
    throw new StepError(ERROR_CODES.VALIDATION_ERROR, 'A command is required.');
  }

  const argv = command.map((c) => String(c));
  const [bin, ...args] = argv as [string, ...string[]];

  assertBinaryAllowed(bin);
  const cwd = resolveCwd(resolved['cwd'] as string | undefined);

  const started = Date.now();
  const maxBytes = env.SHELL_MAX_OUTPUT_BYTES;

  return new Promise<StepResult>((resolvePromise) => {
    const child = spawn(bin, args, {
      ...(cwd !== undefined && { cwd }),
      env: buildEnv(resolved['env'] as Record<string, string> | undefined),
      // No shell, ever.
      shell: false,
      // Own process group, so the timeout can kill the whole tree rather than orphaning children
      // that keep holding the port or the file.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        // Negative pid = the whole process group.
        process.kill(-child.pid, signal);
      } catch {
        // Already gone. Fall back to the direct kill in case the group call was the thing that
        // failed rather than the process being dead.
        try {
          child.kill(signal);
        } catch {
          /* nothing left to kill */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so the process can clean up, SIGKILL if it ignores that.
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), env.SHELL_KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdout.length < maxBytes) {
        stdout += chunk.toString('utf8');
        if (stdout.length > maxBytes) {
          stdout = stdout.slice(0, maxBytes);
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.length < maxBytes) {
        stderr += chunk.toString('utf8');
        if (stderr.length > maxBytes) {
          stderr = stderr.slice(0, maxBytes);
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });

    const finish = (result: StepResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.on('error', (err) => {
      log.warn({ err, bin }, 'failed to spawn command');
      finish({
        status: 'failed',
        output: { stdout, stderr, duration_ms: Date.now() - started } as ExprValue,
        error: {
          identity: ERROR_CODES.SHELL_NONZERO_EXIT,
          message: `Could not run "${bin}".`,
          detail: err.message,
        },
      });
    });

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - started;
      const exitCode = code ?? -1;

      const output: ExprValue = {
        exit_code: exitCode,
        stdout,
        stderr,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        truncated,
        signal: signal ?? null,
        duration_ms: durationMs,
      };

      if (timedOut) {
        finish({
          status: 'timed_out',
          output,
          error: {
            identity: ERROR_CODES.STEP_TIMEOUT,
            message: `The command did not finish within ${timeoutMs}ms.`,
          },
        });
        return;
      }

      const acceptable = step.allow_exit_codes ?? [0];
      if (!acceptable.includes(exitCode)) {
        finish({
          status: 'failed',
          output,
          error: {
            identity: ERROR_CODES.SHELL_NONZERO_EXIT,
            message: `The command exited with code ${exitCode}.`,
            // stderr's tail is almost always the useful part of a failed command.
            detail: stderr.slice(-500) || stdout.slice(-500),
          },
        });
        return;
      }

      finish({ status: 'succeeded', output });
    });
  });
}
