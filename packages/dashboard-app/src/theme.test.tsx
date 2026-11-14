// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppearancePanel, ThemeToggle } from './Appearance';
import { readThemeChoice, resolveTheme, setThemeChoice, startTheme, THEME_KEY, type ThemeChoice } from './theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const html = document.documentElement;
let systemDark = false;
let change: (() => void) | null = null;
const stubSystem = () => vi.stubGlobal('matchMedia', (query: string) => ({
  get matches() { return query === '(prefers-color-scheme: dark)' && systemDark; },
  addEventListener: (_: string, listener: () => void) => { change = listener; },
  removeEventListener: () => { change = null; },
}));
const refuse = () => { throw new Error('storage blocked'); };
const blockStorage = () => vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse });
let root: Root | undefined;
beforeEach(() => {
  systemDark = false; change = null; stubSystem(); window.localStorage.clear();
  delete html.dataset.theme;
  document.head.innerHTML = '<meta name="theme-color" content="#fafaf8">';
});
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); setThemeChoice('system'); });
const bar = () => document.querySelector('meta[name="theme-color"]')!.getAttribute('content');

describe('theme choice', () => {
  it('resolves System from the device and pins Light and Dark', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('reads System when nothing, or something unknown, is stored, and when storage throws', () => {
    expect(readThemeChoice()).toBe('system');
    window.localStorage.setItem(THEME_KEY, 'sepia');
    expect(readThemeChoice()).toBe('system');
    window.localStorage.setItem(THEME_KEY, 'dark');
    expect(readThemeChoice()).toBe('dark');
    blockStorage();
    expect(readThemeChoice()).toBe('system');
  });

  it('keeps Light and Dark, forgets System, and applies each to the page and the browser bar', () => {
    setThemeChoice('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect([html.dataset.theme, bar()]).toEqual(['dark', '#1c1b1a']);
    setThemeChoice('light');
    expect([html.dataset.theme, bar()]).toEqual(['light', '#fafaf8']);
    systemDark = true;
    setThemeChoice('system');
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(html.dataset.theme).toBe('dark');
  });

  it('still applies a choice when storage refuses to keep it', () => {
    blockStorage();
    expect(() => setThemeChoice('dark')).not.toThrow();
    expect(html.dataset.theme).toBe('dark');
  });

  it('follows the device while on System, and ignores it once pinned', () => {
    const stop = startTheme();
    expect(html.dataset.theme).toBe('light');
    systemDark = true; change?.();
    expect(html.dataset.theme).toBe('dark');
    setThemeChoice('light');
    systemDark = false; change?.(); systemDark = true; change?.();
    expect(html.dataset.theme).toBe('light');
    stop();
    expect(change).toBeNull();
  });
});

describe('the pre-paint script in index.html', () => {
  const script = /<script>([^<]+)<\/script>/.exec(readFileSync(new NodeURL('../index.html', import.meta.url), 'utf8'))![1]!;
  const run = () => { delete html.dataset.theme; new Function(script)(); return html.dataset.theme; };
  it.each<[string | null, boolean]>([[null, false], [null, true], ['system', true], ['light', true], ['dark', false], ['sepia', true]])(
    'agrees with the app for stored %s on a %s-dark device', (stored, dark) => {
      systemDark = dark;
      if (stored) window.localStorage.setItem(THEME_KEY, stored);
      const expected = resolveTheme(stored === 'light' || stored === 'dark' ? stored : 'system', dark);
      expect(run()).toBe(expected);
      expect(bar()).toBe(expected === 'dark' ? '#1c1b1a' : '#fafaf8');
    });
  it('falls back to the device when storage throws', () => {
    systemDark = true;
    blockStorage();
    expect(run()).toBe('dark');
  });
});

describe('appearance controls', () => {
  const mount = (node: React.ReactNode) => { const host = document.body.appendChild(document.createElement('div')); root = createRoot(host); act(() => root!.render(node)); return host; };

  it('offers System, Light and Dark as one labelled choice with System chosen by default', () => {
    const host = mount(<AppearancePanel/>);
    const radios = [...host.querySelectorAll<HTMLInputElement>('fieldset input[type=radio]')];
    expect(host.querySelector('legend')?.textContent).toBe('Appearance');
    expect(radios.map(radio => [radio.closest('label')!.textContent, radio.checked])).toEqual([['System', true], ['Light', false], ['Dark', false]]);
    act(() => radios[2]!.click());
    expect(html.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(radios.map(radio => radio.checked)).toEqual([false, false, true]);
  });

  it('flips what is showing from the top bar and names where it goes next', () => {
    const host = mount(<><ThemeToggle/><AppearancePanel/></>);
    const toggle = host.querySelector<HTMLButtonElement>('.theme-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('Switch to dark appearance');
    act(() => toggle.click());
    expect(html.dataset.theme).toBe('dark');
    expect(toggle.getAttribute('aria-label')).toBe('Switch to light appearance');
    const checked = (choice: ThemeChoice) => host.querySelector<HTMLInputElement>(`input[value=${choice}]`)!.checked;
    expect(checked('dark')).toBe(true);
    act(() => toggle.click());
    expect([html.dataset.theme, checked('light')]).toEqual(['light', true]);
  });
});

describe('colour tokens', () => {
  // Every colour lives in a token so the dark set can replace it. The few literals left are the same in both
  // appearances: white marks on green, red and blue fills, the light plate behind brand logos, and the dusk veil.
  const allowed = new Set(['#fff', '#f4f3f0', '#1c1b1a']);
  const literals = (path: string) => {
    const css = readFileSync(new NodeURL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const outsideTokens = css.replace(/:root(\[data-[a-z]+="[a-z]+"\])?(,:root\[data-[a-z]+="[a-z]+"\])?\s*\{[^}]*\}/g, '');
    return [...outsideTokens.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\((?!var\()[^)]*\)/g)].map(match => match[0]).filter(value => !allowed.has(value));
  };
  it('keeps style.css free of colour literals outside the light and dark token sets', () => {
    expect(literals('./style.css')).toEqual([]);
  });
  it('defines every light token again for dark', () => {
    const css = readFileSync(new NodeURL('./style.css', import.meta.url), 'utf8');
    const block = (selector: RegExp) => new Set([...(selector.exec(css)?.[1] ?? '').matchAll(/(--[a-z0-9-]+):/g)].map(match => match[1]));
    const light = block(/:root \{([^}]*)\}/), dark = block(/:root\[data-theme="dark"\],:root\[data-scene="night"\] \{([^}]*)\}/);
    // Type, radii, motion and the signal colours (accent, action, green, red) read the same on both canvases.
    const shared = new Set(['--font', '--r-card', '--r-inner', '--ease', '--spring', '--serif', '--accent', '--action', '--green', '--red']);
    expect([...light].filter(name => !shared.has(name!) && !dark.has(name))).toEqual([]);
  });
});
