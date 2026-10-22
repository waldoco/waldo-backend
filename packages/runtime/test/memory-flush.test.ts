import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { episodeIndex, OWNER_SAID } from '../src/channels/episodes';
import { HEALTH_MEMORY_KEY, HEALTH_SAVED_KEY, healthMemoryOn, memoryFlushHooks, noteHealthSaved, setHealthMemory, healthNotice } from '../src/channels/health-memory';
import type { SpanMemory } from '../src/conversation/compaction';
import { claimStore } from '../src/memory/claims';

const AT = '2026-10-21T08:00:00Z';
let sequence = 0;
const inOwner = <T,>(work: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`memory-flush-${sequence++}`)), (_instance, state) => work(state));
const kvOf = (state: DurableObjectState) => state.storage.kv;

describe('the health notes setting', () => {
  it('is on until the owner turns it off, and takes only on or off', () => inOwner((state) => {
    const kv = kvOf(state);
    expect(healthMemoryOn(kv)).toBe(true);
    expect(setHealthMemory(kv, 'off')).toBe(true);
    expect(healthMemoryOn(kv)).toBe(false);
    for (const value of ['', 'OFF', 'false', 'no']) expect(setHealthMemory(kv, value)).toBe(false);
    expect(kv.get(HEALTH_MEMORY_KEY)).toBe(false);
    expect(setHealthMemory(kv, 'on')).toBe(true);
    expect(healthMemoryOn(kv)).toBe(true);
  }));
});

describe('the notice of health notes saved on Waldo\'s own', () => {
  it('names each saved note still in memory once, in its current words, then clears when taken', () => inOwner((state) => {
    const kv = kvOf(state);
    const claims = [{ id: 3, text: 'Sleeps badly after late coffee' }, { id: 5, text: 'Feels flat on days without a walk' }];
    noteHealthSaved(kv, [3, 4]);
    noteHealthSaved(kv, [5, 3]);
    const notice = healthNotice(kv, () => claims);
    expect(notice?.line).toBe('Saved to memory from our earlier chat: "Sleeps badly after late coffee" (c3); "Feels flat on days without a walk" (c5). Tell me to correct or forget any of it, or turn health notes off in your settings.');
    notice!.taken();
    expect(kv.get(HEALTH_SAVED_KEY)).toBeUndefined();
    expect(healthNotice(kv, () => claims)).toBeNull();
  }));

  // A reply that never saves (its run closed) must not lose the notice, and a note saved while the reply was written is
  // still named next time.
  it('stays until the reply carrying it is saved, and keeps notes saved after it was read', () => inOwner((state) => {
    const kv = kvOf(state);
    const claims = [{ id: 3, text: 'Sleeps badly after late coffee' }, { id: 6, text: 'Sleeps better after a walk' }];
    noteHealthSaved(kv, [3]);
    expect(healthNotice(kv, () => claims)?.line).toContain('(c3)');
    const notice = healthNotice(kv, () => claims);
    expect(notice?.line).toContain('(c3)');
    noteHealthSaved(kv, [6]);
    notice!.taken();
    expect(healthNotice(kv, () => claims)?.line).toBe('Saved to memory from our earlier chat: "Sleeps better after a walk" (c6). Tell me to correct or forget any of it, or turn health notes off in your settings.');
  }));

  it('says nothing when every waiting note was forgotten first, and names at most five', () => inOwner((state) => {
    const kv = kvOf(state);
    noteHealthSaved(kv, [9]);
    expect(healthNotice(kv, () => [])).toBeNull();
    expect(kv.get(HEALTH_SAVED_KEY)).toBeUndefined();
    const many = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, text: `Note ${index + 1}` }));
    noteHealthSaved(kv, many.map((claim) => claim.id));
    expect(healthNotice(kv, () => many)?.line).toMatch(/\(c5\); and 2 more\. /);
  }));

  // "and 2 more" names nothing, so taking the line clears only the five it named; the other two are named next time.
  it('clears only the notes the line named, and names the ones it only counted in the next reply', () => inOwner((state) => {
    const kv = kvOf(state);
    const many = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, text: `Note ${index + 1}` }));
    noteHealthSaved(kv, [...many.map((claim) => claim.id), 9]);
    healthNotice(kv, () => many)!.taken();
    expect(kv.get(HEALTH_SAVED_KEY)).toEqual([6, 7]);
    expect(healthNotice(kv, () => many)?.line).toBe('Saved to memory from our earlier chat: "Note 6" (c6); "Note 7" (c7). Tell me to correct or forget any of it, or turn health notes off in your settings.');
  }));
});

