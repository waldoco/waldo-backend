import { describe, expect, it } from 'vitest';
import { ChatRequestError, ChatSignInRequired, type ChatMessage, type ChatPage, type ChatReceipt } from './chat-model';
import { createChatStore, type ChatDeps } from './chat-store';

const msg = (id: string, role: 'user' | 'assistant', text: string, created_at: number | null = 1000): ChatMessage => ({ id, role, text, parts: [], channel: 'app', parent_id: null, created_at });
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function harness() {
  let now = 1000, ids = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const state = {
    pages: [] as (ChatPage | Error)[], history: { messages: [] as ChatMessage[], next_cursor: null as string | null } as ChatPage,
    receipts: [] as (ChatReceipt | Error)[], sends: [] as [string, string][], sendResult: null as ChatReceipt | Error | null, cancels: [] as string[], pageCalls: 0,
  };
  const deps: ChatDeps = {
    page: async () => { state.pageCalls += 1; const queued = state.pages.shift() ?? state.history; if (queued instanceof Error) throw queued; return queued; },
    send: async (id, text) => { state.sends.push([id, text]); const result = state.sendResult ?? { message_id: 'app-1', state: 'admitted', closed_reason: null, effects_unconfirmed: false }; if (result instanceof Error) throw result; return result; },
    receipt: async () => { const result = state.receipts.shift() ?? { message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false }; if (result instanceof Error) throw result; return result; },
    cancel: async id => { state.cancels.push(id); return { message_id: 'app-1', state: 'revoked', closed_reason: 'cancelled', effects_unconfirmed: false }; },
    id: () => `console-client-${++ids}`,
    now: () => now,
    setTimer: (run, ms) => { const id = next++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimer: id => { timers.delete(id); },
    visible: () => true,
  };
  // Runs every timer due by `ms` from now, in time order, letting each one's work settle.
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].run(); await settle();
    }
    now = end; await settle();
  };
  const store = createChatStore(deps);
  return { store, state, advance, timers, setNow: (value: number) => { now = value; } };
}

