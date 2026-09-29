import { ArrowLeft, Ban, RotateCcw } from '@icons';
import { Repeat, Show } from 'meemaw';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ROUTES } from '@shared/constants/routes';
import {
  Button,
  ErrorState,
  LoadingState,
  PageHeader,
  Readout,
  RecordId,
  Sheet,
} from '@shared/ui/primitives';
import {
  RunStatusFlag,
  formatAbsolute,
  formatDuration,
  formatRelative,
} from '@shared/ui/status';
import { list } from '@shared/utils/list';
import { ApiError } from '@shared/api/client';

import { useCancelRun, useRetryRun, useRun } from '../api/use-runs';
import { StepRow } from './parts/step-row';

/**
 * THE RUN INSPECTOR.
 *
 * The screen the whole product is built around, and the reason it was built third rather than
 * last: everything else gets debugged through it.
 *
 * It answers, in order: did it work, how long did it take, which step did what, what was sent,
 * what came back, and why did the engine go where it went.
 */
export default function RunDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading, error, refetch } = useRun(id);
  const cancel = useCancelRun();
  const retry = useRetryRun();

  if (isLoading) return <LoadingState label="Loading run…" />;

  if (error !== null) {
    // Render the envelope's RESOLVED message — never our own invented copy, and never the raw
    // error identity, which is for a `switch` rather than for a person.
    const message =
      error instanceof ApiError ? error.displayMessage : 'That run could not be loaded.';
    return <ErrorState message={message} onRetry={() => void refetch()} />;
  }

  if (run === undefined) return <ErrorState message="That run does not exist." />;

  const isLive = run.status === 'running' || run.status === 'queued';
  const failedStep = run.steps.find((s) => s.status === 'failed' || s.status === 'timed_out');

  return (
    <div className="mx-auto max-w-[1100px]">
      <Link
        to={ROUTES.RUNS.LIST}
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-ink-3 transition-colors duration-[120ms] hover:text-ink"
      >
        <ArrowLeft size={13} />
        All runs
      </Link>

      <PageHeader
        title={run.task_name}
        subtitle={`Version ${run.task_version} · triggered ${run.trigger}`}
        meta={<RecordId id={run.id} />}
        actions={
          <>
            <Show when={isLive}>
              <Button
                size="sm"
                variant="danger"
                icon={<Ban size={13} />}
                loading={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                Cancel
              </Button>
            </Show>
            <Show when={!isLive}>
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCcw size={13} />}
                loading={retry.isPending}
                onClick={() =>
                  retry.mutate(run.id, {
                    onSuccess: (d) => navigate(ROUTES.RUNS.detail(d.run_id)),
                  })
                }
              >
                Retry
              </Button>
            </Show>
            <Link to={ROUTES.TASKS.detail(run.task_id)}>
              <Button size="sm" variant="ghost">
                View task
              </Button>
            </Link>
          </>
        }
      />

      {/* ---- the headline facts ---- */}
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-sheet-edge bg-sheet-edge md:grid-cols-4">
        <Stat label="Status">
          <RunStatusFlag status={run.status} />
        </Stat>
        <Stat label="Duration">
          <Readout size="sm" value={formatDuration(run.duration_ms)} />
        </Stat>
        <Stat label="Steps">
          <Readout
            size="sm"
            value={`${run.steps_succeeded}/${run.step_count}`}
            tone={run.steps_failed > 0 ? 'fail' : undefined}
          />
        </Stat>
        <Stat
          label="Queue latency"
          // The gap between due and picked up. Surfaced because a growing value is the earliest
          // sign that workers are saturated, and it is invisible if you only record duration.
          hint="Time between being due and a worker picking it up"
        >
          <Readout size="sm" value={formatDuration(run.queue_latency_ms)} />
        </Stat>
      </div>

      {/* ---- failure banner ---- */}
      <Show when={run.error_message !== null}>
        <Sheet className="mb-6 border-short-edge bg-short-bg" padding="tight">
          <p className="mb-1 text-[13px] font-medium text-short">{run.error_message}</p>
          <p className="rec">
            {run.error_identity}
            <Show when={failedStep !== undefined}>
              {' · failed at step '}
              <span className="text-ink-2">{failedStep?.step_key}</span>
            </Show>
          </p>
        </Sheet>
      </Show>

      {/* ---- timing ---- */}
      <div className="mb-6 flex flex-wrap gap-x-8 gap-y-2 border-b border-hair pb-4">
        <Timing label="Scheduled for" iso={run.scheduled_for} />
        <Timing label="Started" iso={run.started_at} />
        <Timing label="Finished" iso={run.finished_at} />
        <Show when={run.attempt > 1}>
          <span className="flex items-baseline gap-1.5">
            <span className="overline">Attempt</span>
            <span className="font-mono text-[12px] text-watch">{run.attempt}</span>
          </span>
        </Show>
      </div>

      {/* ---- the step ledger ---- */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="serif text-[17px] font-semibold text-ink">Steps</h2>
        <Show when={isLive}>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <span className="pulse" />
            Live — updating as it runs
          </span>
        </Show>
      </div>

      <Show
        when={run.steps.length > 0}
        fallback={
          <Sheet padding="lg">
            <p className="text-center text-[13px] text-ink-3">
              {run.status === 'queued'
                ? 'Waiting for a worker to pick this up.'
                : run.status === 'skipped'
                  ? 'This run was skipped, so no steps were executed.'
                  : 'No steps were recorded.'}
            </p>
          </Sheet>
        }
      >
        <div className="overflow-hidden rounded-card border border-sheet-edge bg-sheet">
          <div className="border-b border-ink bg-sheet-2 px-4 py-2">
            <div className="grid grid-cols-[16px_26px_1fr_84px_minmax(120px,1.1fr)_54px_72px] items-baseline gap-3.5">
              <span />
              <span className="overline">#</span>
              <span className="overline">Step</span>
              <span className="overline">Kind</span>
              <span className="overline">Detail</span>
              <span className="overline text-right">Code</span>
              <span className="overline text-right">Time</span>
            </div>
          </div>
          <Repeat each={list(run.steps)}>
            {(step, i) => (
              <StepRow key={step.id} step={step} isLast={i === run.steps.length - 1} />
            )}
          </Repeat>
        </div>
      </Show>

      {/* ---- run variables ---- */}
      <Show when={Object.keys(run.vars).length > 0}>
        <div className="mt-6">
          <p className="overline mb-2">Run variables</p>
          <pre className="overflow-x-auto rounded-card border border-sheet-edge bg-sheet px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
            {JSON.stringify(run.vars, null, 2)}
          </pre>
        </div>
      </Show>
    </div>
  );
}

function Stat({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-sheet px-4 py-3.5" title={hint}>
      <p className="overline mb-1.5">{label}</p>
      {children}
    </div>
  );
}

function Timing({ label, iso }: { label: string; iso: string | null }) {
  return (
    <span className="flex items-baseline gap-1.5" title={formatAbsolute(iso)}>
      <span className="overline">{label}</span>
      <span className="font-mono text-[12px] text-ink-2">{formatRelative(iso)}</span>
    </span>
  );
}
