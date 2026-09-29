import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider } from '@features/auth/providers/auth-provider';
import { AuthGuard, GuestGuard } from '@features/auth/guards/auth-guard';
import { ROUTES } from '@shared/constants/routes';
import { ThemeProvider } from '@shared/providers/theme-provider';
import { AppShell } from '@shared/ui/app-shell';
import { LoadingState } from '@shared/ui/primitives';
import { ApiError } from '@shared/api/client';

import './styles/index.css';

/**
 * Screens are lazy-loaded so the run inspector's payload viewer is not in the bundle a user pays
 * for just to reach the login screen.
 */
const LoginScreen = lazy(() => import('@features/auth/screen/login-screen'));
const RegisterScreen = lazy(() => import('@features/auth/screen/register-screen'));
const DashboardScreen = lazy(() => import('@features/dashboard/screen/dashboard-screen'));
const TasksScreen = lazy(() => import('@features/tasks/screen/tasks-screen'));
const RunsScreen = lazy(() => import('@features/runs/screen/runs-screen'));
const RunDetailScreen = lazy(() => import('@features/runs/screen/run-detail-screen'));
const TaskBuilderScreen = lazy(() => import('@features/tasks/screen/task-builder-screen'));
const TaskDetailScreen = lazy(() => import('@features/tasks/screen/task-detail-screen'));
const SecretsScreen = lazy(() => import('@features/secrets/screen/secrets-screen'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // Refetching every window focus is noisy on a dashboard someone leaves open.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry a 4xx: the same request will fail the same way, and retrying a 401 races
        // the token refresh the client already performs.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<LoadingState />}>{children}</Suspense>
      </AppShell>
    </AuthGuard>
  );
}

function App() {
  return (
    <Routes>
      <Route
        path={ROUTES.AUTH.LOGIN}
        element={
          <GuestGuard>
            <Suspense fallback={<LoadingState />}>
              <LoginScreen />
            </Suspense>
          </GuestGuard>
        }
      />
      <Route
        path={ROUTES.AUTH.REGISTER}
        element={
          <GuestGuard>
            <Suspense fallback={<LoadingState />}>
              <RegisterScreen />
            </Suspense>
          </GuestGuard>
        }
      />

      <Route path={ROUTES.DASHBOARD} element={<Shell><DashboardScreen /></Shell>} />
      <Route path={ROUTES.TASKS.LIST} element={<Shell><TasksScreen /></Shell>} />
      {/* NEW and EDIT are literal/specific and must precede the parameterised DETAIL route. */}
      <Route path={ROUTES.TASKS.NEW} element={<Shell><TaskBuilderScreen /></Shell>} />
      <Route path={ROUTES.TASKS.EDIT} element={<Shell><TaskBuilderScreen /></Shell>} />
      <Route path={ROUTES.TASKS.DETAIL} element={<Shell><TaskDetailScreen /></Shell>} />
      <Route path={ROUTES.SECRETS} element={<Shell><SecretsScreen /></Shell>} />
      <Route path={ROUTES.RUNS.LIST} element={<Shell><RunsScreen /></Shell>} />
      {/* Specific before parameterised, as everywhere else in this codebase. */}
      <Route path={ROUTES.RUNS.DETAIL} element={<Shell><RunDetailScreen /></Shell>} />

      <Route path="*" element={<Navigate to={ROUTES.DASHBOARD} replace />} />
    </Routes>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
