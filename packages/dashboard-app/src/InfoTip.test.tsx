// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Explained, InfoTip, splitExplanation } from './InfoTip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; });
const mount = (node: React.ReactNode) => {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(<>{node}<button type="button">Elsewhere</button></>));
  const button = host.querySelector<HTMLButtonElement>('button.info-button')!;
  const text = document.getElementById(button.getAttribute('aria-controls')!)!;
  return { host, button, text };
};
// React derives enter and leave from over and out, so a hover is sent the way a browser sends it.
const native: Record<string, string> = { pointerenter: 'pointerover', pointerleave: 'pointerout' };
const pointer = (type: string, target: Element, pointerType = 'mouse') => act(() => { target.dispatchEvent(new PointerEvent(native[type] ?? type, { bubbles: true, pointerType, relatedTarget: native[type] ? document.body : null })); });

describe('InfoTip', () => {
  it('is a labelled button that discloses its text on click and hides it on a second click', () => {
    const { button, text } = mount(<InfoTip about="Notion">Asks you first.</InfoTip>);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('About Notion');
    expect(button.textContent).toBe('');
    expect(text.textContent).toBe('Asks you first.');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(text.hidden).toBe(true);
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(text.hidden).toBe(false);
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(text.hidden).toBe(true);
  });

  it('is reachable by keyboard and closes on Escape, returning focus to the (i)', () => {
    const { button, text } = mount(<InfoTip about="Notion">Asks you first.</InfoTip>);
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(text.hidden).toBe(false);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(text.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes on a press outside, and stays open on a press inside its text', () => {
    const { host, button, text } = mount(<InfoTip about="Notion">Asks you first.</InfoTip>);
    act(() => button.click());
    pointer('pointerdown', text);
    expect(text.hidden).toBe(false);
    pointer('pointerdown', [...host.querySelectorAll('button')].find(b => b.textContent === 'Elsewhere')!);
    expect(text.hidden).toBe(true);
  });

  it('peeks on mouse hover, but a tap opens it on click without the emulated hover closing it again', () => {
    const { button, text } = mount(<InfoTip about="Notion">Asks you first.</InfoTip>);
    const wrap = button.parentElement!;
    pointer('pointerenter', wrap);
    expect(text.hidden).toBe(false);
    pointer('pointerleave', wrap);
    expect(text.hidden).toBe(true);
    pointer('pointerenter', wrap, 'touch');
    expect(text.hidden).toBe(true);
    act(() => button.click());
    expect(text.hidden).toBe(false);
    pointer('pointerleave', wrap, 'touch');
    expect(text.hidden).toBe(false);
  });

  it('keeps a hovered tip open when clicked, until clicked again', () => {
    const { button, text } = mount(<InfoTip about="Notion">Asks you first.</InfoTip>);
    const wrap = button.parentElement!;
    pointer('pointerenter', wrap);
    act(() => button.click());
    pointer('pointerleave', wrap);
    expect(text.hidden).toBe(false);
    act(() => button.click());
    expect(text.hidden).toBe(true);
  });

  it('gives each tip its own controlled id', () => {
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<><InfoTip about="A">One.</InfoTip><InfoTip about="B">Two.</InfoTip></>));
    const ids = [...host.querySelectorAll('button.info-button')].map(b => b.getAttribute('aria-controls'));
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => id && document.getElementById(id))).toBe(true);
  });
});

describe('Explained', () => {
  const about = 'Search and read your pages and databases. Connecting here lets the tools Notion labels read-only run without asking when you ask Waldo yourself; anything else asks you first.';

  it('splits at the first sentence, keeping the wording verbatim', () => {
    const [purpose, rest] = splitExplanation(about);
    expect(purpose).toBe('Search and read your pages and databases.');
    expect(`${purpose} ${rest}`).toBe(about);
    expect(splitExplanation('One sentence only.')).toEqual(['One sentence only.', '']);
  });

  it('shows the purpose and puts the rest behind the (i), with the text content unchanged', () => {
    const { host, text } = mount(<p><Explained about="Notion" text={about}/></p>);
    expect(host.querySelector('p')!.textContent).toBe(about);
    expect(text.textContent).toBe(splitExplanation(about)[1]);
    expect(text.hidden).toBe(true);
  });

  it('draws no (i) for a single sentence', () => {
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<Explained about="Mac" text="Pair Kennel on your Mac."/>));
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toBe('Pair Kennel on your Mac.');
  });
});
