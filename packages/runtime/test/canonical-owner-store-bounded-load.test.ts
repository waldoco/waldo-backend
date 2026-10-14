import { afterEach, describe, expect, it } from 'vitest';
import { ConversationTree, type ConversationEntry } from '@waldo/contracts';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION, compactedHistory, compactionPlan, liveCompaction, ownerRowsSince, supersededCompaction } from '../src/conversation/compaction';

const PRINCIPAL = 'prn_10000000000000000000000000000001', TENANT = 'tnt_1', THREAD = 'thr_bounded';
const MAIN = `owner:${PRINCIPAL}`, THREAD_CHAT = `owner:${PRINCIPAL}:${THREAD}`, IMESSAGE = 'imessage-1';
const prefixOf = (thread?: string) => `canonical-owner-v1:${PRINCIPAL}:${TENANT}:${thread ? `thread:${thread}:` : ''}`;

// A storage double with the Durable Object list/get semantics the store relies on (prefix, reverse, limit, exclusive end,
// batched get), counting every read so a test can bound them.
const countingStorage = (data = new Map<string, unknown>()) => {
  const reads = { lists: 0, gets: 0, keys: 0, rows: 0 };
  const storage = {
    data, reads,
    get: async (key: string | string[]) => {
      reads.gets += 1;
      if (!Array.isArray(key)) { reads.keys += 1; return data.get(key); }
      reads.keys += key.length;
      return new Map(key.filter((one) => data.has(one)).map((one) => [one, data.get(one)]));
    },
    put: async (entries: Record<string, unknown> | string, value?: unknown) => { if (typeof entries === 'string') data.set(entries, value); else for (const [key, item] of Object.entries(entries)) data.set(key, item); },
    list: async ({ prefix, reverse, limit, end }: { prefix: string; reverse?: boolean; limit?: number; end?: string }) => {
      reads.lists += 1;
      const rows = [...data].filter(([key]) => key.startsWith(prefix) && (end === undefined || key < end)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (reverse) rows.reverse();
      const page = limit ? rows.slice(0, limit) : rows;
      reads.rows += page.length;
      return new Map(page);
    },
  };
  return storage as unknown as DurableObjectStorage & { data: Map<string, unknown>; reads: typeof reads };
};
// The same rows behind a list that hands back the whole chain in one call: the store then reads every row, as before the bound.
const unboundedView = (data: Map<string, unknown>) => {
  const storage = countingStorage(data);
  let listed = false;
  const list = storage.list.bind(storage);
  return Object.assign(storage, { list: async (options: { prefix: string; reverse?: boolean }) => {
    if (listed) return new Map();
    listed = true;
    return list({ prefix: options.prefix, ...(options.reverse ? { reverse: true } : {}) });
  } }) as typeof storage;
};
const contextFor = (conversationRef?: string) => ({
  invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } } as never,
  assertCurrent: async () => undefined, ...(conversationRef ? { conversationRef } : {}),
});

type Row = ConversationEntry;
const row = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, extra: Partial<Row> = {}): Row => ({
  id, ownerId: PRINCIPAL, chatId: MAIN, parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), ...extra,
});
const witnessOf = (entry: unknown) => ({ lineage: 'canonical_v1', principal_ref: PRINCIPAL, tenant_ref: TENANT, entry });
// Rows written in this order, each with its exact witness unless listed otherwise.
const stored = (rows: readonly Row[], leaf: string | null, options: Readonly<{ thread?: string; unwitnessed?: readonly string[]; witness?: Readonly<Record<string, unknown>> }> = {}) => {
  const prefix = prefixOf(options.thread);
  const data = new Map<string, unknown>([[`${prefix}count`, rows.length], ...(leaf === null ? [] : [[`${prefix}leaf`, leaf] as [string, unknown]])]);
  rows.forEach((entry, index) => {
    data.set(`${prefix}conv:${String(index).padStart(10, '0')}`, entry);
    if (!options.unwitnessed?.includes(entry.id)) data.set(`${prefix}witness:${entry.id}`, witnessOf(options.witness?.[entry.id] ?? entry));
  });
  return data;
};
// Synthetic text of a fixed size: about 500 window tokens a row, so the window holds about 200 rows.
const text = (label: string, size = 2_000) => `${label} ${'x'.repeat(size)}`;
const chain = (rounds: number, chat = MAIN, start = 0, parent: string | null = null, size = 2_000) => {
  const rows: Row[] = [];
  for (let round = start; round < start + rounds; round += 1) {
    rows.push(row(`${chat}-u${round}`, parent, 'user', text(`question ${round}`, size), { chatId: chat, createdAt: 1_000 + round * 10 }));
    rows.push(row(`${chat}-u${round}-reply`, `${chat}-u${round}`, 'assistant', text(`answer ${round}`, size), { chatId: chat, createdAt: 1_001 + round * 10 }));
    parent = `${chat}-u${round}-reply`;
  }
  return rows;
};

