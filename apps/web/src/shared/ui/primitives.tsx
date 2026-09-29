import { Loader2 } from '@icons';
import type { ReactNode } from 'react';

import { cn } from '../utils/cn.js';

/**
 * The component vocabulary, in the ledger-broadsheet stance.
 *
 * Two rules from the design law show up in almost every component here:
 *   • Hairlines, never shadows. This is paper. The only exception is an overlay that genuinely
 *     floats (a modal, the command palette).
 *   • Any measured value is mono and tabular. Any named intention is serif. A serif never states
 *     a number; a mono figure never states a name.
 */

// ---------------------------------------------------------------------------
// Sheet — the only "card" idiom
// ---------------------------------------------------------------------------

export function Sheet({
  children,
  className,
  padding = 'md',
  recessed = false,
}: {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'tight' | 'md' | 'lg';
  recessed?: boolean;
}) {
  return (
    <div
      className={cn(
        'border border-sheet-edge rounded-card',
        recessed ? 'bg-sheet-2' : 'bg-sheet',
        padding === 'tight' && 'px-[18px] py-[14px]',
        padding === 'md' && 'px-6 py-5',
        padding === 'lg' && 'px-8 py-7',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      // A loading button stays disabled: a double-submit on a mutation is a real duplicate, and
      // the idempotency key only protects the ones that carry it.
      disabled={disabled === true || loading}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-soft border font-medium',
        'transition-colors duration-[120ms] disabled:opacity-45 disabled:pointer-events-none',
        size === 'sm' && 'h-[26px] px-2.5 text-xs',
        size === 'md' && 'h-8 px-3.5 text-[13px]',
        size === 'lg' && 'h-10 px-[18px] text-sm',
        variant === 'primary' &&
          'bg-emerald-600 border-emerald-600 text-paper hover:bg-emerald-700 hover:border-emerald-700',
        variant === 'secondary' &&
          'bg-transparent border-ink text-ink hover:bg-ink hover:text-paper',
        variant === 'quiet' &&
          'bg-transparent border-transparent text-ink-2 hover:bg-hair-soft hover:text-ink',
        variant === 'danger' &&
          'bg-transparent border-short text-short hover:bg-short-bg',
        variant === 'ghost' &&
          'bg-transparent border-hair text-ink-3 hover:border-ink hover:text-ink',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  // `| undefined` is explicit because exactOptionalPropertyTypes distinguishes "absent" from
  // "present and undefined", and `error={maybeUndefined}` is ordinary React.
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label !== undefined && (
        <label className="text-[11px] font-semibold text-ink-2 tracking-[0.01em]">
          {label}
          {required === true && <span className="text-short ml-0.5">*</span>}
        </label>
      )}
      {children}
      {/* Error takes precedence over hint: showing both competes for the same glance. */}
      {error !== undefined ? (
        <span className="text-[11px] text-short">{error}</span>
      ) : hint !== undefined ? (
        <span className="text-[11px] text-ink-3">{hint}</span>
      ) : null}
    </div>
  );
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Mono for anything that is a RECORD value: an id, a cron expression, a URL. */
  mono?: boolean;
}

export function Input({ invalid, mono, className, ...rest }: InputProps) {
  return (
    <input
      className={cn(
        'h-[34px] w-full rounded-card border bg-sheet px-[11px] text-[13px] text-ink',
        'outline-none transition-colors duration-[120ms] placeholder:text-ink-4',
        'hover:border-ink-4 focus:border-ink',
        mono === true && 'font-mono tabular-nums',
        invalid === true ? 'border-short' : 'border-sheet-edge',
        className,
      )}
      {...rest}
    />
  );
}

export function Textarea({
  invalid,
  mono,
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean }) {
  return (
    <textarea
      className={cn(
        'w-full rounded-card border bg-sheet px-[11px] py-2 text-[13px] text-ink',
        'outline-none transition-colors duration-[120ms] placeholder:text-ink-4',
        'hover:border-ink-4 focus:border-ink',
        mono === true && 'font-mono',
        invalid === true ? 'border-short' : 'border-sheet-edge',
        className,
      )}
      {...rest}
    />
  );
}

export function Select({
  invalid,
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={cn(
        'h-[34px] w-full rounded-card border bg-sheet px-2.5 text-[13px] text-ink',
        'outline-none transition-colors duration-[120ms] hover:border-ink-4 focus:border-ink',
        invalid === true ? 'border-short' : 'border-sheet-edge',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Status vocabulary — ONE mapping, used everywhere
// ---------------------------------------------------------------------------

export type StatusTone = 'ok' | 'fail' | 'watch' | 'info' | 'muted' | 'running';

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: 'text-emerald-700 border-emerald-200 bg-emerald-50',
  fail: 'text-short border-short-edge bg-short-bg',
  watch: 'text-watch border-watch-edge bg-watch-bg',
  info: 'text-info border-info-edge bg-info-bg',
  muted: 'text-ink-3 border-sheet-edge bg-paper-deep',
  running: 'text-emerald-700 border-emerald-200 bg-emerald-50',
};

/**
 * A status flag.
 *
 * Always carries TEXT, never colour alone — a red dot and a green dot are identical to a
 * deuteranopic reader, while FAILED and ✓ are not.
 */
export function Flag({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sharp border px-1.5 py-px',
        'font-mono text-[10px] font-semibold uppercase tracking-[0.04em]',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {tone === 'running' && <span className="pulse" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Pill({
  tone = 'muted',
  children,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1.5 rounded-[var(--r-pill)] border px-2',
        'text-[11px] font-medium tracking-[0.01em]',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Record primitives — RECORD side of the law
// ---------------------------------------------------------------------------

/** A record id. Always mono, always muted, always copyable. */
export function RecordId({ id, className }: { id: string; className?: string }) {
  return (
    <button
      type="button"
      title={`${id} — click to copy`}
      onClick={() => {
        void navigator.clipboard?.writeText(id);
      }}
      className={cn(
        'rec cursor-pointer hover:text-ink transition-colors duration-[120ms]',
        className,
      )}
    >
      {id}
    </button>
  );
}

/** A hero number. Mono even when it is an aggregate — see the note in design-guide.md. */
export function Readout({
  value,
  unit,
  size = 'md',
  tone,
  className,
}: {
  value: string | number;
  unit?: string | undefined;
  size?: 'sm' | 'md' | 'lg' | 'xl' | undefined;
  tone?: 'ok' | 'fail' | 'watch' | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        'read',
        `read-${size}`,
        tone === 'ok' && 'text-emerald-700',
        tone === 'fail' && 'text-short',
        tone === 'watch' && 'text-watch',
        className,
      )}
    >
      {value}
      {unit !== undefined && <span className="u">{unit}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/** The page stamp: a heavy ink rule under a serif title, as on a printed sheet. */
export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
}: {
  title: string;
  subtitle?: string | undefined;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex items-baseline gap-4 border-b border-ink pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="serif text-[26px] font-semibold leading-tight text-ink">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-1 text-[13px] text-ink-3">{subtitle}</p>
        )}
      </div>
      {meta !== undefined && <div className="rec shrink-0">{meta}</div>}
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionBreak({ label }: { label: string }) {
  return (
    <div className="my-8 flex items-center gap-4">
      <span className="h-px w-6 shrink-0 bg-hair" />
      <span className="overline shrink-0">{label}</span>
      <span className="h-px flex-1 bg-hair" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// States — every screen must handle all three
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      size={16}
      className={cn('animate-spin text-ink-3', className)}
      aria-label="Loading"
    />
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-3">
      <Spinner />
      {label}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon !== undefined && <div className="text-ink-4">{icon}</div>}
      <p className="serif text-[17px] font-medium text-ink">{title}</p>
      {description !== undefined && (
        <p className="max-w-sm text-[13px] leading-relaxed text-ink-3">{description}</p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}

/**
 * An error state.
 *
 * Takes the RESOLVED message from the envelope. It never composes its own copy for a known
 * failure, and it never renders a raw error identity — `insufficient_role` is for a `switch`,
 * not for a person.
 */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-[13px] text-short">{message}</p>
      {onRetry !== undefined && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table — real semantics, because the step list IS a table
// ---------------------------------------------------------------------------

export function Table({
  caption,
  children,
  className,
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <table className={cn('w-full border-collapse', className)}>
      {/* Present for screen readers; visually hidden because the page header already names it. */}
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}

export function Th({
  children,
  align = 'left',
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'overline border-b border-ink pb-2 pt-0',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  mono,
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-b border-hair py-2.5 text-[13px] text-ink-2',
        mono === true && 'font-mono tabular-nums',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}
