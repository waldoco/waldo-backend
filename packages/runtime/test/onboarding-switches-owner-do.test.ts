// The agreements and look-up switches through OwnerDO.fetch: only "1" turns either on; turning one off after a yes keeps the
// findings listed and the yes on record but not active; a withdrawal still erases with either switch off; and a finding
// that expired before the withdrawal is not among what it erases.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { episodeIndex } from '../src/channels/episodes';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { findingStore, observedPages, ownerLookupHandlers } from '../src/onboarding/findings';

const OWNER_ID = '5b3c4d5e-6f70-4a8b-9cad-1e2f3a4b5c6e';
const DAY = 86_400_000;
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const FOUND = { category: 'work', text: 'Product manager at Northwind', source_url: 'https://ashamenon.example/about', evidence_quote: 'Asha Menon is a product manager at Northwind' } as const;
const conversation = (id: string, text: string) => ({ id, ownerId: 'prn_owner', chatId: 'main', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' }, role: 'assistant' });
let n = 0;
const owner = (vars: Record<string, string | undefined>, work: (o: { state: DurableObjectState; call(path: string, body?: unknown): Promise<Response> }) => Promise<void>) => {
  const name = `onboarding-switches-${n++}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    const object = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined, ...vars });
    const call = (path: string, body?: unknown) => object.fetch(new Request(`https://telegram-owner${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    await work({ state, call });
  });
};
// A yes given while both switches were on, one finding with its quote repeated in a chat reply and an episode.
const seed = (state: DurableObjectState, at: number) => {
  const sql = state.storage.sql, claims = claimStore(sql, w => state.storage.transactionSync(w)), consent = consentLedger(sql, { lookupOffered: true, agreementsOffered: true });
  consent.grant('terms', 1, at); consent.grant('privacy_notice', 1, at); consent.grant('owner_lookup', 1, at);
  findingStore(sql, claims, consent, () => at).record(FOUND, 'About', at);
  state.storage.kv.put('conv:0000000001', conversation('reply-1', `I found this: ${FOUND.evidence_quote}.`));
  episodeIndex(sql).add('e1', 'waldo', `Noted that ${FOUND.text}.`, 4);
  return { claims, consent };
};
const copies = (state: DurableObjectState) => JSON.stringify([state.storage.kv.get('conv:0000000001'), state.storage.sql.exec('SELECT text FROM episodes').toArray()]);

describe('the switches read only "1" as on', () => {
  for (const [value, on] of [['1', true], ['0', false], ['true', false], ['', false], [undefined, false], [' 1', false], ['yes', false]] as const) {
    it(`APP_AGREEMENTS ${JSON.stringify(value)} ${on ? 'offers' : 'holds back'} the agreements`, () => owner({ APP_AGREEMENTS: value, OWNER_LOOKUP: '1' }, async ({ call }) => {
      const body = await (await call('/app/v1/consents')).json() as { agreements_offered: boolean; owner_lookup_offered: boolean };
      expect(body).toMatchObject({ agreements_offered: on, owner_lookup_offered: on });
      expect((await call('/app/v1/consents', { request_id: 'grant-terms-1', purpose: 'terms', version: 1, age_attested_18_plus: true })).status).toBe(on ? 200 : 409);
    }));
    it(`OWNER_LOOKUP ${JSON.stringify(value)} ${on ? 'offers' : 'does not offer'} the look-up`, () => owner({ APP_AGREEMENTS: '1', OWNER_LOOKUP: value }, async ({ call }) => {
      expect(await (await call('/app/v1/consents')).json()).toMatchObject({ agreements_offered: true, owner_lookup_offered: on });
    }));
  }
});