// What an owner turn builds from a load: the tree in load order, each chat's leaf, and the model's view of a next message
// on the turn's chat (or of a retried message already stored).
const turnView = async (storage: DurableObjectStorage, chat: string, options: Readonly<{ thread?: string; retry?: string }> = {}) => {
  const store = canonicalOwnerConversationStore(storage, contextFor(chat), undefined, options.thread);
  const { entries, leafId } = await store.load();
  const tree = new ConversationTree(), leaves = new Map<string, string>();
  for (const entry of entries) { tree.append(entry); if (entry.role !== 'compaction') leaves.set(entry.chatId, entry.id); }
  const next = options.retry ?? 'next';
  if (!options.retry) tree.append(row('next', leaves.get(chat) ?? null, 'user', 'Next question.', { chatId: chat }));
  const view = { leafId, chatLeaf: leaves.get(chat) ?? null, messages: compactedHistory(tree, next).messages };
  // With compaction off a turn never plans one, so the plan's inputs are part of the turn's view only with it on.
  if (!COMPACTION.enabled) return view;
  const live = liveCompaction(tree, next);
  return { ...view, live: live?.id ?? null, covers: compactionPlan(tree, next, live)?.covers ?? null, ownerRows: ownerRowsSince(tree, next, live?.createdAt ?? null) };
};
const equivalent = async (data: Map<string, unknown>, chat: string, options: Readonly<{ thread?: string; retry?: string }> = {}) => {
  const bounded = countingStorage(new Map(data)), full = unboundedView(new Map(data));
  const view = await turnView(bounded, chat, options);
  expect(view).toEqual(await turnView(full, chat, options));
  return { view, reads: bounded.reads };
};

afterEach(() => { COMPACTION.enabled = false; });

describe('an owner turn reads only the window of a long chat', () => {
  it('reads a bounded number of rows on a 5,000-row chain, and the same context as a whole-chain read', async () => {
    const data = stored(chain(2_500), `${MAIN}-u2499-reply`);
    const { view, reads } = await equivalent(data, MAIN);
    // The rows the window keeps for the next message, the new message itself aside.
    const windowRows = view.messages.length - 1;
    expect(windowRows).toBeGreaterThan(150);
    expect(windowRows).toBeLessThan(250);
    // The bound: the window and the row past it, plus at most one page of 128 rows read ahead.
    expect(reads.rows).toBeLessThanOrEqual(windowRows + 1 + 128);
    expect(reads.lists).toBeLessThanOrEqual(Math.ceil((windowRows + 1) / 128) + 1);
    expect(reads.keys).toBeLessThanOrEqual(reads.rows + 1);
    expect(reads.gets).toBeLessThanOrEqual(reads.lists + 1);
  });

  it('keeps the same bound when the chain is twice as long', async () => {
    const short = countingStorage(stored(chain(2_500), `${MAIN}-u2499-reply`));
    const long = countingStorage(stored(chain(5_000), `${MAIN}-u4999-reply`));
    await turnView(short, MAIN);
    await turnView(long, MAIN);
    expect(long.reads).toEqual(short.reads);
  });
});

// A summary row of a span ending at `toId`, written right after `toId` so it sits in the slots after the row it covers.
const summary = (toId: string, fromId: string, rows: number, chat = MAIN, extra: Partial<Row> = {}): Row => ({
  id: `${toId}-compaction`, ownerId: PRINCIPAL, chatId: chat, parentId: toId, threadAnchorId: null, surface: 'app', modelPayload: `Summary through ${toId}.`, appPayload: '',
  modelProjection: { mode: 'include' }, role: 'compaction', covers: { from_id: fromId, to_id: toId, rows }, ...extra,
});
// Inserted after `id`, and timed just after it, as a summary is written after the span it covers.
const after = (rows: readonly Row[], id: string, inserted: Row) => {
  const at = rows.findIndex((entry) => entry.id === id) + 1;
  return [...rows.slice(0, at), { ...inserted, createdAt: (rows[at - 1]!.createdAt ?? 0) + 5 }, ...rows.slice(at)];
};
const broken = (id: string, parentId: string | null): Row => ({ ...row(id, parentId, 'assistant', 'Broken row.'), role: undefined } as unknown as Row);

