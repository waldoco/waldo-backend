import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appTranscriptPage } from '../src/channels/app-api';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { appApprovalParts, approvalDesk } from '../src/channels/approvals';
import type { ConversationEntry } from '@waldo/contracts';
import { offsetIso, planBlocks, planReview, type StoredPlan } from '../src/channels/calendar-plan';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { GoogleError, sha256Hex, type CalendarItem, type GoogleClient } from '../src/connectors/google';
import { DAY_CARDS, dayCardPrompt, PLAN_CARD_RULE } from '../src/prompt/day-cards';
import { calendarPlanHandler } from '../src/tools/live/google';

// The day plan card (approvals revision 9) on the real desk and effect ledger, against a fake Google calendar. Every block
// is its own effect; the add is all or nothing, with honest done, not done and outcome unknown.
const NOW = Date.parse('2026-11-05T02:00:00Z');
const OWNER = 447700900123;
const PLAN: StoredPlan = { day: '2026-11-05', time_zone: 'Asia/Kolkata', reason: 'your day, laid out', operation_ref: 'tool:plan-1', blocks: [
  { title: 'Write the board memo', start: '2026-11-05T09:30:00+05:30', end: '2026-11-05T11:30:00+05:30', block: 'deep_work' },
  { title: 'Lunch and a walk', start: '2026-11-05T13:00:00+05:30', end: '2026-11-05T14:00:00+05:30', block: 'rest' },
  { title: 'Reply to Priya', start: '2026-11-05T14:00:00+05:30', end: '2026-11-05T14:30:00+05:30' },
] };

type Fake = { events: Map<string, CalendarItem & { status?: string }>; failCreate: Map<number, () => never>; failRead: boolean; failCancel: (() => never) | null; creates: number; loseCreateReply: number | null };
const calendar = (): Fake & { client: GoogleClient } => {
  const fake: Fake = { events: new Map(), failCreate: new Map(), failRead: false, failCancel: null, creates: 0, loseCreateReply: null };
  let version = 0;
  const client = {
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    async createEvent(input: { id?: string; title: string; start: string; end: string; operationMarker?: string }) {
      const index = fake.creates++;
      fake.failCreate.get(index)?.();
      if (fake.events.has(input.id!)) throw new GoogleError(409, 'duplicate');
      const event = { id: input.id!, title: input.title, start: input.start, end: input.end, all_day: false, etag: `v${++version}`, operation_marker: input.operationMarker! };
      fake.events.set(input.id!, event);
      if (fake.loseCreateReply === index) throw new Error('connection reset after the write');
      return event;
    },
    async event(id: string) {
      if (fake.failRead) throw new GoogleError(401, 'google token failed: invalid_grant');
      const event = fake.events.get(id);
      if (!event) throw new GoogleError(404, 'not found');
      return { ...event };
    },
    async cancelEvent(id: string, etag: string, marker: string) {
      fake.failCancel?.();
      const event = fake.events.get(id)!;
      if (event.etag !== etag) throw new GoogleError(412, 'precondition failed');
      fake.events.set(id, { ...event, status: 'cancelled', etag: `v${++version}`, operation_marker: marker });
    },
  } as unknown as GoogleClient;
  return Object.assign(fake, { client });
};

const harness = (state: DurableObjectState, fake: ReturnType<typeof calendar>, now = () => NOW) => {
  let n = 0;
  const cards: string[] = [];
  const desk = approvalDesk(state.storage.sql, {
    owner: OWNER, surface: 'telegram', appIdentity: () => true,
    call: async (method: string, body: object) => { if (method === 'sendMessage') cards.push((body as { text: string }).text); return { message_id: cards.length, chat: { id: OWNER } }; },
    google: async () => fake.client, newId: () => String(++n), now, timezone: 'Asia/Kolkata', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, now),
  });
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const live = () => [...fake.events.values()].filter(event => event.status !== 'cancelled').map(event => event.title);
  return { desk, cards, status, live };
};
const owner = (work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`calendar-plan-${crypto.randomUUID()}`)), (_instance, state) => work(state));

