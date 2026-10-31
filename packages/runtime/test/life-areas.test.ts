import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LIFE_AREAS } from '@waldo/contracts';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { MEMORY_CONTROL_PATH } from '../src/channels/dashboard-memory-actions';
import { readMemoryGraph } from '../src/channels/memory-graph';
import { applyClaimOps, CLAIM_OPS_SCHEMA, claimStore, memoryPrompt, type ClaimStore } from '../src/memory/claims';
import { outsideView } from '../src/memory/outside-view';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';

// Every claim is filed under one part of the owner's life. The model files it; the owner can change it, and the owner's
// choice stands against the model's later passes. An area can only keep more out of a model call built from outside content.
const AT = '2026-10-30T04:00:00Z';
let sequence = 0;
const withStore = <T>(fn: (store: ClaimStore, sql: SqlStorage) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`life-areas-${sequence++}`)), (_instance, state) =>
    fn(claimStore(state.storage.sql, (work) => state.storage.transactionSync(work)), state.storage.sql));
const said = (store: ClaimStore, text: string, kind = 'observation', area?: (typeof LIFE_AREAS)[number]) => {
  store.add({ kind, text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: `owner, tg-${sequence++}`, ...(area ? { area } : {}) }, AT);
  return store.allClaims().find((claim) => claim.text === text)!;
};
const ops = (over: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, pin: [], unpin: [], areas: [], ...over });

describe('filing a claim', () => {
  it('keeps the area the writer gave, and anything unfiled or unsorted reads unsorted', async () => {
    await withStore((store) => {
      expect(said(store, 'Rent is due on the first', 'fact', 'money')).toMatchObject({ area: 'money', area_by: 'model' });
      expect(said(store, 'Likes window seats', 'preference')).toMatchObject({ area: null });
      expect(said(store, 'Visits the library', 'routine', 'unsorted')).toMatchObject({ area: null, area_by: null });
    });
  });

  it('the model files new claims and refiles old ones, but never over the owner\'s choice or onto a claim that is gone', async () => {
    await withStore((store) => {
      const rent = said(store, 'Rent is due on the first', 'fact'), tea = said(store, 'Prefers tea', 'preference'), gone = said(store, 'Old gym', 'routine');
      expect(store.setArea(tea.id, 'home', 'owner')).toBe(true);
      store.setStatus(gone.id, 'dismissed');
      applyClaimOps(store, ops({
        add: [{ kind: 'routine', text: 'Runs on Sundays', source: 'stated', evidence: 'Runs on Sundays', touches_forgotten: false, aliases_touch_forgotten: false, aliases: [], area: 'body' }],
        areas: [{ id: rent.id, area: 'money' }, { id: tea.id, area: 'body' }, { id: gone.id, area: 'body' }, { id: 9_999, area: 'work' }],
      }), AT);
      const area = (text: string) => store.allClaims().find((claim) => claim.text === text)!;
      expect(area('Runs on Sundays')).toMatchObject({ area: 'body', area_by: 'model' });
      expect(area('Rent is due on the first')).toMatchObject({ area: 'money', area_by: 'model' });
      expect(area('Prefers tea')).toMatchObject({ area: 'home', area_by: 'owner' });
      expect(area('Old gym')).toMatchObject({ area: null });
      expect(store.setArea(9_999, 'work', 'owner')).toBe(false);
    });
  });

  it('refuses an area outside the set from any writer', async () => {
    await withStore((store) => {
      const rent = said(store, 'Rent is due on the first', 'fact');
      expect(store.setArea(rent.id, 'finance' as never, 'owner')).toBe(false);
      applyClaimOps(store, ops({ add: [{ kind: 'fact', text: 'Pays by card', source: 'stated', evidence: 'Pays by card', touches_forgotten: false, aliases_touch_forgotten: false, aliases: [], area: 'personal' }], areas: [{ id: rent.id, area: 'health' }] }), AT);
      expect(store.allClaims().map((claim) => claim.area)).toEqual([null, null]);
    });
  });

  it('a correction keeps the area and who chose it', async () => {
    await withStore((store) => {
      const rent = said(store, 'Rent is due on the first', 'fact');
      store.setArea(rent.id, 'money', 'owner');
      expect(store.correct(rent.id, { kind: 'fact', text: 'Rent is due on the fifth', source: 'stated', evidence: 'x', origin: 'owner', source_ref: 'owner, tg-fix' }, AT)).toBe(true);
      expect(store.claims().find((claim) => claim.text === 'Rent is due on the fifth')).toMatchObject({ area: 'money', area_by: 'owner' });
    });
  });

  it('the owner\'s choice stands against a model correction, and their "unsorted" against a model refile', async () => {
    await withStore((store) => {
      const rent = said(store, 'Rent is due on the first', 'fact', 'money');
      expect(store.setArea(rent.id, 'work', 'owner')).toBe(true);
      expect(store.correct(rent.id, { kind: 'fact', text: 'Rent is due on the fifth', source: 'stated', evidence: 'x', origin: 'owner', source_ref: 'owner, tg-fix', area: 'home' }, AT)).toBe(true);
      expect(store.claims().find((claim) => claim.text === 'Rent is due on the fifth')).toMatchObject({ area: 'work', area_by: 'owner' });
      const tea = said(store, 'Prefers tea', 'preference', 'home');
      expect(store.setArea(tea.id, 'unsorted', 'owner')).toBe(true);
      expect(store.setArea(tea.id, 'people', 'model')).toBe(false);
      expect(store.claims().find((claim) => claim.id === tea.id)).toMatchObject({ area: null, area_by: 'owner' });
    });
  });

  it('the model is asked for an area on every new claim and may refile by id, and sees each claim\'s area', async () => {
    await withStore((store) => {
      said(store, 'Rent is due on the first', 'fact', 'money');
      const add = (CLAIM_OPS_SCHEMA.properties.add.items as { required: string[]; properties: Record<string, { enum?: string[] }> });
      expect(add.required).toContain('area');
      expect(add.properties.area!.enum).toEqual([...LIFE_AREAS]);
      expect(CLAIM_OPS_SCHEMA.required).toContain('areas');
      expect(memoryPrompt(store)).toContain('area="money"');
    });
  });
});

