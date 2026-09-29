import type {
  PaginationMeta,
  TaskDetailView,
  TaskGraph,
  TaskStatus,
  TaskVersionView,
  TaskView,
} from '@klankish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@shared/api/client';
import { EP } from '@shared/constants/endpoints';

import { runKeys } from '@features/runs/api/use-runs';

export interface TasksPage {
  items: TaskView[];
  meta?: PaginationMeta;
}

export interface TasksFilter {
  status?: TaskStatus;
  tag?: string;
  search?: string;
  cursor?: string;
  limit?: number;
  allUsers?: boolean;
}

export const taskKeys = {
  all: ['tasks'] as const,
  list: (filter: TasksFilter) => ['tasks', 'list', filter] as const,
  detail: (id: string) => ['tasks', 'detail', id] as const,
  versions: (id: string) => ['tasks', 'versions', id] as const,
};

export function useTasks(filter: TasksFilter = {}) {
  return useQuery({
    queryKey: taskKeys.list(filter),
    queryFn: async (): Promise<TasksPage> => {
      const { data, meta } = await api.get<TaskView[]>(EP.TASKS.LIST, {
        params: {
          ...(filter.status !== undefined && { status: filter.status }),
          ...(filter.tag !== undefined && { tag: filter.tag }),
          ...(filter.search !== undefined && filter.search !== '' && { search: filter.search }),
          ...(filter.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter.limit !== undefined && { limit: filter.limit }),
          ...(filter.allUsers === true && { all_users: true }),
        },
      });
      return { items: data, ...(meta !== undefined && { meta }) };
    },
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: taskKeys.detail(id ?? ''),
    enabled: id !== undefined,
    queryFn: async (): Promise<TaskDetailView> => {
      const { data } = await api.get<TaskDetailView>(EP.TASKS.DETAIL(id!));
      return data;
    },
  });
}

export function useTaskVersions(id: string | undefined) {
  return useQuery({
    queryKey: taskKeys.versions(id ?? ''),
    enabled: id !== undefined,
    queryFn: async (): Promise<TaskVersionView[]> => {
      const { data } = await api.get<TaskVersionView[]>(EP.TASKS.VERSIONS(id!));
      return data;
    },
  });
}

export interface CreateTaskInput {
  name: string;
  description?: string | null;
  graph: TaskGraph;
  tags?: string[];
  concurrency_policy?: 'skip' | 'queue' | 'allow';
  max_concurrent_runs?: number;
  timeout_ms?: number | null;
  schedule?: {
    kind: 'cron' | 'interval' | 'once' | 'manual' | 'webhook';
    cron_expr?: string | null;
    interval_ms?: number | null;
    run_at?: string | null;
    timezone?: string;
    jitter_ms?: number;
    enabled?: boolean;
  };
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTaskInput): Promise<TaskDetailView> => {
      const { data } = await api.post<TaskDetailView>(EP.TASKS.CREATE, input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

export function useUpdateTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<CreateTaskInput> & { note?: string }) => {
      const { data } = await api.patch<TaskDetailView>(EP.TASKS.UPDATE(id), input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: taskKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: taskKeys.list({}) });
      // A graph edit writes a new version, so the version list is stale too.
      void qc.invalidateQueries({ queryKey: taskKeys.versions(id) });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await api.delete(EP.TASKS.DELETE(id));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
}

/** Run a task now. The response is 202 — the run is QUEUED, never "done". */
export function useRunTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; vars?: Record<string, unknown> }) => {
      const { data } = await api.post<{ run_id: string; status: string }>(
        EP.TASKS.RUN(input.id),
        input.vars === undefined ? {} : { vars: input.vars },
      );
      return data;
    },
    onSuccess: (_d, input) => {
      void qc.invalidateQueries({ queryKey: runKeys.all });
      void qc.invalidateQueries({ queryKey: taskKeys.detail(input.id) });
    },
  });
}

export function useSetTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; action: 'pause' | 'resume' }) => {
      const path = input.action === 'pause' ? EP.TASKS.PAUSE(input.id) : EP.TASKS.RESUME(input.id);
      const { data } = await api.post<TaskDetailView>(path);
      return data;
    },
    onSuccess: (_d, input) => {
      void qc.invalidateQueries({ queryKey: taskKeys.detail(input.id) });
      void qc.invalidateQueries({ queryKey: taskKeys.list({}) });
    },
  });
}

/**
 * Validate a graph without saving.
 *
 * A mutation rather than a query: it is an explicit action with a body, and caching "was this
 * draft valid?" by key would return a stale verdict after an edit.
 */
export function useValidateGraph() {
  return useMutation({
    mutationFn: async (graph: TaskGraph) => {
      const { data } = await api.post<{ valid: boolean; warnings: string[] }>(
        EP.TASKS.VALIDATE,
        { graph },
      );
      return data;
    },
  });
}

/**
 * Next fire times for a cron expression.
 *
 * Computed server-side on purpose: a client-side cron parser would eventually disagree with the
 * scheduler, and the disagreement would be invisible until a task fired at the wrong time.
 */
export function useSchedulePreview(cron: string, timezone: string) {
  return useQuery({
    queryKey: ['schedule-preview', cron, timezone],
    enabled: cron.trim() !== '',
    queryFn: async () => {
      const { data } = await api.get<{
        valid: boolean;
        description: string;
        next_fires: string[];
      }>(EP.SCHEDULE_PREVIEW, { params: { cron, timezone } });
      return data;
    },
  });
}