describe('a plan\'s blocks from the model\'s local times', () => {
  it('writes each block in the owner\'s zone with its own offset', () => {
    expect(offsetIso(Date.parse('2026-11-05T04:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-05T09:30:00+05:30');
    expect(planBlocks({ day: '2026-11-05', blocks: [{ title: 'A', start: '09:30', end: '11:30' }, { title: 'B', start: '13:00', end: '14:00', block: 'rest' }] }, 'Asia/Kolkata'))
      .toEqual([{ title: 'A', start: '2026-11-05T09:30:00+05:30', end: '2026-11-05T11:30:00+05:30' }, { title: 'B', start: '2026-11-05T13:00:00+05:30', end: '2026-11-05T14:00:00+05:30', block: 'rest' }]);
  });

  it('holds a whole day across the London clock changes, each block in the offset of its own hour', () => {
    const autumn = planBlocks({ day: '2026-10-25', blocks: [{ title: 'Run', start: '00:30', end: '01:30' }, { title: 'Read', start: '23:00', end: '23:50' }] }, 'Europe/London');
    // 01:30 happens twice on 25 Oct; a block ending then takes the later one.
    expect(autumn).toEqual([{ title: 'Run', start: '2026-10-25T00:30:00+01:00', end: '2026-10-25T01:30:00+00:00' }, { title: 'Read', start: '2026-10-25T23:00:00+00:00', end: '2026-10-25T23:50:00+00:00' }]);
    const spring = planBlocks({ day: '2026-03-29', blocks: [{ title: 'Run', start: '00:15', end: '00:45' }, { title: 'Work', start: '09:00', end: '10:00' }] }, 'Europe/London');
    expect(spring).toEqual([{ title: 'Run', start: '2026-03-29T00:15:00+00:00', end: '2026-03-29T00:45:00+00:00' }, { title: 'Work', start: '2026-03-29T09:00:00+01:00', end: '2026-03-29T10:00:00+01:00' }]);
  });

  it('refuses a time the clocks skip, never moving the block', () => {
    // 01:00-02:00 does not exist in London on 29 Mar.
    expect(planBlocks({ day: '2026-03-29', blocks: [{ title: 'Gap', start: '01:10', end: '01:50' }, { title: 'Work', start: '09:00', end: '10:00' }] }, 'Europe/London'))
      .toBe('01:10 does not exist on 2026-03-29, when the clocks change');
    expect(planBlocks({ day: '2026-11-05', blocks: [{ title: 'A', start: '11:00', end: '10:00' }, { title: 'B', start: '12:00', end: '13:00' }] }, 'Asia/Kolkata')).toBe('each block must end after it starts');
  });

  it('reads as a card: the day, then each block at its own time, and no one invited', () => {
    expect(planReview(PLAN)).toBe('Add 3 blocks to your calendar on Thu 5 Nov:\n09:30–11:30 Write the board memo (deep work)\n13:00–14:00 Lunch and a walk (rest)\n14:00–14:30 Reply to Priya\n\nNo one is invited. your day, laid out');
  });
});

describe('the day plan card', () => {
  it('golden: one tap adds every block, each once, and the app shows the card at revision 9 with its exact blocks', async () => {
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      expect(fake.events.size).toBe(0);
      expect(h.cards[0]).toContain('09:30–11:30 Write the board memo');
      const [item] = await h.desk.approvals(NOW, { id });
      expect(item).toMatchObject({ kind: 'calendar_plan', state: 'open', exact: { plan: { day: '2026-11-05', blocks: PLAN.blocks, time_zone: 'Asia/Kolkata' } } });
      const out = await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect(out.toast).toBe('Done');
      expect(h.status(id)).toBe('done');
      expect(h.live()).toEqual(PLAN.blocks.map(block => block.title));
      expect([...fake.events.keys()]).toEqual(await Promise.all(PLAN.blocks.map((_, i) => sha256Hex(`tool:plan-1:apply:${i}`))));
      // A second tap is answered, and adds nothing.
      expect((await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' })).toast).toBe('Already handled.');
      expect(fake.creates).toBe(3);
    });
  });

  it('a failure mid-add removes what was added and reads not done', async () => {
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake);
      fake.failCreate.set(2, () => { throw new GoogleError(400, 'bad request'); });
      const id = await h.desk.proposeCalendarPlan(PLAN);
      const out = await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect([out.toast, h.status(id)]).toEqual(['Not done', 'failed']);
      expect(out.message).toContain('removed the 2 blocks already added');
      expect(h.live()).toEqual([]);
      const [item] = await h.desk.approvals(NOW, { id });
      expect(item?.state).toBe('not_done');
    });
  });

  it('Google access revoked mid-add: the rollback cannot run either, so the card reads outcome unknown and names what may be left', async () => {
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake);
      fake.failCreate.set(2, () => { fake.failRead = true; fake.failCancel = () => { throw new GoogleError(401, 'google token failed: invalid_grant'); }; throw new GoogleError(401, 'google token failed: invalid_grant'); });
      const id = await h.desk.proposeCalendarPlan(PLAN);
      const out = await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect([out.toast, h.status(id)]).toEqual(['Outcome unknown', 'uncertain']);
      expect(out.message).toContain('"Write the board memo", "Lunch and a walk" may still be on your calendar');
      expect(h.live()).toEqual(['Write the board memo', 'Lunch and a walk']);
      const [item] = await h.desk.approvals(NOW, { id });
      expect(item?.state).toBe('outcome_unknown');
    });
  });

  it('a write whose reply was lost is found by readback, not written twice', async () => {
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake);
      fake.loseCreateReply = 1;
      const id = await h.desk.proposeCalendarPlan(PLAN);
      expect((await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' })).toast).toBe('Done');
      expect([fake.creates, fake.events.size, h.live().length]).toEqual([3, 3, 3]);
    });
  });

  it('after an interruption mid-add, approving again finishes the plan from the ledger and adds nothing twice', async () => {
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      // The object stopped while block 1 was on its way: block 0 is on record, block 1 is attempting and did land.
      const effects = ownerEffectLedger(state.storage, () => NOW);
      const first = await sha256Hex('tool:plan-1:apply:0'), second = await sha256Hex('tool:plan-1:apply:1');
      await effects.execute({ operationId: 'tool:plan-1:apply:0', owner_ref: String(OWNER), tool: 'calendar_plan', payload: { ...PLAN.blocks[0], block_index: 0 } },
        { dispatch: async () => { await fake.client.createEvent({ ...PLAN.blocks[0]!, id: first, operationMarker: first }); return { provider_id: first, result: { etag: 'v1' } }; }, reconcile: async () => ({ status: 'unknown' }) });
      effects.reserve({ operationId: 'tool:plan-1:apply:1', owner_ref: String(OWNER), tool: 'calendar_plan', payload: { ...PLAN.blocks[1], block_index: 1 } });
      state.storage.kv.put('owner:effect:tool:plan-1:apply:1', { ...state.storage.kv.get<Record<string, unknown>>('owner:effect:tool:plan-1:apply:1'), state: 'attempting' });
      await fake.client.createEvent({ ...PLAN.blocks[1]!, id: second, operationMarker: second });
      state.storage.sql.exec("UPDATE ledger SET status = 'uncertain', decided_at = ? WHERE id = ?", NOW, id);
      expect((await h.desk.approvals(NOW, { id }))[0]?.state).toBe('outcome_unknown');
      const out = await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect([out.toast, h.status(id)]).toEqual(['Done', 'done']);
      expect([fake.creates, h.live()]).toEqual([3, PLAN.blocks.map(block => block.title)]);
    });
  });

  it('undo removes every block; one the owner changed since is left, and the receipt says which', async () => {
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      const undone = await h.desk.decide(id, 'u', 'trace', { surface: 'telegram' });
      expect([undone.toast, h.status(id), h.live()]).toEqual(['Undone', 'undone', []]);
    });
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      const lunch = await sha256Hex('tool:plan-1:apply:1');
      fake.events.set(lunch, { ...fake.events.get(lunch)!, title: 'Lunch with Sam', etag: 'owner-edit' });
      const undone = await h.desk.decide(id, 'u', 'trace', { surface: 'telegram' });
      expect([undone.toast, h.status(id), h.live()]).toEqual(['Partly undone', 'done', ['Lunch with Sam']]);
      expect(undone.message).toContain('Left "Lunch and a walk" as it is');
    });
  });

  it('undo past its 10 minutes leaves the plan', async () => {
    await owner(async state => {
      let at = NOW;
      const fake = calendar(), h = harness(state, fake, () => at);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      at += 11 * 60_000;
      expect((await h.desk.decide(id, 'u', 'trace', { surface: 'telegram' })).toast).toBe('Too late to undo');
      expect(h.live()).toHaveLength(3);
    });
  });

  it('closes when its first block starts', async () => {
    await owner(async state => {
      const fake = calendar(), h = harness(state, fake, () => Date.parse('2026-11-05T04:01:00Z'));
      const id = await h.desk.proposeCalendarPlan(PLAN);
      expect((await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' })).toast).not.toBe('Done');
      expect(fake.creates).toBe(0);
    });
  });
});

