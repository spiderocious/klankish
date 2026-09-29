import { ChevronDown, ChevronRight, Copy } from '@icons';
import type { StepRunView } from '@klankish/shared';
import { Show } from 'meemaw';
import { useState } from 'react';

import { Button, Flag, RecordId } from '@shared/ui/primitives';
import {
  StepKindMark,
  formatBytes,
  formatDuration,
  stepStatus,
} from '@shared/ui/status';
import { cn } from '@shared/utils/cn';

/**
 * THE STEP ROW — the signature component of the product.
 *
 * Dipstick's reconciliation row, re-columned for a run. The whole design law lives in one line:
 * the step KEY is serif (you named it — a definition), and everything measured is mono (it
 * happened — a record). That single contrast is the system.
 *
 * Expanding a row reveals the resolved input, the output, and the full HTTP exchange — which is
 * the answer to "what actually got sent?", the question this product exists to answer.
 */

export function StepRow({ step, isLast }: { step: StepRunView; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const status = stepStatus(step.status);

  const summary = summarise(step);

  return (
    <div
      className={cn(
        'border-b border-hair',
        isLast && 'border-b-0',
        open && 'bg-sheet-2',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'grid w-full items-baseline gap-3.5 px-4 py-[11px] text-left',
          'grid-cols-[16px_26px_1fr_84px_minmax(120px,1.1fr)_54px_72px]',
          'transition-colors duration-[120ms] hover:bg-sheet',
        )}
      >
        <span className="self-center text-ink-4">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>

        <span className="rec">{String(step.idx).padStart(2, '0')}</span>

        <span className="flex min-w-0 flex-col gap-[2px]">
          {/* DEFINITION: the name you gave it. Serif. */}
          <span className="serif truncate text-sm font-medium text-ink">
            {step.step_name ?? step.step_key}
          </span>
          <span className="rec truncate">{step.step_key}</span>
        </span>

        <span className="flex items-center gap-1.5">
          <StepKindMark kind={step.step_kind} />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3">
            {step.step_kind.replace('_', ' ')}
          </span>
        </span>

        {/* RECORD: what happened. Mono. */}
        <span className="truncate font-mono text-[11px] text-ink-3">{summary}</span>

        <span className="text-right font-mono text-[12px] tabular-nums text-ink-2">
          {step.http?.response_status ?? ''}
        </span>

        <span className="flex items-center justify-end gap-2">
          <span className="font-mono text-[12px] tabular-nums text-ink-2">
            {formatDuration(step.duration_ms)}
          </span>
          <Flag tone={status.tone}>{status.label}</Flag>
        </span>
      </button>

      <Show when={open}>
        <div className="border-t border-hair-soft px-4 pb-5 pt-4">
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Meta label="Step id" value={<RecordId id={step.id} />} />
            <Show when={step.attempt > 1}>
              <Meta
                label="Attempts"
                value={<span className="font-mono text-[11px] text-watch">{step.attempt}</span>}
              />
            </Show>
            <Show when={step.next_step_key !== null}>
              <Meta
                label="Went to"
                value={
                  <span className="font-mono text-[11px] text-ink-2">{step.next_step_key}</span>
                }
              />
            </Show>
          </div>

          {/* A failure is the reason someone opened this row, so it comes first. */}
          <Show when={step.error !== null}>
            <Panel title="Error" tone="fail">
              <p className="mb-1 text-[13px] text-short">{step.error?.message}</p>
              <p className="rec">{step.error?.identity}</p>
              <Show when={step.error?.detail !== undefined}>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-ink-2">
                  {step.error?.detail}
                </pre>
              </Show>
            </Panel>
          </Show>

          <Show when={step.http !== null}>
            <HttpExchange step={step} />
          </Show>

          <div className="grid gap-4 md:grid-cols-2">
            <Show when={step.input !== null && step.input !== undefined}>
              <Panel title="Resolved input">
                <Json value={step.input} />
              </Panel>
            </Show>
            <Show when={step.output !== null && step.output !== undefined}>
              <Panel title="Output">
                <Json value={step.output} />
              </Panel>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function HttpExchange({ step }: { step: StepRunView }) {
  const http = step.http;
  if (http === null) return null;

  return (
    <Panel
      title="HTTP exchange"
      action={
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy size={12} />}
          onClick={() => void navigator.clipboard?.writeText(toCurl(step))}
        >
          Copy as curl
        </Button>
      }
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] font-semibold uppercase text-ink">
          {http.request_method}
        </span>
        <span className="break-all font-mono text-[11px] text-ink-2">{http.request_url}</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1">
        <Meta
          label="Status"
          value={
            <span className="font-mono text-[11px] tabular-nums text-ink-2">
              {http.response_status ?? '—'}
            </span>
          }
        />
        <Meta
          label="Size"
          value={
            <span className="font-mono text-[11px] tabular-nums text-ink-2">
              {formatBytes(http.bytes)}
            </span>
          }
        />
        <Meta
          label="Time"
          value={
            <span className="font-mono text-[11px] tabular-nums text-ink-2">
              {formatDuration(http.duration_ms)}
            </span>
          }
        />
        <Show when={http.truncated}>
          {/* Stated rather than hidden: a record that silently omits part of a body is a record
              that lies about what came back. */}
          <Meta
            label="Body"
            value={<span className="font-mono text-[11px] text-watch">truncated</span>}
          />
        </Show>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="overline mb-1">Request headers</p>
          <Json value={http.request_headers} compact />
        </div>
        <div>
          <p className="overline mb-1">Response headers</p>
          <Json value={http.response_headers} compact />
        </div>
      </div>

      <Show when={http.request_body !== null && http.request_body !== undefined}>
        <div className="mt-3">
          <p className="overline mb-1">Request body</p>
          <Json value={http.request_body} />
        </div>
      </Show>

      <div className="mt-3">
        <p className="overline mb-1">Response body</p>
        <Json value={http.response_body} />
      </div>
    </Panel>
  );
}

function Panel({
  title,
  tone,
  action,
  children,
}: {
  title: string;
  tone?: 'fail';
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'mb-4 rounded-card border bg-sheet px-3.5 py-3',
        tone === 'fail' ? 'border-short-edge bg-short-bg' : 'border-sheet-edge',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="overline">{title}</p>
        {action}
      </div>
      {children}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="overline">{label}</span>
      {value}
    </span>
  );
}

/**
 * A JSON viewer.
 *
 * Deliberately a `<pre>` rather than a collapsible tree: the payloads here are usually small, and
 * plain text is selectable, searchable with the browser's own find, and copy-pastes correctly.
 * Very large values are capped so one enormous response cannot lock the tab.
 */
function Json({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, compact ? 0 : 2) ?? 'null';
  const LIMIT = 20_000;
  const shown = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n… (${text.length - LIMIT} more characters)` : text;

  return (
    <pre
      className={cn(
        'overflow-x-auto rounded-sharp bg-paper-deep px-2.5 py-2',
        'font-mono text-[11px] leading-relaxed text-ink-2',
        compact ? 'max-h-32' : 'max-h-96',
        'overflow-y-auto whitespace-pre-wrap break-all',
      )}
    >
      {shown}
    </pre>
  );
}

/** One-line summary shown on the collapsed row: the most useful fact per step kind. */
function summarise(step: StepRunView): string {
  if (step.http !== null) {
    try {
      const url = new URL(step.http.request_url);
      return `${url.hostname}${url.pathname}`;
    } catch {
      return step.http.request_url.slice(0, 60);
    }
  }

  const out = step.output as Record<string, unknown> | null;
  if (out === null || typeof out !== 'object') return '';

  if (step.step_kind === 'branch') {
    return out['matched'] === true ? `matched → ${step.next_step_key ?? ''}` : 'no match';
  }
  if (step.step_kind === 'shell') {
    return `exit ${String(out['exit_code'] ?? '?')}`;
  }
  if (step.step_kind === 'transform') {
    return Object.keys(out).slice(0, 3).join(', ');
  }
  if (step.step_kind === 'delay') {
    return `waited ${formatDuration(Number(out['waited_ms'] ?? 0))}`;
  }
  if (step.step_kind === 'assert') {
    return out['held'] === true ? 'held' : 'did not hold';
  }
  return '';
}

/**
 * Rebuild the request as a curl command.
 *
 * Note that this reproduces the REDACTED record, not the original secret — so a copied command
 * needs the real token substituted. That is the correct trade: a curl line that carries a live
 * credential is one paste away from a chat log.
 */
function toCurl(step: StepRunView): string {
  const http = step.http;
  if (http === null) return '';

  const parts = [`curl -X ${http.request_method} '${http.request_url}'`];
  for (const [k, v] of Object.entries(http.request_headers)) {
    parts.push(`  -H '${k}: ${v}'`);
  }
  if (http.request_body !== null && http.request_body !== undefined) {
    const body =
      typeof http.request_body === 'string'
        ? http.request_body
        : JSON.stringify(http.request_body);
    parts.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n');
}
