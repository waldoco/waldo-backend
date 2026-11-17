import { useSyncExternalStore } from 'react';

// Appearance: System follows the device, Light and Dark pin it. Only the choice is kept, in this browser; the
// inline script in index.html applies the same rule before first paint, so the page never flashes the wrong canvas.
export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'waldo.console.theme';
// The browser bar's colour, one per canvas.
const BAR: Record<Theme, string> = { light: '#fafaf8', dark: '#1c1b1a' };
const DARK_QUERY = '(prefers-color-scheme: dark)';

let current: ThemeChoice = 'system';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

const isChoice = (value: unknown): value is ThemeChoice => value === 'system' || value === 'light' || value === 'dark';
export function readThemeChoice(): ThemeChoice {
  try { const saved = window.localStorage.getItem(THEME_KEY); return isChoice(saved) ? saved : 'system'; }
  catch { return 'system'; }
}

const systemDark = () => { try { return window.matchMedia(DARK_QUERY).matches; } catch { return false; } };
export const resolveTheme = (choice: ThemeChoice, prefersDark = systemDark()): Theme =>
  choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[theme]);
}

export function setThemeChoice(choice: ThemeChoice) {
  try { if (choice === 'system') window.localStorage.removeItem(THEME_KEY); else window.localStorage.setItem(THEME_KEY, choice); }
  catch { /* Storage is blocked or full: the choice still holds until the page closes. */ }
  current = choice;
  apply(resolveTheme(choice));
  notify();
}

/** Applies the saved choice and, while it is System, follows the device as it changes. Returns a stop function. */
export function startTheme(): () => void {
  current = readThemeChoice();
  apply(resolveTheme(current));
  let query: MediaQueryList;
  try { query = window.matchMedia(DARK_QUERY); } catch { return () => {}; }
  const follow = () => { if (current !== 'system') return; apply(resolveTheme('system', query.matches)); notify(); };
  query.addEventListener('change', follow);
  return () => query.removeEventListener('change', follow);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const appliedTheme = (): Theme => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
export function useTheme(): { choice: ThemeChoice; theme: Theme } {
  const choice = useSyncExternalStore(subscribe, () => current, () => 'system' as const);
  const theme = useSyncExternalStore(subscribe, appliedTheme, () => 'light' as const);
  return { choice, theme };
}
