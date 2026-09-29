import { ArrowLeft, Edit3, Pause, Play, Zap } from '@icons';
import { Repeat, Show } from 'meemaw';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ROUTES } from '@shared/constants/routes';
import {
  Button, EmptyState, ErrorState, LoadingState, PageHeader, Pill, Readout, RecordId, Sheet,
  Table, Td, Th,
} from '@shared/ui/primitives';
import {
  RunStatusFlag, formatDuration, formatRate, formatRelative,
} from '@shared/ui/status';
import { list } from '@shared/utils/list';

import { useRuns } from '@features/runs/api/use-runs';
import { useRunTask, useSetTaskStatus, useTask, useTaskVersions } from '../api/use-tasks';

export default function TaskDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading, error } = useTask(id);
  const { data: runs } = useRuns({ ...(id !== undefined && { taskId: id }), limit: 20 });
  const { data: versions } = useTaskVersions(id);
  const runTask = useRunTask();
  const setStatus = useSetTaskStatus();

  if (isLoading) return <LoadingState />;
  if (error !== null || task === undefined) {
    return <ErrorState message="That task could not be loaded." />;
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <Link to={ROUTES.TASKS.LIST} className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink">
        <ArrowLeft size={13} /> All tasks
      </Link>

      <PageHeader
        title={task.name}
        subtitle={task.description ?? undefined}
        meta={<RecordId id={task.id} />}
        actions={
          <>
            <Button
              size="sm" variant="primary" icon={<Zap size={13} />}
              loading={runTask.isPending}
              onClick={() => runTask.mutate({ id: task.id }, {
                onSuccess: (d) => navigate(ROUTES.RUNS.detail(d.run_id)),
              })}
            >
              Run now
            </Button>
            <Button
              size="sm" variant="ghost"
              icon={task.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}
              onClick={() => setStatus.mutate({
                id: task.id, action: task.status === 'paused' ? 'resume' : 'pause',
              })}
            >
              {task.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Link to={ROUTES.TASKS.edit(task.id)}>
              <Button size="sm" variant="ghost" icon={<Edit3 size={13} />}>Edit</Button>
            </Link>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-sheet-edge bg-sheet-edge md:grid-cols-4">
        <div className="bg-sheet px-4 py-3.5">
          <p className="overline mb-1.5">Status</p>
          <Pill tone={task.status === 'active' ? 'ok' : 'muted'}>{task.status}</Pill>
        </div>
        <div className="bg-sheet px-4 py-3.5">
          <p className="overline mb-1.5">Runs</p>
          <Readout size="sm" value={task.stats?.runs_total ?? 0} />
        </div>
        <div className="bg-sheet px-4 py-3.5">
          <p className="overline mb-1.5">Success</p>
          <Readout size="sm" value={formatRate(task.stats?.success_rate ?? null)} />
        </div>
        <div className="bg-sheet px-4 py-3.5">
          <p className="overline mb-1.5">p95</p>
          <Readout size="sm" value={formatDuration(task.stats?.p95_duration_ms ?? null)} />
        </div>
      </div>

      <Show when={task.schedule !== null}>
        <Sheet className="mb-6" padding="tight">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="flex items-baseline gap-1.5">
              <span className="overline">Schedule</span>
              <span className="text-[13px] text-ink-2">{task.schedule?.description}</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="overline">Next</span>
              <span className="rec">{formatRelative(task.schedule?.next_fire_at ?? null)}</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="overline">Version</span>
              <span className="rec">v{task.current_version} · {task.step_count} steps</span>
            </span>
          </div>
        </Sheet>
      </Show>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="serif text-[17px] font-semibold text-ink">Runs</h2>
        <Show when={versions !== undefined && versions.length > 1}>
          <span className="rec">{versions?.length} versions</span>
        </Show>
      </div>

      <Show
        when={(runs?.items.length ?? 0) > 0}
        fallback={
          <Sheet padding="lg">
            <EmptyState
              title="No runs yet"
              description="Run it once and everything it does will be recorded here."
            />
          </Sheet>
        }
      >
        <Sheet padding="none">
          <div className="px-5 pt-4">
            <Table caption={`Runs of ${task.name}`}>
              <thead>
                <tr>
                  <Th>Run</Th><Th>Trigger</Th>
                  <Th align="right">Steps</Th><Th align="right">Duration</Th>
                  <Th align="right">When</Th><Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                <Repeat each={list(runs?.items)}>
                  {(run) => (
                    <tr key={run.id} className="transition-colors hover:bg-sheet-2">
                      <Td>
                        <Link to={ROUTES.RUNS.detail(run.id)} className="rec hover:text-ink">
                          {run.id}
                        </Link>
                      </Td>
                      <Td><span className="rec">{run.trigger}</span></Td>
                      <Td align="right" mono>{run.steps_succeeded}/{run.step_count}</Td>
                      <Td align="right" mono>{formatDuration(run.duration_ms)}</Td>
                      <Td align="right" mono className="text-ink-3">{formatRelative(run.created_at)}</Td>
                      <Td align="right"><RunStatusFlag status={run.status} /></Td>
                    </tr>
                  )}
                </Repeat>
              </tbody>
            </Table>
          </div>
        </Sheet>
      </Show>
    </div>
  );
}