describe('the flush before older chat leaves Waldo\'s view', () => {
  const seed = (state: DurableObjectState) => {
    const episodes = episodeIndex(state.storage.sql);
    episodes.add('tg-1', OWNER_SAID, 'I sleep badly after late coffee', Date.UTC(2026, 9, 20, 8));
    episodes.add('tg-1', 'quoted', 'Forwarded: Sam sleeps badly too', Date.UTC(2026, 9, 20, 8));
    episodes.add('tg-1-reply', 'waldo', 'Noted, I will keep evenings calm.', Date.UTC(2026, 9, 20, 8, 1));
    episodes.add('tg-9', OWNER_SAID, 'This message is not in the span', Date.UTC(2026, 9, 20, 9));
    return episodes;
  };
  const span = { conversationRef: 'owner', covers: { from_id: 'tg-1', to_id: 'tg-1-reply', rows: 2 }, messages: [], entryIds: ['tg-1', 'tg-1-reply'] };

  it('hands memory the span\'s rows with the owner\'s own words apart, under the owner\'s setting, and names the health notes it kept', () => inOwner(async (state) => {
    const kv = kvOf(state);
    const memory = claimStore(state.storage.sql);
    const hooks = memoryFlushHooks({ kv, episodes: seed(state), claims: () => memory.claims(), timezone: () => 'UTC' });
    const calls: Parameters<SpanMemory['save']>[] = [];
    const keep: SpanMemory = { save: async (...args) => {
      calls.push(args);
      memory.add({ kind: 'health', text: 'Sleeps badly after late coffee', source: 'stated', evidence: 'I sleep badly after late coffee', origin: 'owner', source_ref: 'owner, tg-1' }, AT, 1);
      memory.add({ kind: 'preference', text: 'Wants calm evenings', source: 'inferred', evidence: 'calm evenings', origin: 'agent' }, AT, 2);
      return [{ id: 1, kind: 'health' }, { id: 2, kind: 'preference' }];
    } };
    await hooks.compactionFlush(span, keep);
    expect(calls).toHaveLength(1);
    const [transcriptText, sides, policy] = calls[0]!;
    expect(transcriptText).toContain('owner: I sleep badly after late coffee');
    expect(transcriptText).toContain('waldo: Noted, I will keep evenings calm.');
    expect(transcriptText).not.toContain('not in the span');
    expect(sides).toMatchObject({ owner: 'I sleep badly after late coffee', shared: 'Forwarded: Sam sleeps badly too', ownerMessages: [{ ref: 'tg-1', text: 'I sleep badly after late coffee' }] });
    expect(policy).toEqual({ health: true });
    const notice = hooks.memoryNotice();
    expect(notice?.line).toBe('Saved to memory from our earlier chat: "Sleeps badly after late coffee" (c1). Tell me to correct or forget any of it, or turn health notes off in your settings.');
    notice!.taken();
    expect(hooks.memoryNotice()).toBeNull();

    setHealthMemory(kv, 'off');
    await hooks.compactionFlush(span, { save: async (...args) => { calls.push(args); return []; } });
    expect(calls[1]![2]).toEqual({ health: false });
  }));

  it('asks nothing of memory when no row of the span was stored', () => inOwner(async (state) => {
    let asked = false;
    const hooks = memoryFlushHooks({ kv: kvOf(state), episodes: seed(state), claims: () => [], timezone: () => 'UTC' });
    await hooks.compactionFlush({ ...span, entryIds: ['never-stored'] }, { save: async () => { asked = true; return []; } });
    expect(asked).toBe(false);
  }));
});

describe('reading a span\'s episode rows', () => {
  it('returns every row of the named entries oldest first, past one batch of lookups, and leaves out the newest past the bound', () => inOwner((state) => {
    const episodes = episodeIndex(state.storage.sql);
    const ids = Array.from({ length: 60 }, (_, index) => `tg-${index}`);
    for (const [index, id] of ids.entries()) episodes.add(id, OWNER_SAID, `message ${index}`, Date.UTC(2026, 9, 20) + index);
    episodes.add('tg-other', OWNER_SAID, 'not named', Date.UTC(2026, 9, 21));
    expect(episodes.of([...ids].reverse(), 10_000).map((row) => row.text)).toEqual(ids.map((_, index) => `message ${index}`));
    expect(episodes.of(ids, 'message 0'.length * 3).map((row) => row.entry_id)).toEqual(['tg-0', 'tg-1', 'tg-2']);
  }));
});
