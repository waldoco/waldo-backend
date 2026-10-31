import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore, type ClaimStore } from '../src/memory/claims';
import { outsideView } from '../src/memory/outside-view';
import { recallForTurn, type RecallEpisodes } from '../src/memory/turn-recall';
import { coreMemory, CORE_ROOM, RECALLED_ROOM, reviewedThrough, selectMemory } from '../src/memory/select-memory';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { memoryHandlers } from '../src/tools/live/memory';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

// Option B of the memory redesign: the core holds the model's pins, what the owner said since memory was last reviewed and a
// count of the rest by area; recall gives full lines, then stubs the model opens with read_memory({ ids }). Synthetic only.
const REVIEWED = '2026-10-30T22:00:00.000Z', MARK = reviewedThrough(Date.parse(REVIEWED)), BEFORE = '2026-10-30T09:00:00.000Z', AFTER = '2026-10-31T08:00:00.000Z';
let sequence = 0;
const inOwner = <R>(work: (store: ClaimStore) => R | Promise<R>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`select-memory-${sequence++}`)), (_instance, state) =>
    work(claimStore(state.storage.sql, (fn) => state.storage.transactionSync(fn))));
const inOwnerSql = <R>(work: (store: ClaimStore, sql: SqlStorage) => R | Promise<R>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`select-memory-${sequence++}`)), (_instance, state) =>
    work(claimStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)), state.storage.sql));
const said = (store: ClaimStore, text: string, at: string, extra: Readonly<{ kind?: string; area?: string }> = {}) => {
  store.add({ kind: extra.kind ?? 'fact', text, source: 'stated', evidence: text, origin: 'owner', source_ref: `owner, ${text}`, ...(extra.area ? { area: extra.area } : {}) }, at);
  return store.allClaims().find((claim) => claim.text === text)!.id;
};
const tags = (text: string) => [...text.matchAll(/\bc(\d+) · /g)].map((match) => Number(match[1]));
const stubs = (text: string) => [...text.matchAll(/\bc(\d+) stub · /g)].map((match) => Number(match[1]));
const blockOf = (text: string, tag: string) => text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? '';

describe('the core block', () => {
  it('holds the pins in pin order, then what the owner said since the last review, oldest first, and counts the rest by area', async () => {
    await inOwner((store) => {
      const pinnedProfile = said(store, 'The owner goes by Sam', BEFORE);
      const pinnedFact = said(store, 'The owner works from the Indiranagar office on Mondays', BEFORE, { area: 'work' });
      said(store, 'The owner\'s sister lives in Pune', BEFORE, { area: 'people' });
      said(store, 'The owner keeps the spare key with the neighbour', BEFORE);
      const first = said(store, 'The owner moved the grocery run to Thursdays', AFTER, { area: 'home' });
      const second = said(store, 'The owner prefers window seats', AFTER);
      said(store, 'The owner\'s knee aches after long runs', AFTER, { kind: 'health', area: 'body' });
      expect(store.pin(pinnedProfile, 'profile', 1)).toBe(true);
      expect(store.pin(pinnedFact, 'facts', 1)).toBe(true);
      const core = coreMemory(store, CORE_ROOM, MARK);
      expect(tags(blockOf(core, 'owner_profile'))).toEqual([pinnedProfile]);
      expect(tags(blockOf(core, 'owner_facts'))).toEqual([pinnedFact]);
      expect(tags(blockOf(core, 'owner_new'))).toEqual([first, second]);
      expect(core).not.toContain('sister lives in Pune');
      expect(core).not.toContain('spare key');
      expect(core).not.toContain('knee aches');
      expect(core).toContain('people 1');
      expect(core).toContain('unsorted 1');
      expect(core).toContain('body 1');
      expect(core).not.toContain('<owner_recent>');
    });
  });

  it('with no review yet, every fact is new: the newest that fit, shown oldest first, so a fresh remember is always there', async () => {
    await inOwner((store) => {
      const ids = Array.from({ length: 80 }, (_, index) => said(store, `The owner's note number ${index} about a thing they keep at home, mentioned in passing`, AFTER));
      const core = coreMemory(store, CORE_ROOM, reviewedThrough(undefined));
      const shown = tags(blockOf(core, 'owner_new'));
      expect(shown.at(-1)).toBe(ids.at(-1));
      expect(shown).not.toContain(ids[0]);
      expect(shown).toEqual([...shown].sort((a, b) => a - b));
      expect(core).toMatch(/unsorted \d+/);
    });
  });

  it('a claim told at the moment of the review is reviewed; one told after it is new', async () => {
    await inOwner((store) => {
      const at = said(store, 'The owner swims on Saturdays', REVIEWED);
      const after = said(store, 'The owner swims on Sundays now', '2026-10-30T22:00:00.001Z');
      expect(tags(blockOf(coreMemory(store, CORE_ROOM, MARK), 'owner_new'))).toEqual([after]);
      expect(at).toBeLessThan(after);
    });
  });

  it('never runs past its room, whatever the room, and is the same text for the same store', async () => {
    await inOwner((store) => {
      for (let index = 0; index < 40; index += 1) said(store, `The owner keeps item ${index} somewhere they can find it, and mentions it often`, index % 2 ? BEFORE : AFTER, { area: index % 3 ? 'home' : 'work' });
      store.pin(1, 'profile', 1); store.pin(2, 'facts', 1); store.pin(3, 'facts', 2);
      for (const room of [0, 40, 200, 700, 2_000, CORE_ROOM, 100_000]) {
        const core = coreMemory(store, room, MARK);
        expect(core.length, `room ${room}`).toBeLessThanOrEqual(room);
        expect(coreMemory(store, room, MARK)).toBe(core);
      }
      expect(coreMemory(store, 100_000, MARK).length).toBeLessThanOrEqual(CORE_ROOM);
    });
  });
});

