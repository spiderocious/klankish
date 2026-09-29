import type { RunStatus, StepKind, StepRunStatus } from '@klankish/shared';

import { cn } from '../utils/cn.js';
import { Flag, type StatusTone } from './primitives.js';

/**
 * The status vocabulary — ONE mapping, used by every screen.
 *
 * Centralised so that a run shown as "FAILED" in the list cannot appear as "Error" in the
 * inspector. Divergent status labels across screens are how a user stops trusting the record.
 *
 * Every entry carries a LABEL as well as a tone: status is never conveyed by colour alone.
 */

interface StatusDescriptor {
  readonly label: string;
  readonly tone: StatusTone;
}

const RUN_STATUS: Record<RunStatus, StatusDescriptor> = {
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Running', tone: 'running' },
  succeeded: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'fail' },
  timed_out: { label: 'Timed out', tone: 'fail' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  // Not a failure: the concurrency policy declined to start it. Recorded so the skip is visible
  // rather than looking like a schedule that never fired.
  skipped: { label: 'Skipped', tone: 'muted' },
};

const STEP_STATUS: Record<StepRunStatus, StatusDescriptor> = {
  pending: { label: 'Pending', tone: 'muted' },
  running: { label: 'Running', tone: 'running' },
  succeeded: { label: 'OK', tone: 'ok' },
  failed: { label: 'Failed', tone: 'fail' },
  timed_out: { label: 'Timeout', tone: 'fail' },
  skipped: { label: 'Skipped', tone: 'muted' },
};

export function runStatus(status: RunStatus): StatusDescriptor {
  return RUN_STATUS[status] ?? { label: status, tone: 'muted' };
}

export function stepStatus(status: StepRunStatus): StatusDescriptor {
  return STEP_STATUS[status] ?? { label: status, tone: 'muted' };
}

export function RunStatusFlag({ status }: { status: RunStatus }) {
  const s = runStatus(status);
  return <Flag tone={s.tone}>{s.label}</Flag>;
}

export function StepStatusFlag({ status }: { status: StepRunStatus }) {
  const s = stepStatus(status);
  return <Flag tone={s.tone}>{s.label}</Flag>;
}

/**
 * The step-kind mark.
 *
 * A tiny inline square, never a fill — inherited from dipstick's product marks, where the rule was
 * that a category is a quiet typographic dot rather than chromatic billing.
 */
const KIND_VAR: Record<string, string> = {
  http: 'var(--k-http)',
  shell: 'var(--k-shell)',
  branch: 'var(--k-branch)',
  transform: 'var(--k-transform)',
  email: 'var(--k-email)',
  storage_put: 'var(--k-storage)',
  storage_get: 'var(--k-storage)',
  webhook: 'var(--k-http)',
  assert: 'var(--k-assert)',
  delay: 'var(--k-assert)',
  noop: 'var(--k-assert)',
  subtask: 'var(--k-transform)',
};

export function StepKindMark({ kind, className }: { kind: StepKind | string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-[7px] w-[7px] rounded-[1px] shrink-0', className)}
      style={{ background: KIND_VAR[kind] ?? 'var(--ink-3)' }}
    />
  );
}

export function StepKindLabel({ kind }: { kind: StepKind | string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">
      <StepKindMark kind={kind} />
      {kind.replace('_', ' ')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatters — every figure in the product goes through one of these
// ---------------------------------------------------------------------------

/** Durations read as a person would say them, not as raw milliseconds. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Relative time for recency, absolute on hover — the timestamp itself is the record. */
export function formatRelative(iso: string | null): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const future = diff < 0;

  const say = (n: number, unit: string): string =>
    future ? `in ${n}${unit}` : `${n}${unit} ago`;

  if (abs < 10_000) return future ? 'in a moment' : 'just now';
  if (abs < 60_000) return say(Math.round(abs / 1000), 's');
  if (abs < 3_600_000) return say(Math.round(abs / 60_000), 'm');
  if (abs < 86_400_000) return say(Math.round(abs / 3_600_000), 'h');
  if (abs < 2_592_000_000) return say(Math.round(abs / 86_400_000), 'd');
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatAbsolute(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** A success rate. NULL means "no runs yet" and must not render as 0%. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}
