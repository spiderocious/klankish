/**
 * Frontend paths — the single source of truth.
 * Never inline a path in `<Link to>` or `navigate()`.
 */
export const ROUTES = {
  AUTH: {
    LOGIN: '/login',
    REGISTER: '/register',
    FORGOT: '/forgot-password',
    RESET: '/reset-password',
  },
  DASHBOARD: '/',
  TASKS: {
    LIST: '/tasks',
    NEW: '/tasks/new',
    DETAIL: '/tasks/:id',
    detail: (id: string) => `/tasks/${id}`,
    EDIT: '/tasks/:id/edit',
    edit: (id: string) => `/tasks/${id}/edit`,
  },
  RUNS: {
    LIST: '/runs',
    DETAIL: '/runs/:id',
    detail: (id: string) => `/runs/${id}`,
  },
  SECRETS: '/secrets',
  SETTINGS: '/settings',
  ADMIN: {
    OVERVIEW: '/admin',
    USERS: '/admin/users',
    RUNS: '/admin/runs',
    WORKERS: '/admin/workers',
    AUDIT: '/admin/audit',
  },
} as const;
