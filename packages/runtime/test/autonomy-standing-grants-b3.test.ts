import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appAutonomyChangeResultV1Schema, appAutonomyV1Schema, type AppAutonomyGrantTermsV1 } from '../../contracts/src/app/autonomy';
import type { RunOrigin } from '../../contracts/src/runtime/standing-grant';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { appTranscriptPage } from '../src/channels/app-api';
import { appAutonomyRequest, type AppAutonomyHost } from '../src/channels/app-autonomy';
import { appApprovalParts, approvalDesk } from '../src/channels/approvals';
import { autonomyHandlers } from '../src/channels/autonomy-tools';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { standingGrants } from '../src/channels/standing-grants';
import type { GoogleClient } from '../src/connectors/google';
import type { ConversationEntry } from '@waldo/contracts';

// Tuesday 3 Nov 2026, 09:00 in Kolkata.
const NOW = Date.UTC(2026, 10, 3, 3, 30);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ACCOUNT = 'sam@example.com';
const iso = (ms: number) => new Date(ms).toISOString() as never;
const focus = (startMs = NOW + 5 * HOUR) => ({ action: 'create' as const, title: 'Focus', start: iso(startMs), end: iso(startMs + HOUR), reason: 'plan the day', block: 'deep_work' as const });
const ask = { class: 'calendar.move_own_block' as const, window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30, max_per_day: 3, days: 30 };
const terms = (over: Partial<AppAutonomyGrantTermsV1> = {}): AppAutonomyGrantTermsV1 => ({
  scope: { class: 'calendar.move_own_block', account: ACCOUNT, window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
  limits: { max_per_day: 3, timezone: 'Asia/Kolkata' }, valid_from: NOW, expires_at: NOW + 30 * DAY, ...over,
});

// One owner's object: the grant store, the desk with its own-block path, the chat tools and the app routes over the same storage.
const world = (state: DurableObjectState, options: Readonly<{ on?: () => boolean; signedInAt?: string }> = {}) => {
  let now = NOW, n = 0, g = 0;
  const writes: unknown[][] = [], cards: string[] = [], logs: Record<string, unknown>[] = [];
  const client = {
    account: { connection_id: `local:${ACCOUNT}`, email: ACCOUNT },
    event: async (id: string) => ({ id, title: 'Focus', start: iso(NOW + 5 * HOUR), end: iso(NOW + 6 * HOUR), all_day: false, etag: 'v2', waldo_made: true }),
    createEvent: async (input: Record<string, unknown>) => { writes.push(['create', input]); return { id: String(input.id), title: 'Focus', start: '', end: '', all_day: false, etag: 'v2' }; },
    cancelEvent: async (...args: unknown[]) => { writes.push(['cancel', ...args]); return { id: String(args[0]), title: 'Focus', start: '', end: '', all_day: false, etag: 'v4', status: 'cancelled' }; },
  } as unknown as GoogleClient;
  const grants = standingGrants(state.storage, { now: () => now, newId: () => `g${++g}`, enabled: options.on ?? (() => true), ownerRef: () => 'owner-1' });
  const effects = ownerEffectLedger(state.storage, () => now);
  const desk = approvalDesk(state.storage.sql, {
    call: async (method, body) => { if (method === 'sendMessage') cards.push(String((body as { text?: string }).text)); return { message_id: cards.length }; },
    owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: entry => logs.push(entry as Record<string, unknown>),
    effects, ownerRef: () => 'owner-1', grants, commit: work => state.storage.transactionSync(work),
  });
  const tools = autonomyHandlers(grants, desk, { now: () => now, timezone: () => 'Asia/Kolkata', surface: 'telegram', account: async requested => requested ?? ACCOUNT });
  const tool = (name: string) => tools.find(handler => handler.name === name)!;
  const turn = (runOrigin: RunOrigin | undefined, over: Record<string, unknown> = {}) => ({ authenticatedUserId: 'owner-1', turnId: 't1', toolCallId: 'c1', ...(runOrigin ? { runOrigin } : {}), ...over }) as never;
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const propose = (p = focus()) => desk.propose(p, 'turn-1', `tool:${n + 1}`, { origin: 'owner' });
  const host: AppAutonomyHost = {
    csrf: 'session-1', expires: NOW + DAY, storage: state.storage, signedInAt: options.signedInAt ?? new Date(Date.now() - 3 * HOUR).toISOString(),
    assertCurrent: async () => undefined, sessions: async () => [{ csrf: 'session-1', expires: Date.now() + DAY }],
    grants, usesToday: async grant => effects.count(grants.usage(grant, now)), now: () => now,
  };
  const route = async (method: 'GET' | 'POST', path: string, body?: unknown, contract = 'autonomy=1') => {
    const response = await appAutonomyRequest(new Request(`https://app.example${path}`, { method, headers: { 'x-waldo-app-contract': contract, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), host);
    return { status: response.status, body: await response.json() as any };
  };
  const settings = async () => appAutonomyV1Schema.parse((await route('GET', '/app/v1/autonomy')).body);
  return { desk, grants, effects, writes, cards, logs, tool, turn, status, propose, route, settings, clock: { set: (ms: number) => { now = ms; } } };
};
const inDo = (name: string, run: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => run(state));
const proposedId = (result: unknown) => (result as { data: { proposal_id: string } }).data.proposal_id;

describe('B3: the owner creates a standing grant in chat, and only their yes writes it', () => {
  it('golden path: Waldo asks on a card, the owner approves, and a later own block runs with no card and is undoable', () => inDo('b3-golden-chat', async state => {
    const w = world(state);
    const asked = await w.tool('propose_standing_grant').handle(ask as never, w.turn('owner'));
    expect(asked).toMatchObject({ ok: true, data: { status: expect.stringMatching(/Allow/) } });
    const card = proposedId(asked);
    // Asking wrote no grant: the next block is still a card.
    expect(w.grants.list()).toEqual([]);
    expect(w.cards).toHaveLength(1);
    expect(w.cards[0]).toMatch(/^Let Waldo place, move and remove its own focus blocks on sam@example.com's primary calendar/);
    expect(w.cards[0]).toContain('weekdays, 08:00 to 19:00 (Asia/Kolkata), at least 30 minutes ahead');
    expect(w.cards[0]).toContain('At most 3 a day, until 3 Dec 2026');

    expect((await w.desk.decide(card, 'a', 't', { surface: 'telegram', messageRef: '42:1' })).toast).toBe('Allowed');
    expect(w.status(card)).toBe('done');
    expect(w.grants.active()).toHaveLength(1);
    expect(w.grants.active()[0]).toMatchObject({ revision: 1, created_via: 'telegram', terms: { scope: { account: ACCOUNT }, limits: { max_per_day: 3 }, valid_from: NOW, expires_at: NOW + 30 * DAY } });

    w.clock.set(NOW + MIN);
    const block = await w.propose(focus(NOW + 5 * HOUR));
    expect(w.cards).toHaveLength(1);
    expect(w.status(block)).toBe('done');
    expect(w.writes).toHaveLength(1);
    w.clock.set(NOW + 3 * HOUR);
    expect((await w.desk.decide(block, 'u', 't')).toast).toBe('Undone');
    expect(w.writes.at(-1)![0]).toBe('cancel');
  }));

  it('golden path in settings: grant with the reviewed revision, then the next own block runs with no card', () => inDo('b3-golden-settings', async state => {
    const w = world(state);
    const before = await w.settings();
    expect(before.classes.find(entry => entry.class === 'calendar.move_own_block')).toMatchObject({ availability: 'available', step_up: false, grants: [] });
    const granted = await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0001', expected_revision: before.revision, change: { op: 'grant', terms: terms() } });
    expect(granted.status).toBe(200);
    expect(appAutonomyChangeResultV1Schema.parse(granted.body)).toMatchObject({ receipt: { state: 'recorded' }, duplicate: false });
    expect(granted.body.revision).not.toBe(before.revision);
    expect(w.status(await w.propose())).toBe('done');
    expect(w.cards).toEqual([]);
    expect((await w.settings()).classes[0]!.grants[0]).toMatchObject({ created_via: 'app', uses_today: 1 });
  }));

  it('a second approval of the same card writes no second grant', () => inDo('b3-double', async state => {
    const w = world(state);
    const card = proposedId(await w.tool('propose_standing_grant').handle(ask as never, w.turn('owner')));
    await w.desk.decide(card, 'a', 't', { surface: 'telegram', messageRef: '42:1' });
    expect((await w.desk.decide(card, 'a', 't', { surface: 'telegram', messageRef: '42:1' })).toast).toBe('Already handled.');
    expect(w.grants.list()).toHaveLength(1);
  }));

  it('asking again supersedes the grant for that calendar: same id, next revision, and the day\'s count carries over', () => inDo('b3-supersede', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    expect(w.status(await w.propose(focus(NOW + 5 * HOUR)))).toBe('done');
    const card = proposedId(await w.tool('propose_standing_grant').handle({ ...ask, max_per_day: 1 } as never, w.turn('owner')));
    await w.desk.decide(card, 'a', 't', { surface: 'telegram', messageRef: '42:1' });
    expect(w.grants.list()).toEqual([expect.objectContaining({ grant_id: 'g1', revision: 2 })]);
    // One use today already, under the new cap of one: the next block is a card.
    expect(w.status(await w.propose(focus(NOW + 7 * HOUR)))).toBe('open');
  }));

  it('a card approved after the switch went off, or after its terms ended, makes no grant', () => inDo('b3-approve-recheck', async state => {
    const flags = { on: true };
    const w = world(state, { on: () => flags.on });
    const first = proposedId(await w.tool('propose_standing_grant').handle(ask as never, w.turn('owner')));
    // Terms that end before the card's own 12-hour expiry.
    const second = await w.desk.proposeStandingGrant(terms({ expires_at: NOW + HOUR }));
    flags.on = false;
    expect((await w.desk.decide(first, 'a', 't', { surface: 'telegram', messageRef: '42:1' })).toast).toBe('Not available');
    flags.on = true;
    w.clock.set(NOW + 2 * HOUR);
    expect((await w.desk.decide(second, 'a', 't', { surface: 'telegram', messageRef: '42:2' })).toast).toBe('Expired');
    expect(w.grants.list()).toEqual([]);
    expect([w.status(first), w.status(second)]).toEqual(['rejected', 'rejected']);
  }));

  const neverAsks: readonly [string, RunOrigin | undefined, Record<string, unknown>][] = [
    ['a mail-woken run', 'external', {}],
    ["Waldo's own run (heartbeat, Brief)", 'waldo', {}],
    ['a standing-order fire', 'owner_standing', {}],
    ['a health-trigger run, which has no origin', undefined, {}],
    ["the owner's turn after it read an email", 'owner', { toolArgSourceTaint: 'external' }],
  ];
  for (const [name, origin, over] of neverAsks) {
    it(`${name} cannot ask for a grant: refused, with no card and no ledger row`, () => inDo(`b3-refuse-${name.replace(/\W+/g, '-')}`, async state => {
      const w = world(state);
      expect(await w.tool('propose_standing_grant').handle(ask as never, w.turn(origin, over))).toMatchObject({ ok: false, code: 'rejected' });
      expect(w.cards).toEqual([]);
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM ledger WHERE kind = 'standing_grant'").one().n).toBe(0);
    }));
  }

  it('with the switch off, asking is refused and nothing is written', () => inDo('b3-tool-off', async state => {
    const w = world(state, { on: () => false });
    expect(await w.tool('propose_standing_grant').handle(ask as never, w.turn('owner'))).toMatchObject({ ok: false, code: 'rejected', error: expect.stringMatching(/cannot act on its own here yet/) });
    expect(w.cards).toEqual([]);
  }));
});

describe('B3: revoke and pause, in words and in the app, end what Waldo may do at once', () => {
  it('revoke_standing_grant ends the grant, and the next own block is an ordinary card', () => inDo('b3-revoke-tool', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    expect(await w.tool('revoke_standing_grant').handle({ class: 'calendar.move_own_block' } as never, w.turn('owner'))).toMatchObject({ ok: true, data: { ended: 1 } });
    expect(w.status(await w.propose())).toBe('open');
    expect(w.writes).toEqual([]);
    expect(w.cards).toHaveLength(1);
  }));

  it('pause_autonomy keeps the grant but stops it, and only a resume in the app with a recent sign-in brings it back', () => inDo('b3-pause-tool', async state => {
    const w = world(state, { signedInAt: new Date(Date.now() - 3 * DAY).toISOString() });
    w.grants.grant(terms(), 'app');
    await w.tool('pause_autonomy').handle({} as never, w.turn('owner'));
    expect(w.status(await w.propose(focus(NOW + 5 * HOUR)))).toBe('open');
    const settings = await w.settings();
    expect(settings.paused).toMatchObject({ at: NOW, via: 'telegram' });
    expect(settings.classes[0]!.grants).toHaveLength(1);
    const resume = await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0002', expected_revision: settings.revision, change: { op: 'resume' } });
    expect([resume.status, resume.body.code]).toEqual([403, 'step_up_required']);
    expect(w.grants.paused()).not.toBeNull();
  }));

  it('the app pauses with no reviewed revision, and resumes with one after a recent sign-in', () => inDo('b3-pause-route', async state => {
    const w = world(state, { signedInAt: new Date().toISOString() });
    w.grants.grant(terms(), 'app');
    expect((await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0003', change: { op: 'pause' } })).status).toBe(200);
    expect(w.status(await w.propose(focus(NOW + 5 * HOUR)))).toBe('open');
    const { revision } = await w.settings();
    expect((await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0004', expected_revision: revision, change: { op: 'resume' } })).status).toBe(200);
    expect(w.status(await w.propose(focus(NOW + 7 * HOUR)))).toBe('done');
  }));

  it('the app revokes one grant by id with no reviewed revision', () => inDo('b3-revoke-route', async state => {
    const w = world(state);
    const { grant_id } = w.grants.grant(terms(), 'app');
    expect((await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0005', change: { op: 'revoke', grant_id } })).status).toBe(200);
    expect(w.status(await w.propose())).toBe('open');
    const again = await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0006', change: { op: 'revoke', grant_id } });
    expect([again.status, again.body.receipt.state]).toEqual([409, 'rejected']);
  }));

  it('an expired grant authorizes nothing and drops out of the settings', () => inDo('b3-expiry', async state => {
    const w = world(state);
    w.grants.grant(terms({ expires_at: NOW + 2 * HOUR }), 'app');
    w.clock.set(NOW + 3 * HOUR);
    expect(w.status(await w.propose(focus(NOW + 6 * HOUR)))).toBe('open');
    expect((await w.settings()).classes[0]!.grants).toEqual([]);
  }));

  it('once the day\'s count is used, the next block is a card; the settings say how many were used', () => inDo('b3-budget', async state => {
    const w = world(state);
    w.grants.grant(terms({ limits: { max_per_day: 1, timezone: 'Asia/Kolkata' } }), 'app');
    expect(w.status(await w.propose(focus(NOW + 5 * HOUR)))).toBe('done');
    expect(w.status(await w.propose(focus(NOW + 7 * HOUR)))).toBe('open');
    expect((await w.settings()).classes[0]!.grants[0]!.uses_today).toBe(1);
  }));
});

describe('B3: the autonomy routes', () => {
  it('a build that does not name autonomy=1 gets 404; receipts and undo are not served yet', () => inDo('b3-route-404', async state => {
    const w = world(state);
    expect((await w.route('GET', '/app/v1/autonomy', undefined, 'approvals=5')).status).toBe(404);
    expect((await w.route('GET', '/app/v1/autonomy/receipts')).status).toBe(404);
    expect((await w.route('POST', '/app/v1/autonomy/undo', { request_id: 'undo-000001', receipt_id: 'tool:x' })).status).toBe(404);
  }));

  it('a grant against a stale revision is refused and writes nothing', () => inDo('b3-route-stale', async state => {
    const w = world(state);
    const { revision } = await w.settings();
    w.grants.pause('console');
    const stale = await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0007', expected_revision: revision, change: { op: 'grant', terms: terms() } });
    expect([stale.status, stale.body.receipt.state]).toEqual([409, 'rejected']);
    expect(w.grants.list()).toEqual([]);
  }));

  it('invalid changes are refused: no revision on a grant, a class not yet available, terms already ended', () => inDo('b3-route-invalid', async state => {
    const w = world(state);
    const { revision } = await w.settings();
    expect((await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0008', change: { op: 'grant', terms: terms() } })).status).toBe(400);
    const later = await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0009', expected_revision: revision,
      change: { op: 'grant', terms: { ...terms(), scope: { class: 'followup.close_on_reply' } } } });
    expect([later.status, later.body.receipt.state]).toEqual([409, 'rejected']);
    const ended = await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0010', expected_revision: revision,
      change: { op: 'grant', terms: terms({ valid_from: NOW - 3 * DAY, expires_at: NOW - DAY }) } });
    expect([ended.status, ended.body.receipt.state]).toEqual([409, 'rejected']);
    expect(w.grants.list()).toEqual([]);
  }));

  it('a repeated request id returns the stored answer; the same id with another change is refused', () => inDo('b3-route-replay', async state => {
    const w = world(state);
    const pause = { request_id: 'autonomy-0011', change: { op: 'pause' } };
    expect((await w.route('POST', '/app/v1/autonomy/changes', pause)).body.duplicate).toBe(false);
    expect((await w.route('POST', '/app/v1/autonomy/changes', pause)).body.duplicate).toBe(true);
    expect((await w.route('POST', '/app/v1/autonomy/changes', { ...pause, change: { op: 'revoke', grant_id: 'g1' } })).status).toBe(409);
  }));

  it('with the switch off, the settings still read, revoke and pause still work, and a new grant is refused', () => inDo('b3-route-off', async state => {
    const flags = { on: true };
    const w = world(state, { on: () => flags.on });
    const { grant_id } = w.grants.grant(terms(), 'app');
    flags.on = false;
    const off = await w.settings();
    expect(off.classes[0]!.grants).toHaveLength(1);
    expect(w.status(await w.propose())).toBe('open');
    const refused = await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0012', expected_revision: off.revision, change: { op: 'grant', terms: terms({ scope: { ...terms().scope, account: 'lee@example.com' } }) } });
    expect([refused.status, refused.body.receipt.state]).toEqual([409, 'rejected']);
    expect((await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0013', change: { op: 'pause' } })).status).toBe(200);
    expect((await w.route('POST', '/app/v1/autonomy/changes', { request_id: 'autonomy-0014', change: { op: 'revoke', grant_id } })).status).toBe(200);
  }));
});

describe('B3: one owner\'s grant never reaches another owner', () => {
  it('a grant in one owner\'s object leaves another owner\'s blocks on cards', () => inDo('b3-owner-a', async first => {
    const a = world(first);
    a.grants.grant(terms(), 'app');
    expect(a.status(await a.propose())).toBe('done');
    await inDo('b3-owner-b', async second => {
      const b = world(second);
      expect(b.grants.list()).toEqual([]);
      expect(b.status(await b.propose())).toBe('open');
      expect(b.writes).toEqual([]);
    });
  }));
});

describe('B3: a build below approvals revision 7 never has a grant card hidden from it', () => {
  const entry = (id: string, appPayload: string): ConversationEntry => ({ id, role: 'assistant', parentId: 'run-1', appPayload, surface: 'app' } as unknown as ConversationEntry);

  it('the approvals list leaves the card out below 7 and shows it from 7', () => inDo('b3-list-revision', async state => {
    const w = world(state);
    const deskApp = approvalDesk(state.storage.sql, { call: async () => ({ message_id: 1 }), owner: 42, google: async () => null, newId: () => 'a1', now: () => NOW, timezone: 'Asia/Kolkata',
      log: () => undefined, grants: w.grants, surface: 'app', appReplyRef: () => 'run-1', currentRunRef: () => 'run-1' });
    await deskApp.proposeStandingGrant(terms());
    const list = async (contract: string) => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request('https://app.example/app/v1/approvals', { headers: { 'x-waldo-app-contract': contract } }),
      { csrf: 'c', expires: NOW + DAY, storage: state.storage, assertCurrent: async () => undefined, sessions: async () => [], desk: deskApp })).json()).approvals;
    expect(await list('approvals=5')).toEqual([]);
    expect((await list('approvals=7')).map(item => item.kind)).toEqual(['standing_grant']);
    expect((await list('approvals=8'))[0]).toMatchObject({ kind: 'standing_grant', exact: { grant: terms() }, actions: ['approve', 'skip', 'defer'] });
  }));

  it('below 7 the chat history drops the card part and puts its words, with an update line, in the text', () => inDo('b3-history-revision', async state => {
    const w = world(state);
    const deskApp = approvalDesk(state.storage.sql, { call: async () => ({ message_id: 1 }), owner: 42, google: async () => null, newId: () => 'a1', now: () => NOW, timezone: 'Asia/Kolkata',
      log: () => undefined, grants: w.grants, surface: 'app', appReplyRef: () => 'run-1', currentRunRef: () => 'run-1' });
    await deskApp.proposeStandingGrant(terms());
    const page = (revision: number, text: string) => appTranscriptPage([entry('m1', text)], null, 20, appApprovalParts(state.storage.sql, revision)).messages[0]!;
    const old = page(5, 'I have put the grant on a card for you.');
    expect(old.parts.map(part => part.type)).toEqual(['text']);
    expect(old.text).toMatch(/^I have put the grant on a card for you\.\n\nLet Waldo place, move and remove its own focus blocks .* Update the Waldo app to review and approve it\.$/s);
    const textless = page(5, '');
    expect(textless.text).toMatch(/Update the Waldo app to review and approve it\.$/);
    const current = page(7, 'I have put the grant on a card for you.');
    expect(current.text).toBe('I have put the grant on a card for you.');
    expect(current.parts.map(part => part.type)).toEqual(['text', 'approval']);
    expect(current.parts[1]).toMatchObject({ kind: 'standing_grant', actions: ['approve', 'skip', 'defer'] });
    // The default, for a caller that names no revision, is the newest contract.
    expect(appApprovalParts(state.storage.sql)('run-1').live).toHaveLength(1);
  }));
});