describe('console chat store', () => {
  it('shows a sent message at once, follows its turn, and hands over to history when it lands', async () => {
    const { store, state, advance } = harness();
    store.open(); await settle();
    expect(store.get().phase).toBe('ready');
    expect(store.send('  What is on tomorrow?  ')).toBe(true);
    expect(store.get().local[0]).toMatchObject({ text: 'What is on tomorrow?', state: 'sending' });
    expect(store.get().draft).toBe('');
    expect(store.working()).toBe(true);
    await settle();
    expect(state.sends).toEqual([['console-client-1', 'What is on tomorrow?']]);
    expect(store.get().local[0]).toMatchObject({ state: 'admitted', messageId: 'app-1' });
    state.receipts.push({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false });
    await advance(700);
    expect(store.get().local[0]!.state).toBe('running');
    state.history = { messages: [msg('app-1', 'user', 'What is on tomorrow?', 1000), msg('r1', 'assistant', 'Two meetings.', 2000)], next_cursor: null };
    state.receipts.push({ message_id: 'app-1', state: 'completed', closed_reason: null, effects_unconfirmed: false });
    await advance(1000);
    expect(store.get().local).toEqual([]);
    expect(store.get().messages.map(m => m.id)).toEqual(['app-1', 'r1']);
    expect(store.get().arrived.has('r1')).toBe(true);
    expect(store.working()).toBe(false);
  });

  it('shows the reply written so far while the turn runs, checking every second while it grows, and drops it when the turn closes', async () => {
    const { store, state, advance } = harness();
    store.open(); await settle();
    store.send('Plan my afternoon'); await settle();
    state.receipts.push({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false, draft: 'Here is' });
    await advance(700);
    expect(store.get().local[0]!.draft).toBe('Here is');
    state.receipts.push({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false, draft: 'Here is the plan' });
    await advance(1000);
    expect(store.get().local[0]!.draft).toBe('Here is the plan');
    state.history = { messages: [msg('app-1', 'user', 'Plan my afternoon'), msg('r1', 'assistant', 'Here is the plan for today.')], next_cursor: null };
    state.receipts.push({ message_id: 'app-1', state: 'completed', closed_reason: null, effects_unconfirmed: false });
    await advance(1000);
    expect(store.get().local).toEqual([]);
    expect(store.get().messages.map(m => m.id)).toEqual(['app-1', 'r1']);
  });

  it('never hands a new message over to an older row with the same words', async () => {
    const { store, state } = harness();
    state.history = { messages: [msg('old', 'user', 'ok'), msg('r0', 'assistant', 'Noted.')], next_cursor: null };
    store.open(); await settle();
    store.send('ok'); await settle();
    await store.refresh();
    expect(store.get().local[0]).toMatchObject({ text: 'ok', landed: false });
    state.history = { messages: [...state.history.messages, msg('new', 'user', 'ok')], next_cursor: null };
    await store.refresh();
    expect(store.get().local[0]!.landed).toBe(true);
  });

  it('keeps polling a long errand without giving up, slowing to a steady pace', async () => {
    const { store, state, advance } = harness();
    store.open(); await settle();
    store.send('Find me a hotel in Goa'); await settle();
    const before = state.pageCalls;
    await advance(9 * 60_000);
    expect(store.get().local[0]!.state).toBe('running');
    // About one receipt check every 5 s and a history read every 15 s: well inside the shared read budget.
    expect(state.pageCalls - before).toBeLessThanOrEqual(9 * 4 + 2);
    await advance(10 * 60_000);
    expect(store.working()).toBe(true);
    state.receipts.push({ message_id: 'app-1', state: 'completed', closed_reason: null, effects_unconfirmed: false });
    state.history = { messages: [msg('app-1', 'user', 'Find me a hotel in Goa'), msg('r', 'assistant', 'Three options.')], next_cursor: null };
    await advance(15_000);
    expect(store.working()).toBe(false);
  });

  it('keeps an unsent message with its error, and a retry reuses the same client id', async () => {
    const { store, state } = harness();
    store.open(); await settle();
    state.sendResult = new ChatRequestError(0, 'Can’t reach Waldo. Check your connection.');
    store.send('Hello'); await settle();
    expect(store.get().local[0]).toMatchObject({ state: 'failed', error: 'Can’t reach Waldo. Check your connection.' });
    expect(store.working()).toBe(false);
    state.sendResult = null;
    store.retry('console-client-1'); await settle();
    expect(state.sends.map(([id]) => id)).toEqual(['console-client-1', 'console-client-1']);
    expect(store.get().local[0]!.state).toBe('admitted');
  });

  it('slows down on a spent budget and says so, without failing the turn', async () => {
    const { store, state, advance } = harness();
    store.open(); await settle();
    store.send('Hi'); await settle();
    state.receipts.push(new ChatRequestError(429, 'busy', 'rate_limited', 45));
    await advance(700);
    expect(store.get().notice).toContain('slowed');
    expect(store.get().local[0]!.state).toBe('admitted');
    state.receipts.push({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false });
    await advance(44_000);
    expect(store.get().local[0]!.state).toBe('admitted');
    await advance(1_000);
    expect(store.get().local[0]!.state).toBe('running');
    expect(store.get().notice).toBeNull();
  });

  it('says plainly when a turn did not finish, and offers to ask again', async () => {
    const { store, state, advance } = harness();
    store.open(); await settle();
    store.send('Plan my week'); await settle();
    state.history = { messages: [msg('app-1', 'user', 'Plan my week')], next_cursor: null };
    state.receipts.push({ message_id: 'app-1', state: 'interrupted', closed_reason: 'interrupted', effects_unconfirmed: false });
    await advance(700);
    expect(store.get().local[0]).toMatchObject({ state: 'interrupted', landed: true });
    store.askAgain('console-client-1'); await settle();
    expect(state.sends.at(-1)).toEqual(['console-client-2', 'Plan my week']);
  });

  it('stops a running turn and keeps the stop visible with any unconfirmed effect', async () => {
    const { store, state } = harness();
    store.open(); await settle();
    store.send('Book it'); await settle();
    await store.stop('console-client-1');
    expect(state.cancels).toEqual(['console-client-1']);
    expect(store.get().local[0]).toMatchObject({ state: 'revoked', closedReason: 'cancelled' });
    expect(store.working()).toBe(false);
  });

  it('pages back through earlier messages without duplicates', async () => {
    const { store, state } = harness();
    state.pages.push({ messages: [msg('c', 'user', 'c'), msg('d', 'assistant', 'd')], next_cursor: 'before:c' });
    store.open(); await settle();
    state.pages.push({ messages: [msg('a', 'user', 'a'), msg('b', 'assistant', 'b'), msg('c', 'user', 'c')], next_cursor: null });
    await store.loadOlder();
    expect(store.get().messages.map(m => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(store.get().nextCursor).toBeNull();
  });

  it('stops everything and asks for sign-in when the session ends', async () => {
    const { store, state, advance, timers } = harness();
    store.open(); await settle();
    store.send('Hi'); await settle();
    state.receipts.push(new ChatSignInRequired());
    await advance(700);
    expect(store.get().phase).toBe('signed-out');
    expect(timers.size).toBe(0);
    expect(store.send('again')).toBe(false);
  });

  it('shows a load failure with a way back, and keeps the last good conversation on a later failure', async () => {
    const { store, state, advance } = harness();
    state.pages.push(new ChatRequestError(503, 'Waldo couldn’t be reached. Try again.'));
    store.open(); await settle();
    expect(store.get()).toMatchObject({ phase: 'error', error: 'Waldo couldn’t be reached. Try again.' });
    state.history = { messages: [msg('a', 'assistant', 'hi')], next_cursor: null };
    store.retryLoad(); await settle();
    expect(store.get().phase).toBe('ready');
    state.pages.push(new ChatRequestError(0, 'offline'));
    await advance(20_000);
    expect(store.get().messages.map(m => m.id)).toEqual(['a']);
    expect(store.get().notice).toContain('Retrying');
  });
});
