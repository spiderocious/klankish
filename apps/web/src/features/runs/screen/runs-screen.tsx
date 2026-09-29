import { Clock } from '@icons';
import type { RunStatus } from '@klankish/shared';
import { Repeat, Show } from 'meemaw';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ROUTES } from '@shared/constants/routes';
import {
  EmptyState, LoadingState, PageHeader, Select, Sheet, Table, Td, Th,
} from '@shared/ui/primitives';
import {
  RunStatusFlag, formatAbsolute, formatDuration, formatRelative,
} from '@shared/ui/status';
import { list } from '@shared/utils/list';

import { useRuns } from '../api/use-runs';

const STATUSES: Array<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'timed_out', label: 'Timed out' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function RunsScreen() {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useRuns({
    limit: 50,
    ...(status !== '' && { status: status as RunStatus }),
  });

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Runs" subtitle="Every execution, and what it did." />

      <div className="mb-5 flex items-center gap-3">
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="max-w-[180px]"
          aria-label="Filter by status"
        >
          <Repeat each={list(STATUSES)}>
            {(s) => <option key={s.value} value={s.value}>{s.label}</option>}
          </Repeat>
        </Select>
      </div>

      <Show when={isLoading}><LoadingState /></Show>

      <Show when={!isLoading}>
        <Show
          when={(data?.items.length ?? 0) > 0}
          fallback={
            <Sheet padding="lg">
              <EmptyState
                icon={<Clock size={28} />}
                title={status === '' ? 'No runs yet' : 'No runs with that status'}
                description={
                  status === ''
                    ? 'Once a task runs, every step it takes is recorded here.'
                    : undefined
                }
              />
            </Sheet>
          }
        >
          <Sheet padding="none">
            <div className="px-5 pt-4">
              <Table caption="Runs">
                <thead>
                  <tr>
                    <Th>Task</Th>
                    <Th>Trigger</Th>
                    <Th align="right">Steps</Th>
                    <Th align="right">Queue wait</Th>
                    <Th align="right">Duration</Th>
                    <Th align="right">When</Th>
                    <Th align="right">Status</Th>
                  </tr>
                </thead>
                <tbody>
                  <Repeat each={list(data?.items)}>
                    {(run) => (
                      <tr key={run.id} className="transition-colors hover:bg-sheet-2">
                        <Td>
                          <Link
                            to={ROUTES.RUNS.detail(run.id)}
                            className="serif font-medium text-ink hover:underline"
                          >
                            {run.task_name}
                          </Link>
                          <span className="rec ml-2">v{run.task_version}</span>
                        </Td>
                        <Td><span className="rec">{run.trigger}</span></Td>
                        <Td align="right" mono>
                          <span className={run.steps_failed > 0 ? 'text-short' : ''}>
                            {run.steps_succeeded}/{run.step_count}
                          </span>
                        </Td>
                        <Td align="right" mono className="text-ink-3">
                          {formatDuration(run.queue_latency_ms)}
                        </Td>
                        <Td align="right" mono>{formatDuration(run.duration_ms)}</Td>
                        <Td align="right" mono className="text-ink-3">
                          <span title={formatAbsolute(run.created_at)}>
                            {formatRelative(run.created_at)}
                          </span>
                        </Td>
                        <Td align="right"><RunStatusFlag status={run.status} /></Td>
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
