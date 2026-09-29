import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Theme.
 *
 * Light is the DEFAULT, stated in the product brief: `prefers-color-scheme` is consulted only
 * when the viewer has never chosen. The initial attribute is set by an inline script in
 * index.html before first paint, so this provider only has to stay in sync with it — never to
 * apply the theme for the first time, which would flash.
 */

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'klankish-theme';

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitial(): Theme {
  // Trust the attribute the inline script already set — it is the thing actually on screen.
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitial);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can throw. The theme still applies for this session; it just will not
      // be remembered, which is a far better outcome than a crash.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  // Follow the OS only while the viewer has expressed no preference of their own.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* unavailable */
    }
    if (stored !== null) return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => {
      setThemeState(e.matches ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