describe('recall with stubs', () => {
  const dentistNotes = (store: ClaimStore) => Array.from({ length: 20 }, (_, index) => said(store, `Dentist note ${index}: the clinic on Park Road keeps a waiting list, and this note is long enough to be cut`, BEFORE));

  it('gives full lines for the top matches, then stubs with the id, kind and the first sixty characters, within its room', async () => {
    await inOwner(async (store) => {
      dentistNotes(store);
      const recalled = await recallForTurn({ claims: store, question: 'what did the dentist say', room: RECALLED_ROOM, holds: () => false, stubs: true });
      expect(tags(recalled.text)).toHaveLength(12);
      expect(stubs(recalled.text)).toHaveLength(8);
      for (const line of recalled.text.split('\n').filter((line) => line.includes(' stub · '))) expect(line).toMatch(/^- \[c\d+ stub · fact\] .{1,60}…$/u);
      expect(recalled.text).toContain('read_memory');
      expect(recalled.text.length).toBeLessThanOrEqual(RECALLED_ROOM);
      const tight = await recallForTurn({ claims: store, question: 'what did the dentist say', room: 900, holds: () => false, stubs: true });
      expect(tight.text.length).toBeLessThanOrEqual(900);
      expect(stubs(tight.text).length).toBeGreaterThan(0);
    });
  });

  it('gives an outside-content job no health note, as a line or a stub', async () => {
    await inOwner(async (store) => {
      for (let index = 0; index < 16; index += 1) said(store, `Pulse note ${index}: heart feels fine after cardio`, BEFORE, { kind: 'health' });
      said(store, 'Cardio class is on Wednesdays at the club', BEFORE);
      const recalled = await recallForTurn({ claims: outsideView(store), question: 'cardio heart pulse', room: RECALLED_ROOM, holds: () => false, stubs: true });
      expect(recalled.text).toContain('Cardio class is on Wednesdays');
      expect(recalled.text).not.toMatch(/Pulse note/);
    });
  });
});

