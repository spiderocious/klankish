import { Activity, Clock, Key, Layers, ListChecks, LogOut, Settings, Shield, Zap } from '@icons';
import type { RunView } from '@klankish/shared';
import { Show, Repeat } from 'meemaw';
import { NavLink, useNavigate } from 'react-router-dom';

import { useAuth } from '@features/auth/providers/auth-provider';
import { useRuns } from '@features/runs/api/use-runs';
import { ROUTES } from '@shared/constants/routes';
import { useTheme } from '@shared/providers/theme-provider';
import { cn } from '@shared/utils/cn';
import { list } from '@shared/utils/list';

import { RunStatusFlag, formatRelative } from './status.js';

/**
 * The application shell.
 *
 * Information architecture follows the reference the user supplied: brand, grouped nav, a pinned
 * list of RECENT RUNS at the bottom of the sidebar, a user card, and a slim topbar. The material
 * is the ledger stance rather than the reference's soft-shadow cards — hairlines, cream paper,
 * serif names against mono figures.
 *
 * The recent-runs rail is the best idea in that reference and it earns its place here: this is a
 * product about runs, so the thing you most often want next is the run you just started.
 */

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof Activity;
  readonly end?: boolean;
}

const MAIN_NAV: readonly NavItem[] = [
  { to: ROUTES.DASHBOARD, label: 'Dashboard', icon: Activity, end: true },
  { to: ROUTES.TASKS.LIST, label: 'Tasks', icon: ListChecks },
  { to: ROUTES.RUNS.LIST, label: 'Runs', icon: Clock },
  { to: ROUTES.SECRETS, label: 'Secrets', icon: Key },
];

const ADMIN_NAV: readonly NavItem[] = [
  { to: ROUTES.ADMIN.OVERVIEW, label: 'Overview', icon: Shield, end: true },
  { to: ROUTES.ADMIN.USERS, label: 'Users', icon: Layers },
  { to: ROUTES.ADMIN.WORKERS, label: 'Workers', icon: Zap },
];

function navClasses({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex items-center gap-2.5 rounded-sharp px-2 py-[7px] text-[13px] transition-colors duration-[120ms]',
    isActive
      ? 'bg-ink text-paper'
      : 'text-ink-2 hover:bg-paper-deep hover:text-ink',
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout, can } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  // The rail shows a handful of recent runs and polls while any are live, so a run started
  // elsewhere still appears. Short list, cheap query.
  const { data: recentRuns } = useRuns({ limit: 6 });

  const isAdmin = can('user.read.any');

  return (
    <div className="grid min-h-screen grid-cols-[220px_1fr] bg-paper-deep">
      {/* ---------------- sidebar ---------------- */}
      <aside className="flex flex-col border-r border-ink bg-paper px-4 py-[18px]">
        <div className="flex items-baseline gap-1.5 border-b border-ink px-1.5 pb-[18px]">
          <span className="serif text-[22px] font-semibold tracking-[-0.022em] text-ink">
            Klankish<span className="text-emerald-600">.</span>
          </span>
          <span className="rec ml-auto pt-1.5 text-[9px] tracking-[0.18em]">v0.1</span>
        </div>

        <nav className="mt-5 flex flex-col gap-0.5">
          <Repeat each={list(MAIN_NAV)}>
            {(item) => (
              <NavLink key={item.to} to={item.to} end={item.end ?? false} className={navClasses}>
                <item.icon size={16} className="shrink-0 opacity-70" />
                {item.label}
              </NavLink>
            )}
          </Repeat>
        </nav>

        <Show when={isAdmin}>
          <div className="mt-6">
            <p className="overline px-1.5 pb-2">Admin</p>
            <nav className="flex flex-col gap-0.5">
              <Repeat each={list(ADMIN_NAV)}>
                {(item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end ?? false}
                    className={navClasses}
                  >
                    <item.icon size={16} className="shrink-0 opacity-70" />
                    {item.label}
                  </NavLink>
                )}
              </Repeat>
            </nav>
          </div>
        </Show>

        {/* ---- recent runs rail ---- */}
        <div className="mt-auto border-t border-ink pt-4">
          <p className="overline px-1.5 pb-2">Recent runs</p>
          <Show
            when={recentRuns !== undefined && recentRuns.items.length > 0}
            fallback={<p className="px-1.5 text-[11px] text-ink-4">No runs yet.</p>}
          >
            <div className="flex flex-col">
              <Repeat each={list(recentRuns?.items)}>
                {(run: RunView) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => navigate(ROUTES.RUNS.detail(run.id))}
                    className="group flex items-center gap-2 rounded-sharp px-1.5 py-1.5 text-left transition-colors duration-[120ms] hover:bg-paper-deep"
                  >
                    <StatusDot status={run.status} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2 group-hover:text-ink">
                      {run.task_name}
                    </span>
                    <span className="rec shrink-0 text-[10px]">
                      {formatRelative(run.created_at)}
                    </span>
                  </button>
                )}
              </Repeat>
            </div>
          </Show>
        </div>

        {/* ---- user card ---- */}
        <div className="mt-4 flex items-center gap-2 border-t border-hair pt-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sheet-edge bg-paper-deep text-[10px] font-semibold text-ink-2">
            {(user?.name ?? '?').slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-ink">{user?.name}</p>
            <p className="truncate text-[10px] text-ink-3">{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            aria-label="Sign out"
            title="Sign out"
            className="rounded-sharp p-1 text-ink-3 transition-colors duration-[120ms] hover:bg-paper-deep hover:text-ink"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* ---------------- stage ---------------- */}
      <div className="flex min-w-0 flex-col bg-paper">
        <header className="flex items-center gap-4 border-b border-hair px-8 py-3">
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              className="rounded-sharp p-1.5 text-ink-3 transition-colors duration-[120ms] hover:bg-paper-deep hover:text-ink"
            >
              <ThemeGlyph theme={theme} />
            </button>
            <NavLink
              to={ROUTES.SETTINGS}
              aria-label="Settings"
              title="Settings"
              className="rounded-sharp p-1.5 text-ink-3 transition-colors duration-[120ms] hover:bg-paper-deep hover:text-ink"
            >
              <Settings size={15} />
            </NavLink>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-auto px-8 py-7">{children}</main>
      </div>
    </div>
  );
}

/**
 * The theme glyph.
 *
 * Drawn inline rather than pulled from the icon set: lucide's icon NAMES are not always the
 * obvious ones and a wrong name renders nothing at all, silently. Two circles are unambiguous.
 */
function ThemeGlyph({ theme }: { theme: 'light' | 'dark' }) {
  return theme === 'dark' ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

/**
 * The status dot in the rail.
 *
 * A running run gets the ONE ambient animation in the product. Everything else is static — and
 * every dot is paired with a text status elsewhere on the row's destination screen, so colour is
 * never the only carrier.
 */
function StatusDot({ status }: { status: RunView['status'] }) {
  if (status === 'running') return <span className="pulse" aria-label="Running" />;

  const tone =
    status === 'succeeded'
      ? 'bg-emerald-600'
      : status === 'failed' || status === 'timed_out'
        ? 'bg-short'
        : status === 'queued'
          ? 'border border-info bg-transparent'
          : 'bg-ink-4';

  return (
    <span
      aria-label={status}
      className={cn('h-[6px] w-[6px] shrink-0 rounded-full', tone)}
    />
  );
}

export { RunStatusFlag };
