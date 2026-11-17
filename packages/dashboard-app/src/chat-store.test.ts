import { describe, expect, it } from 'vitest';
import { ChatRequestError, ChatSignInRequired, type ChatMessage, type ChatPage, type ChatReceipt } from './chat-model';
import { ATTACHMENT_GONE, ONE_ATTACHMENT, ONLY_FIRST, UPLOAD_MAX_BYTES, type UploadResult } from './chat-attachments';
import { createChatStore, type ChatDeps, type UploadsServed } from './chat-store';

const msg = (id: string, role: 'user' | 'assistant', text: string, created_at: number | null = 1000): ChatMessage => ({ id, role, text, parts: [], channel: 'app', parent_id: null, created_at });
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function harness(over: Partial<ChatDeps> = {}) {
  let now = 1000, ids = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const state = {
    pages: [] as (ChatPage | Error)[], history: { messages: [] as ChatMessage[], next_cursor: null as string | null } as ChatPage,
    receipts: [] as (ChatReceipt | Error)[], sends: [] as string[][], sendResult: null as ChatReceipt | Error | null, cancels: [] as string[], pageCalls: 0,
  };
  const deps: ChatDeps = {
    page: async () => { state.pageCalls += 1; const queued = state.pages.shift() ?? state.history; if (queued instanceof Error) throw queued; return queued; },
    send: async (id, text, uploadId) => { state.sends.push(uploadId ? [id, text, uploadId] : [id, text]); const result = state.sendResult ?? { message_id: 'app-1', state: 'admitted', closed_reason: null, effects_unconfirmed: false }; if (result instanceof Error) throw result; return result; },
    receipt: async () => { const result = state.receipts.shift() ?? { message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false }; if (result instanceof Error) throw result; return result; },
    cancel: async id => { state.cancels.push(id); return { message_id: 'app-1', state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: false }; },
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
  const store = createChatStore({ ...deps, ...over });
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
    expect(store.get().local[0]).toMatchObject({ state: 'interrupted', closedReason: 'cancelled' });
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
  describe('a reply streamed while it was written', () => {
    const reply = (id: string, text: string): ChatMessage => ({ ...msg(id, 'assistant', text), parent_id: 'app-1' });
    const running = (draft?: string): ChatReceipt => ({ message_id: 'app-1', state: 'running', closed_reason: null, effects_unconfirmed: false, ...(draft ? { draft } : {}) });

    it('drops a withdrawn draft, so words that are no longer the answer stop showing', async () => {
      const { store, state, advance } = harness();
      store.open(); await settle();
      store.send('Plan my afternoon'); await settle();
      state.receipts.push(running('Let me look'));
      await advance(700);
      state.receipts.push({ ...running(), activity: { kind: 'mail', since: 1 } });
      await advance(1000);
      expect(store.get().local[0]!.draft).toBeUndefined();
      expect(store.get().local[0]!.activity?.kind).toBe('mail');
    });

    it('holds the last words through a closed receipt until the reply lands, then records which reply they became, with no arrival', async () => {
      const { store, state, advance } = harness();
      store.open(); await settle();
      store.send('Plan my afternoon'); await settle();
      state.receipts.push(running('Here is the plan'));
      await advance(700);
      // Closed, but the reply row is not readable yet: the words stay.
      state.history = { messages: [msg('app-1', 'user', 'Plan my afternoon')], next_cursor: null };
      state.receipts.push({ message_id: 'app-1', state: 'completed', closed_reason: null, effects_unconfirmed: false });
      await advance(1000);
      expect(store.get().local[0]!.draft).toBe('Here is the plan');
      expect(store.get().local[0]!.activity).toBeUndefined();
      state.history = { messages: [msg('app-1', 'user', 'Plan my afternoon'), reply('r1', 'Here is the plan for today.')], next_cursor: null };
      await advance(2000);
      expect(store.get().local).toEqual([]);
      expect(store.get().streamed.get('r1')).toBe('Here is the plan');
      expect(store.get().arrived.has('r1')).toBe(false);
    });

    it('lets go of held words when the reply never shows', async () => {
      const { store, state, advance } = harness();
      store.open(); await settle();
      store.send('Plan my afternoon'); await settle();
      state.receipts.push(running('Here is'));
      await advance(700);
      state.history = { messages: [msg('app-1', 'user', 'Plan my afternoon')], next_cursor: null };
      state.receipts.push({ message_id: 'app-1', state: 'completed', closed_reason: null, effects_unconfirmed: false });
      await advance(1000);
      await advance(20_000);
      expect(store.get().local).toEqual([]);
    });

    it('keeps the words an interrupted turn had shown beside its closure', async () => {
      const { store, state, advance } = harness();
      store.open(); await settle();
      store.send('Plan my afternoon'); await settle();
      state.receipts.push(running('Here is'));
      await advance(700);
      state.history = { messages: [msg('app-1', 'user', 'Plan my afternoon')], next_cursor: null };
      state.receipts.push({ message_id: 'app-1', state: 'interrupted', closed_reason: 'interrupted', effects_unconfirmed: false });
      await advance(1000);
      expect(store.get().local[0]).toMatchObject({ state: 'interrupted', draft: 'Here is' });
    });
  });
});