describe('the largest plan the contract allows', () => {
  it('twelve blocks with 200-character titles and a 300-character reason still make a whole card in chat and in the app', async () => {
    await owner(async state => {
      const fake = calendar();
      const blocks = Array.from({ length: 12 }, (_, i) => ({ title: `${String.fromCharCode(65 + i)}${'x'.repeat(199)}`,
        start: `2026-11-05T${String(i + 8).padStart(2, '0')}:00:00+05:30`, end: `2026-11-05T${String(i + 8).padStart(2, '0')}:45:00+05:30`, block: 'deep_work' as const }));
      const big: StoredPlan = { ...PLAN, blocks, reason: 'r'.repeat(300) };
      const h = harness(state, fake);
      const id = await h.desk.proposeCalendarPlan(big);
      expect(h.cards[0]).toContain(blocks[11]!.title);
      expect(h.desk.placement(id).hereApprovable).toBe(true);
      const [item] = await h.desk.approvals(NOW, { id });
      expect(item).toMatchObject({ kind: 'calendar_plan', state: 'open', actions: ['approve', 'edit', 'skip', 'defer'] });
      let n = 0;
      const app = approvalDesk(state.storage.sql, { owner: OWNER, surface: 'app', appIdentity: () => true, call: async () => true, google: async () => fake.client, newId: () => `a${++n}`, now: () => NOW,
        timezone: 'Asia/Kolkata', log: () => undefined, commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW), currentRunRef: () => 'r9' });
      await app.proposeCalendarPlan(big);
      expect(appApprovalParts(state.storage.sql, 9)('r9').live.map(part => [part.kind, part.actions])).toEqual([['calendar_plan', ['approve', 'edit', 'skip', 'defer']]]);
    });
  });
});

