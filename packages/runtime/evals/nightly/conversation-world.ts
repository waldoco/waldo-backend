// The chat a nightly world keeps. By default the store the eval has always used. With compaction on
// (WALDO_EVAL_COMPACTION=on) it is the canonical store the app chat runs on, built with the run's compaction settings,
// so the trial's post-reply hook can write a summary row and the next turn reads it first. A scenario may seed earlier
// rounds of the chat, stored before its first step.
import type { ConversationEntry } from '@waldo/contracts';
import type { ConversationStore } from '../../src/channels/conversation-store';
import { canonicalOwnerConversationStore } from '../../src/conversation/canonical-owner-store';
import type { CompactionSettings } from '../../src/conversation/compaction';
import { localTrustedBriefScheduleInput } from '../../src/llm/run-loop-adapters';

export type SeedRound = Readonly<{ owner: string; waldo: string }>;
export type ConversationSeed = Readonly<{
  // Earlier rounds of the chat, oldest first, ten minutes apart and ending before the scenario starts.
  history?: readonly SeedRound[];
  // Set by the run from WALDO_EVAL_COMPACTION, never by a scenario.
  compaction?: CompactionSettings;
}>;
// A summary row as the final state shows it: its text, and whether it is the one the model reads.
export type SummaryRow = Readonly<{ text: string; live: boolean }>;

// Durable Object storage as the canonical store reads it: get one key or many, list a prefix in either order from an
// exclusive end, put one key or many.
export const conversationStorage = () => {
  const rows = new Map<string, unknown>();
  const sorted = (prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    rows,
    async get(key: string | string[]) { return Array.isArray(key) ? new Map(key.filter((one) => rows.has(one)).map((one) => [one, rows.get(one)])) : rows.get(key); },
    async list({ prefix = '', reverse, limit, end }: { prefix?: string; reverse?: boolean; limit?: number; end?: string } = {}) {
      const found = sorted(prefix).filter(([key]) => end === undefined || key < end);
      if (reverse) found.reverse();
      return new Map(limit === undefined ? found : found.slice(0, limit));
    },
    async put(first: string | Record<string, unknown>, value?: unknown) {
      if (typeof first === 'string') rows.set(first, value);
      else for (const [key, entry] of Object.entries(first)) rows.set(key, entry);
    },
  };
};

export const seededRounds = (history: readonly SeedRound[], chat: string, ownerId: string, start: string): ConversationEntry[] => {
  const end = Date.parse(start);
  return history.flatMap((round, index) => {
    const id = `seed-${index + 1}`, at = end - (history.length - index) * 600_000;
    const row = { ownerId, chatId: chat, threadAnchorId: null, surface: 'app', modelProjection: { mode: 'include' as const } };
    return [
      { ...row, id, parentId: index === 0 ? null : `seed-${index}-reply`, modelPayload: round.owner, appPayload: round.owner, role: 'user' as const, inputOrigin: 'owner' as const, createdAt: at },
      { ...row, id: `${id}-reply`, parentId: id, modelPayload: round.waldo, appPayload: round.waldo, role: 'assistant' as const, createdAt: at + 1 },
    ];
  });
};

export const evalConversation = (seed: ConversationSeed, chat: string, start: string, plain: () => ConversationStore, storage = conversationStorage()) => {
  // The owner an unadmitted responder runs as, so the canonical store's owner check holds for every row it writes.
  const invocation = localTrustedBriefScheduleInput().admission;
  const store = seed.compaction
    ? canonicalOwnerConversationStore(storage as unknown as DurableObjectStorage, { invocation: invocation as never, assertCurrent: async () => undefined }, undefined, undefined, seed.compaction)
    : plain();
  const history = seededRounds(seed.history ?? [], chat, invocation.verified_authority.principal_ref, start);
  const summaries = (): readonly SummaryRow[] => [...storage.rows].filter(([key]) => key.includes(':conv:')).map(([, row]) => row as ConversationEntry)
    .filter((row) => row.role === 'compaction').map((row) => ({ text: row.modelPayload, live: row.modelProjection.mode !== 'omit' }));
  return {
    store,
    // Through the store the world indexes, so the seeded rounds are searchable as earlier messages are.
    seed: async (into: ConversationStore) => { if (history.length) await into.save(history, history.at(-1)!.id); },
    state: () => (seed.compaction ? { compaction: summaries() } : {}),
  };
};
