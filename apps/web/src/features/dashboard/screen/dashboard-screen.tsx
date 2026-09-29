import type { DashboardView } from '@klankish/shared';
import { useQuery } from '@tanstack/react-query';
import { Repeat, Show } from 'meemaw';
import { Link } from 'react-router-dom';

import { api } from '@shared/api/client';
import { EP } from '@shared/constants/endpoints';
import { ROUTES } from '@shared/constants/routes';
import {
  EmptyState,
  LoadingState,
  PageHeader,
  Readout,
  Sheet,
  Table,
  Td,
  Th,
} from '@shared/ui/primitives';
import {
  RunStatusFlag,
  formatDuration,
  formatRate,
  formatRelative,
} from '@shared/ui/status';
import { list } from '@shared/utils/list';

/**
 * The dashboard.
 *
 * Information architecture follows the reference the user supplied — a strip of stat tiles, a
 * three-column middle row, then a wide activity table with a right rail. The material is the
 * ledger stance: hairline-bordered sheets rather than soft-shadow cards, mono numerals, serif
 * names.
 */
export default function DashboardScreen() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async (): Promise<DashboardView> => {
      const { data } = await api.get<DashboardView>(EP.DASHBOARD);
      return data;
    },
    // The queue moves while you watch it, so this refreshes — but slowly enough not to be noise.
    refetchInterval: 10_000,
  });

  if (isLoading) return <LoadingState />;
  if (data === undefined) return <EmptyState title="Nothing to show yet." />;

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader
        title="Dashboard"
        subtitle="What ran, what is running, and what is due next."
      />

      {/* ---- stat strip ---- */}
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-sheet-edge bg-sheet-edge md:grid-cols-5">
        <StatTile label="Tasks" value={data.tasks_total} sub={`${data.tasks_active} active`} />
        <StatTile label="Runs today" value={data.runs_today} sub={`${data.runs_failed_today} failed`} />
        <StatTile
          label="Success rate"
          value={formatRate(data.success_rate_today)}
          tone={
            data.success_rate_today === null
              ? undefined
              : data.success_rate_today >= 0.95
                ? 'ok'
                : data.success_rate_today >= 0.8
                  ? 'watch'
                  : 'fail'
          }
        />
        <StatTile label="p95 duration" value={formatDuration(data.p95_duration_ms)} />
        <StatTile
          label="Queue"
          value={data.queue.queued}
          sub={`${data.queue.running} running`}
          tone={data.queue.stuck_leases > 0 ? 'watch' : undefined}
        />
      </div>

      {/* ---- queue health, stated plainly when something is wrong ---- */}
      <Show when={data.queue.stuck_leases > 0}>
        <Sheet className="mb-6 border-watch-edge bg-watch-bg" padding="tight">
          <p className="text-[13px] text-watch">
            {data.queue.stuck_leases} run{data.queue.stuck_leases === 1 ? '' : 's'} held by a worker
            that stopped responding. The reaper will recover {data.queue.stuck_leases === 1 ? 'it' : 'them'} shortly.
          </p>
        </Sheet>
      </Show>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ---- recent runs ---- */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="serif text-[17px] font-semibold text-ink">Recent runs</h2>
            <Link
              to={ROUTES.RUNS.LIST}
              className="text-[12px] text-ink-3 transition-colors duration-[120ms] hover:text-ink"
            >
              All runs →
            </Link>
          </div>

          <Show
            when={data.recent_runs.length > 0}
            fallback={
              <Sheet padding="lg">
                <EmptyState
                  title="No runs yet"
                  description="Create a task and run it — everything it does will be recorded here."
                  action={
                    <Link to={ROUTES.TASKS.NEW}>
                      <span className="text-[13px] text-emerald-600 hover:underline">
                        Create a task
                      </span>
                    </Link>
                  }
                />
              </Sheet>
            }
          >
            <Sheet padding="none">
              <div className="px-4 pt-3">
                <Table caption="Recent runs">
                  <thead>
                    <tr>
                      <Th>Task</Th>
                      <Th>Trigger</Th>
                      <Th align="right">Steps</Th>
                      <Th align="right">Duration</Th>
                      <Th align="right">When</Th>
                      <Th align="right">Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <Repeat each={list(data.recent_runs)}>
                      {(run) => (
                        <tr key={run.id} className="group transition-colors hover:bg-sheet-2">
                          <Td>
                            <Link
                              to={ROUTES.RUNS.detail(run.id)}
                              className="serif font-medium text-ink hover:underline"
                            >
                              {run.task_name}
                            </Link>
                          </Td>
                          <Td>
                            <span className="rec">{run.trigger}</span>
                          </Td>
                          <Td align="right" mono>
                            {run.steps_succeeded}/{run.step_count}
                          </Td>
                          <Td align="right" mono>
                            {formatDuration(run.duration_ms)}
                          </Td>
                          <Td align="right" mono className="text-ink-3">
                            {formatRelative(run.created_at)}
                          </Td>
                          <Td align="right">
                            <RunStatusFlag status={run.status} />
                          </Td>
                        </tr>
                      )}
                    </Repeat>
                  </tbody>
                </Table>
              </div>
            </Sheet>
          </Show>
        </section>

        {/* ---- right rail ---- */}
        <aside className="flex flex-col gap-6">
          <section>
            <h2 className="serif mb-3 text-[17px] font-semibold text-ink">Up next</h2>
            <Show
              when={data.upcoming.length > 0}
              fallback={
                <Sheet padding="tight">
                  <p className="text-[12px] text-ink-3">Nothing scheduled.</p>
                </Sheet>
              }
            >
              <Sheet padding="none">
                <div className="flex flex-col">
                  <Repeat each={list(data.upcoming)}>
                    {(fire, i) => (
                      <Link
                        key={fire.task_id}
                        to={ROUTES.TASKS.detail(fire.task_id)}
                        className={`flex flex-col gap-0.5 px-3.5 py-2.5 transition-colors hover:bg-sheet-2 ${
                          i > 0 ? 'border-t border-hair' : ''
                        }`}
                      >
                        <span className="serif text-[13px] font-medium text-ink">
                          {fire.task_name}
                        </span>
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] text-ink-3">
                            {fire.schedule_description}
                          </span>
                          <span className="rec">{formatRelative(fire.next_fire_at)}</span>
                        </span>
                      </Link>
                    )}
                  </Repeat>
                </div>
              </Sheet>
            </Show>
          </section>

          <Show when={data.failing_tasks.length > 0}>
            <section>
              <h2 className="serif mb-3 text-[17px] font-semibold text-ink">Needs attention</h2>
              <Sheet padding="none">
                <div className="flex flex-col">
                  <Repeat each={list(data.failing_tasks)}>
                    {(task, i) => (
                      <Link
                        key={task.id}
                        to={ROUTES.TASKS.detail(task.id)}
                        className={`flex items-baseline justify-between gap-2 px-3.5 py-2.5 transition-colors hover:bg-sheet-2 ${
                          i > 0 ? 'border-t border-hair' : ''
                        }`}
                      >
                        <span className="serif truncate text-[13px] font-medium text-ink">
                          {task.name}
                        </span>
                        <span className="rec shrink-0 text-short">
                          {task.stats?.consecutive_failures} failed
                        </span>
                      </Link>
                    )}
                  </Repeat>
                </div>
              </Sheet>
            </section>
          </Show>
        </aside>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string | undefined;
  tone?: 'ok' | 'fail' | 'watch' | undefined;
}) {
  return (
    <div className="bg-sheet px-4 py-4">
      <p className="overline mb-2">{label}</p>
      <Readout size="md" value={value} tone={tone} />
      {sub !== undefined && <p className="mt-1 text-[11px] text-ink-3">{sub}</p>}
    </div>
  );
}
