import type { AppChatActivityKind } from '../../../contracts/src/app/core';

// The text of a message the model labels its final answer, as it arrives. retract: the response went on to call a tool,
// so what it streamed is not the answer.
export type ReplyDeltaSink = Readonly<{ delta(text: string): void; retract(): void }>;

// Showing the owner's reply while the model writes it. Only the text the model labels its final answer reaches here (the
// adapter's job); this module decides how much of it may be shown, and when. Before each release the whole text so far
// goes through the caller's check (reply-gate.ts: every rewrite the delivery path makes), and the first check that fails
// stops the stream for the turn. The released text ends at a word boundary the check's hold-back behind the newest token,
// so a pattern still being written cannot reach back into it.

// Where the draft is shown. show('') withdraws it.
export type ReplyDraftSurface = Readonly<{
  show(text: string): Promise<void>;
  // What kind of work the turn's tools are on while no draft is shown; null clears it. A surface without it shows none.
  activity?(kind: AppChatActivityKind | null): void;
  // Telegram limits how often a bot writes to one chat; the app reads drafts by polling.
  minIntervalMs: number;
  maxUpdates: number;
  maxChars: number;
}>;

export type StopReason = 'canary' | 'armoured_block' | 'artifact_link' | 'secret_url' | 'held_topic' | 'scribe_denied' | 'scribe_rewrite' | 'no_sanitiser' | 'update_cap' | 'surface_failed';
export type ReplyVerdict = Readonly<{ ok: true; holdBack: number } | { ok: false; reason: StopReason }>;
export type ReplyCheck = (text: string) => Promise<ReplyVerdict>;

// The longest prefix of `text` that may be shown: whole words only, `holdBack` characters behind its end, within `max`.
export const releasable = (text: string, holdBack: number, max: number): string => {
  let end = Math.min(text.length - holdBack, max);
  if (end <= 0) return '';
  while (end > 0 && !/\s/.test(text[end]!)) end -= 1;
  return text.slice(0, end).trimEnd();
};

export type StreamOutcome = Readonly<{
  // none: nothing was shown; matched: what was shown is a prefix of the delivered reply; diverged: it is not;
  // failed: the turn ended without a reply.
  outcome: 'none' | 'matched' | 'diverged' | 'failed';
  released: number; updates: number; withdrawals: number; stopped?: StopReason;
  // From the stream's start to the first text shown.
  firstShownMs?: number;
}>;

export type ReplyStream = Readonly<{
  // One per model call: what the previous call showed is withdrawn, and `check` judges this call's text.
  begin(check: ReplyCheck): void;
  deltas: ReplyDeltaSink;
  // The call failed or went on to call tools: what it showed is withdrawn.
  withdraw(): void;
  // A tool of this kind started. It shows until the answer's first words do, or the turn settles.
  activity(kind: AppChatActivityKind): void;
  // The turn ended: `delivered` is the reply the owner gets, null when there is none.
  settle(delivered: string | null): Promise<StreamOutcome>;
}>;

export const createReplyStream = (surface: ReplyDraftSurface, clock: Readonly<{ now(): number; sleep(ms: number): Promise<void> }> = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }): ReplyStream => {
  const startedAt = clock.now();
  let raw = '', released = '', generation = 0, updates = 0, withdrawals = 0;
  let check: ReplyCheck | undefined, stopped: StopReason | undefined, firstShownAt: number | undefined;
  let closed = false, dirty = false, lastShownAt = Number.NEGATIVE_INFINITY;
  let pumping: Promise<void> | null = null;
  let active = false;
  // Settling cuts short the wait between drafts.
  let wake = () => {};
  // Every write to the surface goes through this one chain, so a withdrawal never overtakes the draft it withdraws.
  let writes: Promise<void> = Promise.resolve();
  const write = (text: string) => {
    if (text !== '') clearActivity();
    writes = writes.then(() => surface.show(text)).catch(() => { stopped ??= 'surface_failed'; });
    return writes;
  };
  const showActivity = (kind: AppChatActivityKind | null) => {
    active = kind !== null;
    writes = writes.then(() => surface.activity?.(kind)).catch(() => { stopped ??= 'surface_failed'; });
  };
  const clearActivity = () => { if (active) showActivity(null); };
  const step = async () => {
    const current = generation;
    if (!check) return;
    const text = raw.trimStart();
    const verdict = await check(text);
    if (current !== generation || closed || stopped) return;
    if (!verdict.ok) { stopped = verdict.reason; return; }
    const cut = releasable(text, verdict.holdBack, surface.maxChars);
    if (cut.length <= released.length || !cut.startsWith(released)) return;
    if (updates >= surface.maxUpdates) { stopped = 'update_cap'; return; }
    updates += 1; released = cut; lastShownAt = clock.now(); firstShownAt ??= lastShownAt;
    await write(cut);
  };
  const pump = async () => {
    while (dirty && !closed && !stopped) {
      dirty = false;
      const wait = lastShownAt + surface.minIntervalMs - clock.now();
      if (wait > 0) await new Promise<void>((resolve) => { wake = resolve; void clock.sleep(wait).then(resolve); });
      await step();
    }
  };
  const kick = () => {
    dirty = true;
    pumping ??= pump().finally(() => { pumping = null; if (dirty && !closed && !stopped) kick(); });
  };
  const withdraw = () => {
    generation += 1; raw = '';
    if (released === '') return;
    released = ''; withdrawals += 1;
    void write('');
  };
  return {
    begin: (next) => { withdraw(); check = next; },
    deltas: {
      delta: (text) => { if (closed || stopped) return; raw += text; kick(); },
      retract: withdraw,
    },
    withdraw,
    activity: (kind) => { if (!closed) showActivity(kind); },
    settle: async (delivered) => {
      closed = true;
      wake();
      await pumping;
      clearActivity();
      await writes;
      const outcome = released === '' ? 'none' : delivered === null ? 'failed' : delivered.startsWith(released) ? 'matched' : 'diverged';
      return { outcome, released: released.length, updates, withdrawals, ...(stopped ? { stopped } : {}), ...(firstShownAt === undefined ? {} : { firstShownMs: firstShownAt - startedAt }) };
    },
  };
};