describe('a switch turned off after a yes', () => {
  for (const vars of [{ APP_AGREEMENTS: '0', OWNER_LOOKUP: '1' }, { APP_AGREEMENTS: '1', OWNER_LOOKUP: '0' }]) {
    const off = vars.APP_AGREEMENTS === '0' ? 'APP_AGREEMENTS' : 'OWNER_LOOKUP';
    it(`with ${off} off, keeps the yes on record but not active, and the finding listed`, () => owner(vars, async ({ state, call }) => {
      seed(state, Date.now());
      const consents = await (await call('/app/v1/consents')).json() as { consents: { purpose: string; status: string; active: boolean }[] };
      const lookup = consents.consents.find(row => row.purpose === 'owner_lookup')!;
      expect(lookup).toMatchObject({ status: 'granted', active: false });
      expect(await (await call('/app/v1/findings')).json()).toMatchObject({ lookup: 'not_granted', total: 1 });
      expect(copies(state)).toContain(FOUND.evidence_quote);
    }));
    it(`with ${off} off, a withdrawal still erases the finding, hides its copies and keeps the record`, () => owner(vars, async ({ state, call }) => {
      seed(state, Date.now());
      const response = await call('/app/v1/consents/withdraw', { request_id: `withdraw-${off}`, purpose: 'owner_lookup' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ consent: { status: 'withdrawn', active: false }, findings_erased: 1 });
      expect(copies(state)).not.toContain(FOUND.evidence_quote);
      expect(copies(state)).toContain(FORGOTTEN);
      expect(state.storage.sql.exec<{ action: string }>("SELECT action FROM consent_ledger WHERE purpose = 'owner_lookup' ORDER BY id").toArray().map(r => r.action)).toEqual(['granted', 'withdrawn']);
    }));
  }
  it('with both on, the same yes reads active', () => owner({ APP_AGREEMENTS: '1', OWNER_LOOKUP: '1' }, async ({ state, call }) => {
    seed(state, Date.now());
    const consents = await (await call('/app/v1/consents')).json() as { consents: { purpose: string; active: boolean }[] };
    expect(consents.consents.map(row => [row.purpose, row.active])).toEqual([['terms', true], ['privacy_notice', true], ['owner_lookup', true]]);
    expect(await (await call('/app/v1/findings')).json()).toMatchObject({ lookup: 'granted', total: 1 });
  }));
});

describe('a finding that expired before the withdrawal', () => {
  it('is not among what the withdrawal erases: its quote stays in the chat and the episode, and it can be recorded again', () => owner({ APP_AGREEMENTS: '1', OWNER_LOOKUP: '1' }, async ({ state, call }) => {
    const { claims, consent } = seed(state, Date.now() - 31 * DAY);
    expect(await (await call('/app/v1/findings')).json()).toMatchObject({ lookup: 'granted', total: 0 });
    const response = await call('/app/v1/consents/withdraw', { request_id: 'withdraw-expired-1', purpose: 'owner_lookup' });
    expect(await response.json()).toMatchObject({ consent: { status: 'withdrawn' }, findings_erased: 0 });
    expect(copies(state)).toContain(FOUND.evidence_quote);
    expect((await call('/app/v1/consents', { request_id: 'grant-again-1', purpose: 'owner_lookup', version: 1, age_attested_18_plus: true })).status).toBe(200);
    expect(findingStore(state.storage.sql, claims, consent, Date.now).record(FOUND, 'About', Date.now())).toMatchObject({ duplicate: false });
  }));
});

describe('findings reach the model as outside content whatever the switches say', () => {
  it('list_owner_findings returns a finding listed while the agreements are held back, tainted external', () => runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`onboarding-switches-taint-${n++}`)), async (_i, state) => {
    const sql = state.storage.sql, claims = claimStore(sql, w => state.storage.transactionSync(w));
    const on = consentLedger(sql, { lookupOffered: true, agreementsOffered: true });
    on.grant('terms', 1, 1); on.grant('privacy_notice', 1, 1); on.grant('owner_lookup', 1, 1);
    findingStore(sql, claims, on, Date.now).record(FOUND, 'About', Date.now());
    const held = consentLedger(sql, { lookupOffered: true, agreementsOffered: false });
    const [, list] = ownerLookupHandlers({ store: findingStore(sql, claims, held, Date.now), pages: observedPages() });
    expect(await list!.handle({ limit: 10 }, {} as never)).toMatchObject({ ok: true, source_taint: 'external', data: { lookup: 'not_offered', total: 1 } });
  }));
});