describe('selectMemory', () => {
  it('returns the core and recall within their rooms, the ids shown in full, the legs that failed, and the revision', async () => {
    await inOwner(async (store) => {
      const dentist = said(store, 'The owner\'s dentist, Dr Rao, sees them on Tuesdays', BEFORE);
      const fresh = said(store, 'The owner moved the grocery run to Thursdays', AFTER);
      const selected = await selectMemory({ view: store, text: 'which day is my dentist', turn: 'owner', room: { core: CORE_ROOM, recalled: RECALLED_ROOM }, deadlineMs: 250, reviewed: MARK, holds: () => false });
      expect(selected.core).toBe(coreMemory(store, CORE_ROOM, MARK));
      expect(selected.recalled).toContain('Dr Rao');
      expect(selected.shown.claims).toEqual([fresh, dentist]);
      expect(selected.failed).toEqual([]);
      expect(selected.revision).toBe(store.revision());
      expect(selected.revision).toBeGreaterThan(0);
    });
  });

  it('a leg past its deadline leaves recall empty and names the leg; the turn still gets its core', async () => {
    await inOwner(async (store) => {
      said(store, 'The owner\'s dentist, Dr Rao, sees them on Tuesdays', BEFORE);
      const stuck: RecallEpisodes = { search: () => new Promise(() => undefined), get: async () => null };
      const selected = await selectMemory({ view: store, text: 'which day is my dentist', turn: 'owner', room: { core: CORE_ROOM, recalled: RECALLED_ROOM }, deadlineMs: 20, reviewed: reviewedThrough(undefined), holds: () => false, episodes: stuck });
      expect(selected.recalled).toBe('');
      expect(selected.failed).toEqual(['episodes']);
      expect(selected.core).toContain('Dr Rao');
    });
  });

  it('joins past messages only on the owner\'s own turn', async () => {
    await inOwner(async (store) => {
      said(store, 'The owner\'s dentist, Dr Rao, sees them on Tuesdays', BEFORE);
      let searched = 0;
      const episodes: RecallEpisodes = { search: async () => { searched += 1; return []; }, get: async () => null };
      for (const turn of ['machine', 'outside'] as const) await selectMemory({ view: turn === 'outside' ? outsideView(store) : store, text: 'which day is my dentist', turn, room: { core: CORE_ROOM, recalled: RECALLED_ROOM }, deadlineMs: 250, reviewed: reviewedThrough(undefined), holds: () => false, episodes });
      expect(searched).toBe(0);
      await selectMemory({ view: store, text: 'which day is my dentist', turn: 'owner', room: { core: CORE_ROOM, recalled: RECALLED_ROOM }, deadlineMs: 250, reviewed: reviewedThrough(undefined), holds: () => false, episodes });
      expect(searched).toBe(1);
    });
  });
});

describe('the owner turn, with MEMORY_SELECTION on and off', () => {
  const turnContext = async (store: ClaimStore, selection: boolean, text: string, sql?: SqlStorage) => {
    const requests: LLMGatewayRequest[] = [];
    const gateway: LLMGatewayAdapter = { complete: async (request) => {
      requests.push(request);
      return { ok: true, data: { model: request.request.model, text: 'Done.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    } };
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[2] = store; args[10] = gateway;
    if (sql) args[5] = memoryHandlers({ sql, store, conversationRef: 'telegram-1', hideHistory: async () => undefined }) as never;
    if (selection) args[21] = { memorySelection: { reviewed: () => MARK } };
    await createOwnerResponder(...args).prompt(`turn-${sequence++}`, 'owner', text, async (_hop, work) => work(), 'telegram', sql ? ['read_memory'] : []);
    return requests[0]!.request.messages.at(-1)?.content ?? '';
  };

  it('shows the pins and the new, not the reviewed, and offers further matches as stubs', async () => {
    await inOwnerSql(async (store, sql) => {
      store.pin(said(store, 'The owner goes by Sam', BEFORE), 'profile', 1);
      said(store, 'The owner\'s sister lives in Pune', BEFORE, { area: 'people' });
      said(store, 'The owner moved the grocery run to Thursdays', AFTER);
      for (let index = 0; index < 16; index += 1) said(store, `Dentist note ${index}: the clinic on Park Road keeps a waiting list, and this note is long enough to be cut`, BEFORE);
      const on = await turnContext(store, true, 'what did the dentist say', sql);
      expect(on).toContain('<owner_new>');
      expect(on).toContain('grocery run to Thursdays');
      // Reviewed and unpinned, it is not in the core; recall may still offer it, but only as a stub.
      const sister = on.split(/\\n|\n/).filter((line) => line.includes('sister lives in Pune'));
      expect(sister.length).toBeGreaterThan(0);
      expect(sister.every((line) => line.includes(' stub · '))).toBe(true);
      expect(on).not.toContain('<owner_recent>');
      expect(on).toMatch(/c\d+ stub · fact/);
      const off = await turnContext(store, false, 'what did the dentist say');
      expect(off).toContain('<owner_recent>');
      expect(off).toContain('sister lives in Pune');
      expect(off).not.toContain('<owner_new>');
      expect(off).not.toMatch(/ stub · /);
      // A call that cannot read memory by id gets no stub to open, and no line telling it to.
      const toolless = await turnContext(store, true, 'what did the dentist say');
      expect(toolless).toContain('<owner_new>');
      expect(toolless).not.toMatch(/ stub · |c12 stub/);
    });
  });
});