describe('an app build older than approvals revision 9', () => {
  it('never gets the card: its chat carries the card\'s words and asks it to update, while a revision 9 build gets the card', async () => {
    await owner(async state => {
      const fake = calendar();
      let n = 0;
      const desk = approvalDesk(state.storage.sql, { owner: OWNER, surface: 'app', appIdentity: () => true, call: async () => true, google: async () => fake.client, newId: () => String(++n), now: () => NOW,
        timezone: 'Asia/Kolkata', log: () => undefined, commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW), currentRunRef: () => 'r1' });
      await desk.proposeCalendarPlan(PLAN);
      const old = appApprovalParts(state.storage.sql, 8)('r1'), current = appApprovalParts(state.storage.sql, 9)('r1');
      expect(old.live).toEqual([]);
      expect(old.withheld).toHaveLength(1);
      expect(old.withheld![0]).toContain('09:30–11:30 Write the board memo');
      expect(old.withheld![0]).toContain('Update the Waldo app to review and approve it.');
      expect(current.live.map(part => part.kind)).toEqual(['calendar_plan']);
      expect(current.withheld).toBeUndefined();
      // What each build renders: the old one gets the words in its text and no card part; the approvals list leaves it out.
      const entry = { id: 'm1', role: 'assistant', parentId: 'r1', appPayload: 'Here is your day.', surface: 'app' } as unknown as ConversationEntry;
      const page = (revision: number) => appTranscriptPage([entry], null, 20, appApprovalParts(state.storage.sql, revision)).messages[0]!;
      expect(page(8).parts.map(part => part.type)).toEqual(['text']);
      expect(page(8).text).toMatch(/^Here is your day\.\n\nAdd 3 blocks to your calendar on Thu 5 Nov:.*Update the Waldo app to review and approve it\.$/s);
      expect(page(9).text).toBe('Here is your day.');
      expect(page(9).parts.map(part => part.type)).toEqual(['text', 'approval']);
      const list = async (contract: string) => (await (await appApprovalsRequest(new Request('https://app.example/app/v1/approvals', { headers: { 'x-waldo-app-contract': contract } }),
        { csrf: 'c', expires: NOW + 86_400_000, storage: state.storage, assertCurrent: async () => undefined, sessions: async () => [], desk } as never)).json() as { approvals: { kind: string }[] }).approvals.map(item => item.kind);
      expect(await list('approvals=8')).toEqual([]);
      expect(await list('approvals=9')).toEqual(['calendar_plan']);
    });
  });
});

