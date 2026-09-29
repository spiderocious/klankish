import { ListChecks, Pause, Play, Plus, Search, Zap } from '@icons';
import type { TaskView } from '@klankish/shared';
import { Repeat, Show } from 'meemaw';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ROUTES } from '@shared/constants/routes';
import {
  Button,
  EmptyState,
  Input,
  LoadingState,
  PageHeader,
  Pill,
  Sheet,
  Table,
  Td,
  Th,
} from '@shared/ui/primitives';
import { formatRate, formatRelative, RunStatusFlag } from '@shared/ui/status';
import { list } from '@shared/utils/list';

import { useRunTask, useSetTaskStatus, useTasks } from '../api/use-tasks';

/**
 * The task list.
 *
 * Column set follows the reference the user supplied — name, trigger, runs, success rate, owner,
 * action — because it is the right set: those are the six things you actually scan for. Rendered
 * as a ledger rather than as zebra-striped cards.
 */
export default function TasksScreen() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useTasks({ ...(search !== '' && { search }) });
  const runTask = useRunTask();
  const setStatus = useSetTaskStatus();
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader
        title="Tasks"
        subtitle="What runs, when it runs, and how it has been doing."
        actions={
          <Link to={ROUTES.TASKS.NEW}>
            <Button variant="primary" icon={<Plus size={14} />}>
              New task
            </Button>
          </Link>
        }
      />

      <div className="mb-5 flex items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4"
          />
          <Input
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <Show when={isLoading}>
        <LoadingState />
      </Show>

      <Show when={!isLoading}>
        <Show
          when={(data?.items.length ?? 0) > 0}
          fallback={
            <Sheet padding="lg">
              <EmptyState
                icon={<ListChecks size={28} />}
                title={search === '' ? 'No tasks yet' : 'Nothing matches that search'}
                description={
                  search === ''
                    ? 'A task is a few steps and a schedule. Every time it runs, everything it did is recorded.'
                    : undefined
                }
                action={
                  search === '' ? (
                    <Link to={ROUTES.TASKS.NEW}>
                      <Button variant="primary" size="sm" icon={<Plus size={13} />}>
                        Create your first task
                      </Button>
                    </Link>
                  ) : undefined
                }
              />
            </Sheet>
          }
        >
          <Sheet padding="none">
            <div className="px-5 pt-4">
              <Table caption="Tasks">
                <thead>
                  <tr>
                    <Th className="w-[44px]">#</Th>
                    <Th>Task</Th>
                    <Th>Schedule</Th>
                    <Th align="right">Runs</Th>
                    <Th align="right">Success</Th>
                    <Th align="right">Last run</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  <Repeat each={list(data?.items)}>
                    {(task: TaskView, i: number) => (
                      <tr key={task.id} className="group transition-colors hover:bg-sheet-2">
                        <Td mono className="text-ink-4">
                          {String(i + 1).padStart(3, '0')}
                        </Td>

                        <Td>
                          <div className="flex flex-col gap-0.5">
                            <Link
                              to={ROUTES.TASKS.detail(task.id)}
                              className="serif text-sm font-medium text-ink hover:underline"
                            >
                              {task.name}
                            </Link>
                            <span className="flex items-center gap-2">
                              <span className="rec">{task.step_count} steps</span>
                              <Show when={task.status === 'paused'}>
                                <Pill tone="muted">Paused</Pill>
                              </Show>
                              <Repeat each={list(task.tags)}>
                                {(tag) => (
                                  <span key={tag} className="rec text-ink-4">
                                    #{tag}
                                  </span>
                                )}
                              </Repeat>
                            </span>
                          </div>
                        </Td>

                        <Td>
                          <span className="text-[12px] text-ink-3">
                            {task.schedule?.description ?? 'Manual only'}
                          </span>
                        </Td>

                        <Td align="right" mono>
                          {task.stats?.runs_total ?? 0}
                        </Td>

                        <Td align="right" mono>
                          <span
                            className={
                              task.stats?.success_rate === null ||
                              task.stats?.success_rate === undefined
                                ? 'text-ink-4'
                                : task.stats.success_rate >= 0.95
                                  ? 'text-emerald-700'
                                  : task.stats.success_rate >= 0.8
                                    ? 'text-watch'
                                    : 'text-short'
                            }
                          >
                            {formatRate(task.stats?.success_rate ?? null)}
                          </span>
                        </Td>

                        <Td align="right">
                          <span className="flex items-center justify-end gap-2">
                            <Show when={task.stats?.last_run_status != null}>
                              <RunStatusFlag status={task.stats!.last_run_status!} />
                            </Show>
                            <span className="rec">
                              {formatRelative(task.stats?.last_run_at ?? null)}
                            </span>
                          </span>
                        </Td>

                        <Td align="right">
                          {/* Actions appear on hover: a row of buttons on every line turns a
                              scannable ledger into a control panel. */}
                          <span className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <Button
                              size="sm"
                              variant="quiet"
                              icon={<Zap size={12} />}
                              title="Run now"
                              aria-label={`Run ${task.name} now`}
                              onClick={() =>
                                runTask.mutate(
                                  { id: task.id },
                                  { onSuccess: (d) => navigate(ROUTES.RUNS.detail(d.run_id)) },
                                )
                              }
                            />
                            <Button
                              size="sm"
                              variant="quiet"
                              title={task.status === 'paused' ? 'Resume' : 'Pause'}
                              aria-label={
                                task.status === 'paused'
                                  ? `Resume ${task.name}`
                                  : `Pause ${task.name}`
                              }
                              icon={
                                task.status === 'paused' ? <Play size={12} /> : <Pause size={12} />
                              }
                              onClick={() =>
                                setStatus.mutate({
                                  id: task.id,
                                  action: task.status === 'paused' ? 'resume' : 'pause',
                                })
                              }
                            />
                          </span>
                        </Td>
                      </tr>
                    )}
                  </Repeat>
                </tbody>
              </Table>
            </div>
          </Sheet>
        </Show>
      </Show>
    </div>
  );
}