describe('the window read gives a turn the same context and leaf as a whole-chain read', () => {
  it('a chain shorter than the window reads every row', async () => {
    const { reads } = await equivalent(stored(chain(10), `${MAIN}-u9-reply`), MAIN);
    expect(reads.rows).toBe(20);
  });

  it('a chain with a summary row, compaction on or off, with the summary near the head or far behind it', async () => {
    const base = chain(600);
    const near = after(after(base, `${MAIN}-u100-reply`, summary(`${MAIN}-u100-reply`, `${MAIN}-u0`, 202, MAIN, { modelPayload: '[superseded summary]', modelProjection: { mode: 'omit' } })),
      `${MAIN}-u580-reply`, summary(`${MAIN}-u580-reply`, `${MAIN}-u0`, 1_162));
    const far = after(base, `${MAIN}-u100-reply`, summary(`${MAIN}-u100-reply`, `${MAIN}-u0`, 202));
    for (const enabled of [false, true]) {
      COMPACTION.enabled = enabled;
      const nearRead = await equivalent(stored(near, `${MAIN}-u599-reply`), MAIN);
      expect(nearRead.view.messages[0]!.content).toMatch(enabled ? `Summary through ${MAIN}-u580-reply.` : /^(question|answer) /);
      expect(nearRead.reads.rows).toBeLessThanOrEqual(enabled ? 128 : 256);
      const farRead = await equivalent(stored(far, `${MAIN}-u599-reply`), MAIN);
      expect(farRead.view.messages[0]!.content).toMatch(enabled ? `Summary through ${MAIN}-u100-reply.` : /^(question|answer) /);
    }
  });

  it('an app thread chain, and a main prefix that holds two chats with the stored leaf on the other one', async () => {
    await equivalent(stored(chain(500, THREAD_CHAT), `${THREAD_CHAT}-u499-reply`, { thread: THREAD }), THREAD_CHAT, { thread: THREAD });
    const app = chain(400, MAIN), imessage = chain(400, IMESSAGE);
    const mixed = app.flatMap((entry, index) => [entry, imessage[index]!]);
    await equivalent(stored(mixed, `${IMESSAGE}-u399-reply`), MAIN);
    await equivalent(stored(mixed, `${IMESSAGE}-u399-reply`), IMESSAGE);
    // A chat with no row yet starts a new chain.
    const fresh = await equivalent(stored(app, `${MAIN}-u399-reply`), IMESSAGE);
    expect(fresh.view.chatLeaf).toBeNull();
  });

  it('forget-redacted, replaced, omitted and untimed rows inside the window', async () => {
    const rows = chain(500).map((entry, index): Row => {
      const { createdAt: _untimed, ...legacy } = entry;
      if (index % 7 === 0) return { ...entry, modelPayload: '[forgotten]', appPayload: '[forgotten]' };
      if (index % 11 === 0) return { ...entry, modelProjection: { mode: 'replace', payload: `[forgotten] ${'r'.repeat(3_000)}` } };
      if (index % 13 === 0) return { ...entry, modelProjection: { mode: 'omit' } };
      return index % 5 === 0 ? legacy : entry;
    });
    const { view } = await equivalent(stored(rows, `${MAIN}-u499-reply`), MAIN);
    expect(view.messages.some((message) => message.content === '[forgotten]')).toBe(true);
  });

  it('a retried owner message already stored, with a did-not-finish reply after it, keeps its own window', async () => {
    const rows = [...chain(500), row('retry', `${MAIN}-u499-reply`, 'user', text('retried question')), row('retry-did-not-finish', 'retry', 'assistant', text('did not finish', 40_000))];
    const { view } = await equivalent(stored(rows, `${MAIN}-u499-reply`), MAIN, { retry: 'retry' });
    expect(view.chatLeaf).toBe('retry-did-not-finish');
  });

  it('a shape-faulted row in the window is skipped and counted as before, with its children hung on the row above it', async () => {
    const rows = chain(500);
    const at = rows.findIndex((entry) => entry.id === `${MAIN}-u480-reply`);
    const faulted = [...rows.slice(0, at + 1), broken('broken-1', `${MAIN}-u480-reply`), { ...rows[at + 1]!, parentId: 'broken-1' }, ...rows.slice(at + 2), broken('broken-leaf', `${MAIN}-u499-reply`)];
    const data = stored(faulted, 'broken-leaf', { unwitnessed: ['broken-1'] });
    await equivalent(data, MAIN);
    const skips = async (storage: DurableObjectStorage) => {
      const seen: unknown[] = [];
      await canonicalOwnerConversationStore(storage, contextFor(MAIN), (skipped) => seen.push(skipped)).load();
      return seen;
    };
    const bounded = await skips(countingStorage(new Map(data)));
    expect(bounded).toEqual(await skips(unboundedView(new Map(data))));
    expect(bounded).toEqual([{ checks: { role: { count: 2, unwitnessed: 1 } }, orphans: 1, leaf: true }]);
  });

  it('a missing or different witness on a row it reads fails the read as before', async () => {
    const rows = chain(500);
    const missing = stored(rows, `${MAIN}-u499-reply`, { unwitnessed: [`${MAIN}-u490`] });
    const different = stored(rows, `${MAIN}-u499-reply`, { witness: { [`${MAIN}-u490`]: { ...rows[980]!, modelPayload: 'changed' } } });
    const brokenWitness = stored([...rows, broken('broken-1', `${MAIN}-u499-reply`)], `${MAIN}-u499-reply`, { witness: { 'broken-1': { id: 'broken-1', changed: true } } });
    for (const data of [missing, different, brokenWitness]) {
      await expect(turnView(countingStorage(new Map(data)), MAIN)).rejects.toThrow('canonical history witness mismatch');
      await expect(turnView(unboundedView(new Map(data)), MAIN)).rejects.toThrow('canonical history witness mismatch');
    }
  });

  it('verifies every row it loads, and loads no row older than the window it read', async () => {
    const rows = chain(2_500);
    // A row far behind the window: the whole-chain read fails on it, the window read never reads or loads it.
    const data = stored(rows, `${MAIN}-u2499-reply`, { unwitnessed: [`${MAIN}-u3`] });
    await expect(turnView(unboundedView(new Map(data)), MAIN)).rejects.toThrow('canonical history witness mismatch');
    const storage = countingStorage(new Map(data));
    const { entries } = await canonicalOwnerConversationStore(storage, contextFor(MAIN)).load();
    expect(entries).toHaveLength(storage.reads.rows);
    expect(storage.reads.keys).toBe(storage.reads.rows + 1);
    expect(entries[0]!.parentId).toBeNull();
    expect(entries.slice(1).every((entry, index) => entry.parentId === entries[index]!.id)).toBe(true);
  });
});

