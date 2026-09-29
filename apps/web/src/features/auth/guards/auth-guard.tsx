import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { ROUTES } from '@shared/constants/routes';
import { LoadingState } from '@shared/ui/primitives';

import { useAuth } from '../providers/auth-provider';

/**
 * Route protection.
 *
 * Renders nothing but a spinner while the session is being resolved — redirecting during that
 * window would bounce a signed-in user to the login screen on every hard refresh.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingState label="" />;
  if (user === null) {
    // Remember where they were headed so the login can send them back there.
    return <Navigate to={ROUTES.AUTH.LOGIN} replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/** Keeps a signed-in user off the login and register screens. */
export function GuestGuard({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingState label="" />;
  if (user !== null) return <Navigate to={ROUTES.DASHBOARD} replace />;
  return <>{children}</>;
}
