// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatText } from './chat-text';
import { REVEAL_MS } from './chat-reveal';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A reply as it is written, as streaming chat apps draw it: the chunk that just arrived fades in as one, briefly, a caret marks where words
// are still coming, and words already on screen are never drawn in again. Everything that has arrived is in the page at once, and with
// reduced motion it is plain text.
// What was shown is kept per message, so each test writes its own message.
let root: Root | null = null, host: HTMLElement | null = null, turn = 0;
const show = async (text: string, mode: { live: true } | { shown: string } = { live: true }, key = `m-${turn}`) => {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(<div className="chat-prose"><ChatText text={text} reveal={{ ...mode, key }}/></div>));
  return host!;
};
const redraw = async () => { await act(async () => root!.unmount()); root = null; host?.remove(); };
const fresh = () => [...host!.querySelectorAll('.word-in')].map(word => word.textContent);
const reduce = (on: boolean) => { window.matchMedia = ((query: string) => ({ matches: on && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia; };

beforeEach(() => { turn += 1; vi.useFakeTimers({ toFake: ['Date'] }); reduce(false); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; vi.useRealTimers(); });

it('fades in only the words that just arrived, and keeps the words already shown as they are', async () => {
  await show('Your morning is clear');
  expect(fresh()).toEqual(['Your', 'morning', 'is', 'clear']);
  const first = host!.querySelector('.word-in');
  // A second read before the first words have finished: they are the same nodes, so their fade runs on and never starts again.
  await show('Your morning is clear until ten');
  expect(host!.querySelector('.word-in')).toBe(first);
  vi.advanceTimersByTime(1000);
  await show('Your morning is clear until ten and then the team call');
  expect(fresh()).toEqual(['and', 'then', 'the', 'team', 'call']);
  expect(host!.textContent).toBe('Your morning is clear until ten and then the team call');
});

it('fades a whole chunk in as one, with no word-by-word stagger, so no backlog builds behind a long read', async () => {
  await show(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  const delays = [...host!.querySelectorAll<HTMLElement>('.word-in')].map(word => word.style.animationDelay);
  expect(delays).toHaveLength(40);
  expect(new Set(delays).size).toBe(1);
  vi.advanceTimersByTime(REVEAL_MS + 1);
  await show(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  expect(fresh()).toEqual([]);
});

// The caret is drawn after the last word, in its line; it is drawn by CSS after a space, so it wraps alone and is not part of the text.
it('marks where the words are still coming with a caret after the last word, and none on a settled reply', async () => {
  await show('Your morning is clear');
  expect(host!.querySelectorAll('.chat-caret')).toHaveLength(1);
  expect(host!.querySelector('p:last-child > .chat-caret:last-child')).not.toBeNull();
  expect(host!.textContent).toBe('Your morning is clear');
  await show('Two things:\n\n- **Standup** at ten\n- Lunch with Asha');
  expect(host!.querySelectorAll('.chat-caret')).toHaveLength(1);
  expect(host!.querySelector('li:last-child > .chat-caret:last-child')).not.toBeNull();
  await redraw();
  await show('Your morning is clear.', { shown: 'Your morning is clear' }, `settled-${turn}`);
  expect(host!.querySelector('.chat-caret')).toBeNull();
});

it('keeps bold and lists while the words inside them fade in', async () => {
  await show('Two things:\n\n- **Standup** at ten');
  vi.advanceTimersByTime(1000);
  await show('Two things:\n\n- **Standup** at ten\n- Lunch with **Asha**');
  expect(host!.querySelectorAll('li')).toHaveLength(2);
  expect(fresh()).toEqual(['Lunch', 'with', 'Asha']);
});

it('starts over when the words shown were withdrawn and others arrive', async () => {
  await show('Let me look');
  vi.advanceTimersByTime(1000);
  await show('Your inbox is quiet');
  expect(fresh()).toEqual(['Your', 'inbox', 'is', 'quiet']);
});

it('draws a settled reply with only what came after the shown words fading, and a rewritten one still', async () => {
  await show('Your morning is clear. Enjoy it.', { shown: 'Your morning is clear.' }, `longer-${turn}`);
  expect(fresh()).toEqual(['Enjoy', 'it.']);
  await act(async () => root!.unmount()); root = null; host?.remove();
  await show('Your mornings are clear.', { shown: 'Your morning is clear.' }, `rewritten-${turn}`);
  expect(fresh()).toEqual([]);
});

it('shows plain text when reduced motion is asked for', async () => {
  reduce(true);
  await show('Your morning is clear');
  await show('Your morning is clear until ten');
  expect(fresh()).toEqual([]);
  expect(host!.textContent).toBe('Your morning is clear until ten');
});

// Opening the chat again draws every row again: a settled reply stays as it is, and a draft carries on from the words it had shown.
it('never fades a settled reply in again when the chat is drawn again', async () => {
  await show('Your morning is clear. Enjoy it.', { shown: 'Your morning is clear.' });
  vi.advanceTimersByTime(1000);
  await redraw();
  await show('Your morning is clear. Enjoy it.', { shown: 'Your morning is clear.' });
  expect(fresh()).toEqual([]);
});

it('carries a draft on from the words it had shown when the chat is drawn again mid-reply', async () => {
  await show('Your morning is clear');
  vi.advanceTimersByTime(1000);
  await redraw();
  await show('Your morning is clear');
  expect(fresh()).toEqual([]);
  await show('Your morning is clear until ten');
  expect(fresh()).toEqual(['until', 'ten']);
});
