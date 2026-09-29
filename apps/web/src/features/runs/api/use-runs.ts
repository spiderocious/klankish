import type { PaginationMeta, RunDetailView, RunStatus, RunView } from '@klankish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@shared/api/client';
import { EP } from '@shared/constants/endpoints';

/**
 * Run queries.
 *
 * React Query only — never a bare `useEffect + fetch`, which double-fires in StrictMode and
 * leaves broken loading states when a component unmounts mid-request.
 */

export interface RunsPage {
  items: RunView[];
  meta?: PaginationMeta;
}

export interface RunsFilter {
  taskId?: string;
  status?: RunStatus;
  trigger?: string;
  cursor?: string;
  limit?: number;
  allUsers?: boolean;
}

export const runKeys = {
  all: ['runs'] as const,
  list: (filter: RunsFilter) => ['runs', 'list', filter] as const,
  detail: (id: string) => ['runs', 'detail', id] as const,
};

/**
 * A run list.
 *
 * Polls while anything is live. Once every run on screen has finished, polling stops — a finished
 * record is immutable, so re-fetching it is pure waste.
 */
export function useRuns(filter: RunsFilter = {}) {
  return useQuery({
    queryKey: runKeys.list(filter),
    queryFn: async (): Promise<RunsPage> => {
      const { data, meta } = await api.get<RunView[]>(EP.RUNS.LIST, {
        params: {
          ...(filter.taskId !== undefined && { task_id: filter.taskId }),
          ...(filter.status !== undefined && { status: filter.status }),
          ...(filter.trigger !== undefined && { trigger: filter.trigger }),
          ...(filter.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter.limit !== undefined && { limit: filter.limit }),
          ...(filter.allUsers === true && { all_users: true }),
        },
      });
      return { items: data, ...(meta !== undefined && { meta }) };
    },
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      const live = items.some((r) => r.status === 'running' || r.status === 'queued');
      return live ? 2000 : false;
    },
  });
}

/**
 * One run, with every step — the inspector's query.
 *
 * Same polling rule: a live run refreshes every second so the timeline fills in as it executes; a
 * finished one never refetches, because the record cannot change.
 */
export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: runKeys.detail(id ?? ''),
    enabled: id !== undefined,
    queryFn: async (): Promise<RunDetailView> => {
      const { data } = await api.get<RunDetailView>(EP.RUNS.DETAIL(id!));
      return data;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'running' || status === 'queued' ? 1000 : false;
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ status: string }>(EP.RUNS.CANCEL(id));
      return data;
    },
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: runKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: runKeys.all });
    },
  });
}

export function useRetryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ run_id: string }>(EP.RUNS.RETRY(id));
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: runKeys.all });
    },
  });
}
