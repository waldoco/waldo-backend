import { cancelChatMessage, ChatRequestError, ChatSignInRequired, fetchChatPage, fetchReceipt, newClientId, sendChatMessage, type ChatMessage, type ChatPage, type ChatReceipt, type RunState } from './chat-model';

// A message typed here, from the moment it is sent until history shows it and its turn has closed. `landed` means
// the server's copy is in history, so only the turn's state is still drawn from here.
export type LocalMessage = {
  clientId: string; text: string; sentAt: number; state: 'sending' | 'failed' | RunState; messageId: string | null;
  error: string | null; closedReason: string | null; effectsUnconfirmed: boolean; stopping: boolean; landed: boolean;
  // The newest history row when this was sent: only a row after it can be this message's server copy.
  after: string | null;
};
export type ChatSnapshot = {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'signed-out'; error: string | null;
  messages: readonly ChatMessage[]; nextCursor: string | null; older: 'idle' | 'loading' | 'error';
  local: readonly LocalMessage[]; draft: string;
  // Live updates are slowed or paused; the conversation on screen stays as it was.
  notice: string | null;
  // Replies that arrived while the page was open, drawn with an arrival motion once.
  arrived: ReadonlySet<string>;
};

export type ChatDeps = {
  page: (cursor: string | null, limit: number) => Promise<ChatPage>;
  send: (clientId: string, text: string) => Promise<ChatReceipt>;
  receipt: (clientId: string) => Promise<ChatReceipt>;
  cancel: (clientId: string) => Promise<ChatReceipt>;
  id: () => string;
  now: () => number;
  setTimer: (run: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  visible: () => boolean;
};

const PAGE = 30;
// Polling is sized to how Waldo's turns behave, not to a fixed guess: a reply can take seconds or, for an errand
// with browsing, many minutes. Early checks are quick so short replies feel immediate; then it settles at one check
// every 5 s and never gives up while the turn is open. Reads share the owner's app budget (120 a minute across the
// app and the console), so the steady rate (12 a minute, plus a history read every 15 s) leaves the app most of it.
const RECEIPT_DELAYS = [700, 1000, 1500, 2000, 3000, 4000];
const RECEIPT_STEADY = 5000;
// After ten minutes a turn is a long errand: one check every 15 s is still timely.
const RECEIPT_LONG_AFTER = 10 * 60_000, RECEIPT_LONG = 15_000;
const HISTORY_DURING_RUN = 15_000;
const HISTORY_IDLE = 20_000;
// Network trouble backs off to at most 30 s; a 429 waits as long as the server asks, else 30 s.
const BACKOFF_MAX = 30_000;
const active = (state: LocalMessage['state']) => state === 'sending' || state === 'admitted' || state === 'running';
const closed = (state: LocalMessage['state']) => state === 'completed' || state === 'interrupted' || state === 'revoked';

export const browserDeps = (): ChatDeps => ({
  page: fetchChatPage, send: sendChatMessage, receipt: fetchReceipt, cancel: cancelChatMessage, id: newClientId, now: () => Date.now(),
  setTimer: (run, ms) => window.setTimeout(run, ms), clearTimer: id => window.clearTimeout(id),
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
});

export function createChatStore(deps: ChatDeps) {
  let snap: ChatSnapshot = { phase: 'idle', error: null, messages: [], nextCursor: null, older: 'idle', local: [], draft: '', notice: null, arrived: new Set() };
  const listeners = new Set<() => void>();
  const set = (next: Partial<ChatSnapshot>) => { snap = { ...snap, ...next }; listeners.forEach(listener => listener()); };
  const setLocal = (clientId: string, change: Partial<LocalMessage>) => set({ local: snap.local.map(item => item.clientId === clientId ? { ...item, ...change } : item) });
  const find = (clientId: string) => snap.local.find(item => item.clientId === clientId);

  let open = false, idleTimer: number | null = null, refreshing: Promise<void> | null = null, lastHistory = 0;
  const polls = new Map<string, { timer: number; tries: number; failures: number }>();

  const signedOut = (error: unknown) => { if (error instanceof ChatSignInRequired) { set({ phase: 'signed-out', error: error.message }); stopAll(); return true; } return false; };
  const stopAll = () => { for (const poll of polls.values()) deps.clearTimer(poll.timer); polls.clear(); if (idleTimer !== null) deps.clearTimer(idleTimer); idleTimer = null; };

  // A user row in history that is this local message: its run id, or the same words in a row that arrived after it was
  // sent and that no earlier local message has already claimed.
  const reconcile = (messages: readonly ChatMessage[]) => {
    const claimed = new Set<string>();
    return snap.local.map(item => {
      if (item.state === 'sending' || item.state === 'failed' || item.landed) return item;
      const from = item.after === null ? 0 : messages.findIndex(message => message.id === item.after) + 1;
      const row = messages.find(message => message.role === 'user' && message.id === item.messageId)
        ?? messages.slice(from).find(message => message.role === 'user' && !claimed.has(message.id) && message.text.trim() === item.text.trim());
      if (row) claimed.add(row.id);
      return row ? { ...item, landed: true } : item;
    }).filter(item => !(item.landed && closed(item.state) && !item.effectsUnconfirmed && item.closedReason === null));
  };

  // The newest page replaces the tail it overlaps, so an edited row (a card that was decided) shows its new form.
  const mergeNewest = (fresh: readonly ChatMessage[]) => {
    if (!snap.messages.length || !fresh.length) return fresh.length ? [...fresh] : [...snap.messages];
    const at = snap.messages.findIndex(message => message.id === fresh[0]!.id);
    return at >= 0 ? [...snap.messages.slice(0, at), ...fresh] : [...snap.messages, ...fresh.filter(message => !snap.messages.some(known => known.id === message.id))];
  };

  const refresh = (): Promise<void> => refreshing ?? (refreshing = (async () => {
    try {
      const page = await deps.page(null, PAGE);
      lastHistory = deps.now();
      const known = new Set(snap.messages.map(message => message.id));
      const arrived = snap.phase === 'ready' ? new Set(page.messages.filter(message => message.role === 'assistant' && !known.has(message.id)).map(message => message.id)) : new Set<string>();
      const messages = snap.phase === 'ready' ? mergeNewest(page.messages) : page.messages;
      set({ phase: 'ready', error: null, messages, nextCursor: snap.phase === 'ready' && snap.messages.length ? snap.nextCursor : page.next_cursor, local: reconcile(messages), arrived, notice: snap.notice && polls.size === 0 ? null : snap.notice });
    } catch (error) {
      if (signedOut(error)) return;
      if (snap.phase !== 'ready') set({ phase: 'error', error: error instanceof Error ? error.message : 'Waldo couldn’t be reached.' });
      else set({ notice: error instanceof ChatRequestError && error.status === 429 ? 'Updates are slowed for a minute. Your conversation is safe.' : 'Can’t reach Waldo right now. Retrying.' });
    } finally { refreshing = null; }
  })());

  const scheduleIdle = () => {
    if (idleTimer !== null) deps.clearTimer(idleTimer);
    idleTimer = open ? deps.setTimer(() => { idleTimer = null; if (deps.visible() && polls.size === 0) void refresh().then(scheduleIdle); else scheduleIdle(); }, HISTORY_IDLE) : null;
  };

  const poll = (clientId: string, delay: number) => {
    const current = polls.get(clientId);
    if (current) deps.clearTimer(current.timer);
    const entry = { timer: 0, tries: current?.tries ?? 0, failures: current?.failures ?? 0 };
    entry.timer = deps.setTimer(() => void check(clientId), delay);
    polls.set(clientId, entry);
  };
  const nextDelay = (clientId: string) => {
    const entry = polls.get(clientId), item = find(clientId);
    const tries = entry?.tries ?? 0;
    if (item && deps.now() - item.sentAt > RECEIPT_LONG_AFTER) return RECEIPT_LONG;
    return RECEIPT_DELAYS[tries] ?? RECEIPT_STEADY;
  };
  const check = async (clientId: string) => {
    const entry = polls.get(clientId);
    if (!entry || !find(clientId)) { polls.delete(clientId); return; }
    entry.tries += 1;
    try {
      const receipt = await deps.receipt(clientId);
      entry.failures = 0;
      setLocal(clientId, { state: receipt.state, messageId: receipt.message_id, closedReason: receipt.closed_reason, effectsUnconfirmed: receipt.effects_unconfirmed, stopping: false });
      if (snap.notice) set({ notice: null });
      if (closed(receipt.state)) { polls.delete(clientId); await refresh(); scheduleIdle(); return; }
      // Progress notes and earlier replies land in history while a long turn runs.
      if (deps.now() - lastHistory > HISTORY_DURING_RUN) void refresh();
      poll(clientId, nextDelay(clientId));
    } catch (error) {
      if (signedOut(error)) return;
      entry.failures += 1;
      const limited = error instanceof ChatRequestError && error.status === 429;
      // A receipt the server doesn't have yet (just admitted on another isolate) reads as a pause, not a failure.
      set({ notice: limited ? 'Updates are slowed for a minute. Waldo is still working.' : error instanceof ChatRequestError && error.status === 404 ? null : 'Can’t reach Waldo right now. Retrying.' });
      const wait = limited ? Math.min(((error as ChatRequestError).retryAfter ?? 30) * 1000, 60_000) : Math.min(RECEIPT_STEADY * 2 ** (entry.failures - 1), BACKOFF_MAX);
      poll(clientId, wait);
    }
  };

  const deliver = async (clientId: string) => {
    const item = find(clientId);
    if (!item) return;
    try {
      const receipt = await deps.send(clientId, item.text);
      setLocal(clientId, { state: receipt.state, messageId: receipt.message_id, error: null });
      poll(clientId, RECEIPT_DELAYS[0]!);
    } catch (error) {
      if (signedOut(error)) return;
      setLocal(clientId, { state: 'failed', error: error instanceof Error ? error.message : 'Not sent.' });
    }
  };

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: () => snap,
    working: () => snap.local.some(item => active(item.state)),
    open() {
      open = true;
      if (snap.phase !== 'ready') set({ phase: 'loading', error: null });
      void refresh().then(scheduleIdle);
    },
    close() { open = false; if (idleTimer !== null) deps.clearTimer(idleTimer); idleTimer = null; },
    retryLoad() { set({ phase: 'loading', error: null }); void refresh().then(scheduleIdle); },
    refresh,
    async loadOlder() {
      if (!snap.nextCursor || snap.older === 'loading') return;
      set({ older: 'loading' });
      try {
        const page = await deps.page(snap.nextCursor, PAGE);
        const known = new Set(snap.messages.map(message => message.id));
        set({ messages: [...page.messages.filter(message => !known.has(message.id)), ...snap.messages], nextCursor: page.next_cursor, older: 'idle' });
      } catch (error) { if (!signedOut(error)) set({ older: 'error' }); }
    },
    setDraft(draft: string) { set({ draft }); },
    send(text: string): boolean {
      const words = text.trim();
      if (!words || snap.phase === 'signed-out') return false;
      const item: LocalMessage = { clientId: deps.id(), text: words, sentAt: deps.now(), state: 'sending', messageId: null, error: null, closedReason: null, effectsUnconfirmed: false, stopping: false, landed: false, after: snap.messages.at(-1)?.id ?? null };
      set({ local: [...snap.local, item], draft: '' });
      void deliver(item.clientId);
      return true;
    },
    // The same client id makes a resend idempotent: a message the server did take is not taken twice.
    retry(clientId: string) { const item = find(clientId); if (!item || item.state !== 'failed') return; setLocal(clientId, { state: 'sending', error: null }); void deliver(clientId); },
    // An interrupted turn is asked again as a new message.
    askAgain(clientId: string) { const item = find(clientId); if (!item) return; set({ local: snap.local.filter(other => other.clientId !== clientId) }); this.send(item.text); },
    dismiss(clientId: string) { const poll = polls.get(clientId); if (poll) deps.clearTimer(poll.timer); polls.delete(clientId); set({ local: snap.local.filter(item => item.clientId !== clientId) }); },
    async stop(clientId: string) {
      const item = find(clientId);
      if (!item || !active(item.state) || item.state === 'sending' || item.stopping) return;
      setLocal(clientId, { stopping: true });
      try {
        const receipt = await deps.cancel(clientId);
        setLocal(clientId, { state: receipt.state, closedReason: receipt.closed_reason, effectsUnconfirmed: receipt.effects_unconfirmed, stopping: false });
        if (closed(receipt.state)) { const poll = polls.get(clientId); if (poll) deps.clearTimer(poll.timer); polls.delete(clientId); await refresh(); }
      } catch (error) { if (!signedOut(error)) { setLocal(clientId, { stopping: false }); set({ notice: 'Stop didn’t go through. Waldo is still working; try again.' }); } }
    },
    dispose: stopAll,
  };
}
export type ChatStore = ReturnType<typeof createChatStore>;

let shared: ChatStore | null = null;
// One store per page load, so a sent message keeps its state while you move between console pages.
export const chatStore = (): ChatStore => shared ?? (shared = createChatStore(browserDeps()));