// Attachments, as the app sends them: upload first, then a send naming the upload with the words as its caption.
describe('a chat attachment from the console', () => {
  const UP = `up_${'A'.repeat(22)}`;
  const file = (name = 'lease.pdf', type = 'application/pdf', bytes = 5) => new File([new Uint8Array(bytes)], name, { type });
  // Each upload waits until the test answers it; `signals` are the ones it was given.
  function uploads(served: UploadsServed = { served: 'unknown' }) {
    const calls: { file: File; signal: AbortSignal; answer: (result: UploadResult | Error) => void }[] = [];
    const released: string[] = [];
    const over: Partial<ChatDeps> = {
      upload: (file, signal) => new Promise((resolve, reject) => { calls.push({ file, signal, answer: result => result instanceof Error ? reject(result) : resolve(result) }); }),
      preview: f => `blob:${f.name}`, release: url => { released.push(url); }, uploads: served,
    };
    return { calls, released, over, served };
  }

  it('uploads at once, holds Send until the server has it, then sends it named, with an empty caption, and keeps it for the transcript', async () => {
    const up = uploads();
    const { store, state } = harness(up.over);
    store.open(); await settle();
    store.attach([file()]);
    expect(store.get().attachment).toMatchObject({ name: 'lease.pdf', bytes: 5, kind: 'file', state: 'uploading', preview: null });
    expect(store.send('')).toBe(false);
    expect(store.send('look at this')).toBe(false);
    up.calls[0]!.answer({ upload_id: UP, bytes: 5 }); await settle();
    expect(store.get().attachment).toMatchObject({ state: 'ready' });
    expect(up.served.served).toBe('on');
    expect(store.send('')).toBe(true);
    expect(store.get().attachment).toBeNull();
    expect(store.get().local[0]).toMatchObject({ text: '', attachment: { name: 'lease.pdf', caption: '', uploadId: UP } });
    await settle();
    expect(state.sends).toEqual([['console-client-1', '', UP]]);
    expect(store.get().attached.get('app-1')).toEqual({ name: 'lease.pdf', bytes: 5, kind: 'file', preview: null, caption: '' });
  });

  it('takes a caption up to the caption cap only, and a photo with a preview', async () => {
    const up = uploads();
    const { store, state } = harness(up.over);
    store.open(); await settle();
    store.attach([file('shot.png', 'image/png')]);
    expect(store.get().attachment).toMatchObject({ kind: 'photo', preview: 'blob:shot.png' });
    up.calls[0]!.answer({ upload_id: UP, bytes: 5 }); await settle();
    expect(store.send('x'.repeat(1025))).toBe(false);
    expect(store.send(` ${'x'.repeat(1024)} `)).toBe(true); await settle();
    expect(state.sends[0]).toEqual(['console-client-1', 'x'.repeat(1024), UP]);
  });

  it('refuses an empty or oversized file before sending any of it', async () => {
    const up = uploads();
    const { store } = harness(up.over);
    store.open(); await settle();
    store.attach([file('empty.txt', 'text/plain', 0)]); await settle();
    expect(store.get().attachment).toMatchObject({ state: 'failed', error: 'Waldo couldn’t take that file. Try a different one.', retryable: false });
    store.removeAttachment();
    store.attach([{ name: 'big.mov', type: 'video/quicktime', size: UPLOAD_MAX_BYTES + 1 } as File]); await settle();
    expect(store.get().attachment).toMatchObject({ state: 'failed', error: 'That file is too big. The limit is 20 MB.', retryable: false });
    expect(up.calls).toHaveLength(0);
  });

  it('says why an upload failed, offers Try again only where it can help, and retries the same file', async () => {
    for (const [status, retry] of [[400, false], [413, false], [415, false], [429, true], [503, true], [0, true]] as const) {
      const up = uploads();
      const { store } = harness(up.over);
      store.open(); await settle();
      store.attach([file()]);
      up.calls[0]!.answer(new ChatRequestError(status, 'x')); await settle();
      expect(store.get().attachment).toMatchObject({ state: 'failed', retryable: retry });
      expect(store.send('hi')).toBe(false);
      store.retryAttachment(); await settle();
      expect(up.calls).toHaveLength(retry ? 2 : 1);
      if (retry) { expect(up.calls[1]!.file).toBe(up.calls[0]!.file); up.calls[1]!.answer({ upload_id: UP, bytes: 5 }); await settle(); expect(store.get().attachment?.state).toBe('ready'); }
    }
  });

  it('stops offering attachments on this page after a 404, in every chat', async () => {
    const up = uploads();
    const { store } = harness(up.over);
    store.open(); await settle();
    expect(store.attachable()).toBe(true);
    store.attach([file()]);
    up.calls[0]!.answer(new ChatRequestError(404, 'x')); await settle();
    expect(store.get().attachment).toMatchObject({ state: 'failed', error: 'Waldo doesn’t take attachments here yet.', retryable: false });
    expect([store.get().attachOff, store.attachable(), up.served.served]).toEqual([true, false, 'off']);
    store.removeAttachment();
    store.attach([file()]);
    expect(up.calls).toHaveLength(1);
    const other = harness(up.over).store;
    other.open(); await settle();
    expect(other.attachable()).toBe(false);
    expect(harness().store.attachable()).toBe(false);
  });

  it('holds one attachment per message, takes the first of several, and removing one stops its upload and lets its preview go', async () => {
    const up = uploads();
    const { store } = harness(up.over);
    store.open(); await settle();
    store.attach([file('a.png', 'image/png'), file('b.png', 'image/png')]);
    expect([store.get().attachment?.name, store.get().notice]).toEqual(['a.png', ONLY_FIRST]);
    store.attach([file('c.pdf')]);
    expect([store.get().attachment?.name, store.get().notice, up.calls.length]).toEqual(['a.png', ONE_ATTACHMENT, 1]);
    store.removeAttachment();
    expect([store.get().attachment, store.get().notice, up.calls[0]!.signal.aborted, up.released]).toEqual([null, null, true, ['blob:a.png']]);
    up.calls[0]!.answer({ upload_id: UP, bytes: 5 }); await settle();
    expect(store.get().attachment).toBeNull();
  });

  it('leaves the attachment in place for a quick reply', async () => {
    const up = uploads();
    const { store, state } = harness(up.over);
    store.open(); await settle();
    store.attach([file()]); up.calls[0]!.answer({ upload_id: UP, bytes: 5 }); await settle();
    expect(store.send('Yes', false)).toBe(true); await settle();
    expect(state.sends[0]).toEqual(['console-client-1', 'Yes']);
    expect(store.get().attachment?.state).toBe('ready');
  });

  it('drops a message whose upload is no longer there to take, with a line, instead of offering a resend that cannot work', async () => {
    const up = uploads();
    const { store, state } = harness(up.over);
    store.open(); await settle();
    store.attach([file('a.png', 'image/png')]); up.calls[0]!.answer({ upload_id: UP, bytes: 5 }); await settle();
    state.sendResult = new ChatRequestError(409, 'gone', 'upload_unavailable');
    store.send('see this'); await settle();
    expect([store.get().local, store.get().notice, up.released]).toEqual([[], ATTACHMENT_GONE, ['blob:a.png']]);
  });

  it('resends a message that did not go with the same client id and the same upload', async () => {
    const up = uploads();
    const { store, state } = harness(up.over);
    store.open(); await settle();
    store.attach([file()]); up.calls[0]!.answer({ upload_id: UP, bytes: 5 }); await settle();
    state.sendResult = new ChatRequestError(0, 'offline');
    store.send(''); await settle();
    expect(store.get().local[0]!.state).toBe('failed');
    state.sendResult = null;
    store.retry('console-client-1'); await settle();
    expect(state.sends).toEqual([['console-client-1', '', UP], ['console-client-1', '', UP]]);
  });

  it('hands an attachment message over to history only by its own id, never to another empty-looking row', async () => {
    const up = uploads();
    const { store, state, advance } = harness(up.over);
    store.open(); await settle();
    store.attach([file()]); up.calls[0]!.answer({ upload_id: UP, bytes: 5 }); await settle();
    store.send(''); await settle();
    state.history = { messages: [msg('app-0', 'user', '')], next_cursor: null };
    state.receipts.push({ message_id: 'app-1', state: 'completed', closed_reason: null, effects_unconfirmed: false });
    state.pages.push({ messages: [msg('app-0', 'user', '')], next_cursor: null });
    await advance(700);
    expect(store.get().local[0]).toMatchObject({ landed: false });
    state.history = { messages: [msg('app-0', 'user', ''), msg('app-1', 'user', '[Owner sent a file.]'), msg('app-2', 'assistant', 'Got it.')], next_cursor: null };
    await store.refresh();
    expect(store.get().local).toEqual([]);
    expect(store.get().attached.get('app-1')?.name).toBe('lease.pdf');
  });

  it('lets the draft attachment go when the sign-in ends', async () => {
    const up = uploads();
    const { store } = harness(up.over);
    store.open(); await settle();
    store.attach([file()]);
    up.calls[0]!.answer(new ChatSignInRequired()); await settle();
    expect([store.get().phase, store.get().attachment, store.attachable()]).toEqual(['signed-out', null, false]);
  });
});
