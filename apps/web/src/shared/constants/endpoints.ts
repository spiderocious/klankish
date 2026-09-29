/**
 * Backend paths — the single source of truth.
 *
 * Never inline a path in a component or a query hook. When a route changes it changes here, and
 * the documented failure mode this prevents is real: a path edited in the backend without
 * updating a hand-written string produces a 404 that looks like a data bug.
 */
export const EP = {
  AUTH: {
    REGISTER: '/api/v1/auth/register',
    LOGIN: '/api/v1/auth/login',
    REFRESH: '/api/v1/auth/refresh',
    LOGOUT: '/api/v1/auth/logout',
    LOGOUT_ALL: '/api/v1/auth/logout-all',
    ME: '/api/v1/auth/me',
    CHANGE_PASSWORD: '/api/v1/auth/change-password',
    SESSIONS: '/api/v1/auth/sessions',
    SESSION: (id: string) => `/api/v1/auth/sessions/${id}`,
    PASSWORD_RESET_REQUEST: '/api/v1/auth/password-reset/request',
    PASSWORD_RESET_CONFIRM: '/api/v1/auth/password-reset/confirm',
  },
  TASKS: {
    LIST: '/api/v1/tasks',
    CREATE: '/api/v1/tasks',
    VALIDATE: '/api/v1/tasks/validate',
    DETAIL: (id: string) => `/api/v1/tasks/${id}`,
    UPDATE: (id: string) => `/api/v1/tasks/${id}`,
    DELETE: (id: string) => `/api/v1/tasks/${id}`,
    RUN: (id: string) => `/api/v1/tasks/${id}/run`,
    PAUSE: (id: string) => `/api/v1/tasks/${id}/pause`,
    RESUME: (id: string) => `/api/v1/tasks/${id}/resume`,
    CLONE: (id: string) => `/api/v1/tasks/${id}/clone`,
    VERSIONS: (id: string) => `/api/v1/tasks/${id}/versions`,
    VERSION: (id: string, versionId: string) => `/api/v1/tasks/${id}/versions/${versionId}`,
    RESTORE_VERSION: (id: string, versionId: string) =>
      `/api/v1/tasks/${id}/versions/${versionId}/restore`,
  },
  RUNS: {
    LIST: '/api/v1/runs',
    DETAIL: (id: string) => `/api/v1/runs/${id}`,
    CANCEL: (id: string) => `/api/v1/runs/${id}/cancel`,
    RETRY: (id: string) => `/api/v1/runs/${id}/retry`,
  },
  SECRETS: {
    LIST: '/api/v1/secrets',
    CREATE: '/api/v1/secrets',
    UPDATE: (id: string) => `/api/v1/secrets/${id}`,
    DELETE: (id: string) => `/api/v1/secrets/${id}`,
  },
  DASHBOARD: '/api/v1/dashboard',
  SCHEDULE_PREVIEW: '/api/v1/schedules/preview',
} as const;