describe('only the owner moves a claim out of body or mind', () => {
  it('a model refile or a model correction leaves it where it was, still out of outside-content calls; the owner can move it', async () => {
    await withStore((store) => {
      const mood = said(store, 'Stressed before board meetings', 'observation', 'mind');
      applyClaimOps(store, ops({ areas: [{ id: mood.id, area: 'work' }] }), AT);
      expect(store.allClaims().find((claim) => claim.id === mood.id)).toMatchObject({ area: 'mind', area_by: 'model' });
      expect(store.setArea(mood.id, 'body', 'model')).toBe(false);
      expect(store.correct(mood.id, { kind: 'observation', text: 'Tense before board meetings', source: 'stated', evidence: 'x', origin: 'owner', source_ref: 'owner, tg-fix', area: 'work' }, AT)).toBe(true);
      const corrected = store.claims().find((claim) => claim.text === 'Tense before board meetings')!;
      expect(corrected).toMatchObject({ area: 'mind' });
      expect(outsideView(store).claims().map((claim) => claim.text)).toEqual([]);
      expect(store.setArea(corrected.id, 'work', 'owner')).toBe(true);
      expect(outsideView(store).claims().map((claim) => claim.text)).toEqual(['Tense before board meetings']);
    });
  });
});

describe('what a model call built from outside content may read', () => {
  it('leaves out every body and mind claim and every health claim whatever its area; other areas stay', async () => {
    await withStore((store) => {
      said(store, 'Stressed before board meetings', 'observation', 'mind');
      said(store, 'Sleeps badly before travel', 'pattern', 'body');
      said(store, 'Knee hurts on long runs', 'health', 'work');
      said(store, 'Board meets on Thursdays', 'event', 'work');
      const outside = outsideView(store);
      expect(outside.claims().map((claim) => claim.text)).toEqual(['Board meets on Thursdays']);
      expect(outside.recall('board meetings stressed sleeps travel knee runs').map((claim) => claim.text)).toEqual(['Board meets on Thursdays']);
    });
  });
});

