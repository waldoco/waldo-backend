// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatText } from './chat-text';
import { REVEAL_MS, REVEAL_SPREAD_MS } from './chat-reveal';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A reply's words as it is written: only the words that just arrived fade in, each a beat after the one before, and words already on
// screen are never drawn in again. Everything that has arrived is in the page at once, and with reduced motion it is plain text.
let root: Root | null = null, host: HTMLElement | null = null;
const show = async (text: string, reveal: { live: true } | { shown: string } = { live: true }) => {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(<div className="chat-prose"><ChatText text={text} reveal={reveal}/></div>));
  return host!;
};
const fresh = () => [...host!.querySelectorAll('.word-in')].map(word => word.textContent);
const reduce = (on: boolean) => { window.matchMedia = ((query: string) => ({ matches: on && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia; };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); reduce(false); });
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

it('staggers a big chunk within a short cap, so no backlog builds behind a long read', async () => {
  await show(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  const delays = [...host!.querySelectorAll<HTMLElement>('.word-in')].map(word => parseFloat(word.style.animationDelay));
  expect(delays).toHaveLength(40);
  expect(Math.max(...delays)).toBeLessThanOrEqual(REVEAL_SPREAD_MS);
  vi.advanceTimersByTime(REVEAL_MS + REVEAL_SPREAD_MS + 1);
  await show(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  expect(fresh()).toEqual([]);
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
  await show('Your morning is clear. Enjoy it.', { shown: 'Your morning is clear.' });
  expect(fresh()).toEqual(['Enjoy', 'it.']);
  await act(async () => root!.unmount()); root = null; host?.remove();
  await show('Your mornings are clear.', { shown: 'Your morning is clear.' });
  expect(fresh()).toEqual([]);
});

it('shows plain text when reduced motion is asked for', async () => {
  reduce(true);
  await show('Your morning is clear');
  await show('Your morning is clear until ten');
  expect(fresh()).toEqual([]);
  expect(host!.textContent).toBe('Your morning is clear until ten');
});
