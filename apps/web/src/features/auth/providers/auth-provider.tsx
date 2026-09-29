import type { MeView, Permission } from '@klankish/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { api, hasSession, setSessionExpiredHandler, setTokens } from '@shared/api/client';
import { EP } from '@shared/constants/endpoints';

/**
 * Auth state.
 *
 * Context + useState, per the project's rules — no Redux, no Zustand. The server is the authority
 * on permissions; what is held here drives RENDERING only. Every endpoint re-checks on its own,
 * so a tampered client can hide a button but cannot grant itself access.
 */

interface AuthContextValue {
  user: MeView | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    timezone?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  user: MeView;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeView | null>(null);
  // Starts true only when a session might exist. Otherwise the login screen would flash a spinner
  // on every fresh visit.
  const [isLoading, setIsLoading] = useState(hasSession());
  const queryClient = useQueryClient();

  const loadMe = useCallback(async () => {
    if (!hasSession()) {
      setUser(null);
      setIsLoading(false);
      return;
    }
    try {
      const { data } = await api.get<MeView>(EP.AUTH.ME);
      setUser(data);
    } catch {
      // The client already attempted a refresh; reaching here means the session is gone.
      setUser(null);
      setTokens(null, null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  // The API client cannot import this provider (circular), so it calls back through a handler.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      // Drop every cached query: they were fetched as a user who is no longer signed in, and
      // leaving them would briefly show the previous user's data after a re-login.
      queryClient.clear();
    });
  }, [queryClient]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { data } = await api.post<TokenResponse>(
        EP.AUTH.LOGIN,
        { email, password },
        { skipAuth: true },
      );
      setTokens(data.access_token, data.refresh_token);
      setUser(data.user);
      queryClient.clear();
    },
    [queryClient],
  );

  const register = useCallback(
    async (input: { email: string; password: string; name: string; timezone?: string }) => {
      const { data } = await api.post<TokenResponse>(
        EP.AUTH.REGISTER,
        {
          ...input,
          // Send the browser's zone so schedules are interpreted in the user's local time from
          // the first task they create, rather than silently defaulting to UTC.
          timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        { skipAuth: true },
      );
      setTokens(data.access_token, data.refresh_token);
      setUser(data.user);
      queryClient.clear();
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      const raw = localStorage.getItem('klankish-tokens');
      const refresh = raw === null ? null : (JSON.parse(raw) as { refresh?: string }).refresh;
      if (typeof refresh === 'string') {
        await api.post(EP.AUTH.LOGOUT, { refresh_token: refresh });
      }
    } catch {
      // Logging out locally must succeed even if the server call does not — otherwise a user
      // with a flaky connection cannot sign out at all.
    } finally {
      setTokens(null, null);
      setUser(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const can = useCallback(
    (permission: Permission): boolean => user?.permissions.includes(permission) ?? false,
    [user],
  );

  return (
    <AuthContext.Provider
      value={{ user, isLoading, login, register, logout, refresh: loadMe, can }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