describe('propose_calendar_plan', () => {
  const clock = { timezone: 'Asia/Kolkata', now: () => new Date(NOW) };
  const args = { day: '2026-11-05', reason: 'your day', blocks: [{ title: 'Memo', start: '09:30', end: '11:30' }, { title: 'Walk', start: '13:00', end: '13:30', block: 'rest' as const }] };
  const access = (client: GoogleClient) => ({ client: async () => client }) as never;
  it('only proposes: nothing reaches the calendar until the owner approves', async () => {
    const fake = calendar(), proposed: StoredPlan[] = [];
    const desk = { proposeCalendarPlan: async (plan: StoredPlan) => { proposed.push(plan); return 'p1'; }, propose: async () => 'x', proposeSendEmail: async () => 'x', record: () => undefined } as never;
    const result = await calendarPlanHandler(access(fake.client), desk, clock).handle(args, { turnId: 't1' } as never) as { ok: boolean; data?: { proposal_id: string; applied: boolean } };
    expect(result).toMatchObject({ ok: true, data: { proposal_id: 'p1', applied: false } });
    expect(proposed[0]).toMatchObject({ day: '2026-11-05', time_zone: 'Asia/Kolkata', account: 'owner@example.test', blocks: [{ start: '2026-11-05T09:30:00+05:30' }, { block: 'rest' }] });
    expect(fake.creates).toBe(0);
  });
  it('refuses a title that names the owner\'s health, and one it could not check', async () => {
    const fake = calendar();
    const desk = { proposeCalendarPlan: async () => { throw new Error('must not propose'); } } as never;
    for (const verdict of ['refused', 'unchecked'] as const) {
      const result = await calendarPlanHandler(access(fake.client), desk, clock, { check: async () => verdict }).handle(args, { turnId: 't1' } as never);
      expect(result).toMatchObject({ ok: false, code: 'rejected' });
    }
  });
});

describe('the planning Brief offers the plan card only with CALENDAR_PLAN on', () => {
  const brief = DAY_CARDS.find(card => card.id === 'card:brief')!;
  const context = { calendar: 'No events.', ledger: '', today: '', updates: '' };
  it('adds the plan card rule to the planning Brief, and off leaves every prompt as it was', () => {
    expect(dayCardPrompt(brief, '2026-11-05T07:00', context, true, false, false, true, true)).toContain(PLAN_CARD_RULE);
    expect(dayCardPrompt(brief, '2026-11-05T07:00', context, false, false, false, true, true)).not.toContain(PLAN_CARD_RULE);
    for (const card of DAY_CARDS) for (const planning of [false, true]) for (const layout of [false, true]) {
      expect(dayCardPrompt(card, '2026-11-05T07:00', context, planning, true, false, layout, false)).toBe(dayCardPrompt(card, '2026-11-05T07:00', context, planning, true, false, layout));
    }
  });
});