describe('read_memory by area', () => {
  it('reads one area, unsorted reads what is not filed, and each claim names its area', async () => {
    await withStore(async (store, sql) => {
      said(store, 'Rent is due on the first', 'fact', 'money');
      said(store, 'Prefers tea', 'preference');
      const tool = memoryHandlers({ sql, store, conversationRef: 'telegram-1', hideHistory: async () => undefined }).find((candidate) => candidate.name === 'read_memory')!;
      const machine = { authenticatedUserId: 'owner:1', trigger: 'user_message' } as unknown as MemoryToolContext;
      const read = async (args: object) => (await tool.handle(tool.schema.parse(args), machine) as { data: { claims: { text: string; area?: string }[] } }).data.claims;
      expect((await read({ area: 'money' })).map((claim) => [claim.text, claim.area])).toEqual([['Rent is due on the first', 'money']]);
      expect((await read({ area: 'unsorted' })).map((claim) => [claim.text, claim.area])).toEqual([['Prefers tea', 'unsorted']]);
      expect(await read({ area: 'people' })).toEqual([]);
    });
  });
});

describe('the owner refiles a claim from the console', () => {
  const root = 'https://telegram-owner';
  type Read = { csrf: string; revision: string; data: { actions: string[]; review?: { area?: string } } };
  const owner = async (name: string) => {
    const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
    const token = await runInDurableObject(stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
      return consoleAccess(state.storage).grant();
    });
    const headers = (extra: Record<string, string> = {}, cookie = token) => ({ cookie: `waldo_console=${cookie}`, accept: 'application/json', ...extra });
    expect((await stub.fetch(`${root}${CONTROLS_PATH}?view=day`, { headers: headers() })).status).toBe(200);
    const target = await runInDurableObject(stub, (_instance, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      return `${state.id}:claim:${said(store, 'Rent is due on the first', 'fact', 'home').id}`;
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
      sessions[token] = { ...sessions[token]!, verified_at: Date.now() - 60_000 };
      await state.storage.put('console:sessions', sessions);
    });
    const read = (cookie = token) => stub.fetch(`${root}${MEMORY_CONTROL_PATH}?${new URLSearchParams({ id: target })}`, { headers: headers({}, cookie) });
    const act = async (value: string, cookie = token) => {
      const current = await (await read()).json() as Read;
      return stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }, cookie),
        body: new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'memory', action: 'spot.area', id: target, request_id: `spot-area-${crypto.randomUUID()}`, value }) });
    };
    const stored = () => runInDurableObject(stub, (_instance, state) => claimStore(state.storage.sql).claims()[0]!);
    const graph = () => runInDurableObject(stub, (_instance, state) => readMemoryGraph(state.storage.sql, 'memory'));
    return { stub, token, target, read, act, stored, graph };
  };

  it('offers a refile, shows the current area, and the owner\'s choice is stored as theirs', async () => {
    const o = await owner('life-areas-console');
    const shown = await (await o.read()).json() as Read;
    expect(shown.data.actions).toContain('spot.area');
    expect(shown.data.review?.area).toBe('home');
    expect((await o.act('money')).status).toBe(200);
    expect(await o.stored()).toMatchObject({ area: 'money', area_by: 'owner' });
  });

  it('refuses an area outside the set, and another owner\'s session', async () => {
    const o = await owner('life-areas-console-bad'), other = await owner('life-areas-console-other');
    expect((await o.act('finance')).status).toBe(409);
    expect((await o.read(other.token)).status).toBe(401);
    expect(await o.stored()).toMatchObject({ area: 'home', area_by: 'model' });
  });

  it('the area stays off the memory graph the app reads until the app contract carries it', async () => {
    const o = await owner('life-areas-app');
    expect(JSON.stringify(await o.graph())).not.toContain('"area"');
  });
});