describe('writes after a window read', () => {
  it('a save after the read lists one row, and the boundary row it re-rooted is saved back as stored', async () => {
    const storage = countingStorage(stored(chain(2_500), `${MAIN}-u2499-reply`));
    const store = canonicalOwnerConversationStore(storage, contextFor(MAIN));
    const { entries } = await store.load();
    const before = { ...storage.reads };
    await store.save([row('next', `${MAIN}-u2499-reply`, 'user', 'Next question.'), row('next-reply', 'next', 'assistant', 'Next answer.')], 'next-reply');
    expect(storage.reads.rows - before.rows).toBe(1);
    await store.save([entries[0]!], 'next-reply');
    expect(storage.data.get(`${prefixOf()}count`)).toBe(5_002);
  });

  it('a summary supersedes the previous one found by its key from the read, or by reading back when the read did not see it', async () => {
    const rows = after(chain(2_500), `${MAIN}-u2400-reply`, summary(`${MAIN}-u2400-reply`, `${MAIN}-u0`, 4_802));
    const next = summary(`${MAIN}-u2480-reply`, `${MAIN}-u0`, 4_962);
    for (const read of [true, false]) {
      const storage = countingStorage(stored(rows, `${MAIN}-u2499-reply`));
      const store = canonicalOwnerConversationStore(storage, contextFor(MAIN));
      if (read) await store.load();
      const before = { ...storage.reads };
      await store.appendCompaction!(next, `${MAIN}-u2400-reply-compaction`);
      // The superseded row's own key, or two pages read back to it, and the one-row read of the last slot.
      expect(storage.reads.rows - before.rows).toBe(read ? 1 : 257);
      expect(storage.data.get(`${prefixOf()}conv:${String(rows.findIndex((entry) => entry.role === 'compaction')).padStart(10, '0')}`))
        .toEqual(supersededCompaction(rows.find((entry) => entry.role === 'compaction')!));
      expect(storage.data.get(`${prefixOf()}leaf`)).toBe(`${MAIN}-u2499-reply`);
    }
  });
});

describe('against Durable Object storage', () => {
  it('pages back through a long chain with the real list and get, and loads what a whole-chain read loads', async () => {
    const { env } = await import('cloudflare:workers');
    const { runInDurableObject } = await import('cloudflare:test');
    const data = stored(chain(300), `${MAIN}-u299-reply`);
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('bounded-history-load')), async (_instance, state) => {
      for (const [key, value] of data) state.storage.kv.put(key, value);
      const { entries, leafId } = await canonicalOwnerConversationStore(state.storage, contextFor(MAIN)).load();
      const whole = await canonicalOwnerConversationStore(unboundedView(new Map(data)), contextFor(MAIN)).load();
      expect(leafId).toBe(whole.leafId);
      // About 500 tokens a row: the window holds about 200 rows, so the read takes a second page through the list's end key.
      expect(entries).toHaveLength(256);
      expect(entries.map((entry) => entry.id)).toEqual(whole.entries.slice(-256).map((entry) => entry.id));
      expect(entries[0]!.parentId).toBeNull();
      await state.storage.deleteAll();
    });
  }, 60_000);
});
