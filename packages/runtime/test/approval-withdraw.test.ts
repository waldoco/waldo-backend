import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { ApprovalReplaceError, approvalDesk, PROPOSAL_TTL_MS, REPLACED_REASON } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import type { GoogleClient } from '../src/connectors/google';
import { approvalHandlers } from '../src/tools/live/raise-approval';
import { emailProposal } from './fixtures/email-send';

const CSRF = 'c'.repeat(64);
const iso = (s: string) => s as never;
type Call = { method: string; body: Record<string, unknown> };
const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { opened, open }; };

// One owner DO with a Telegram desk whose owner also has the app, an effect ledger, and a Gmail and calendar client whose
// calls can be held open, so a test can land a withdraw while an approval waits inside its effect.
const ownerDesk = async <T>(name: string, run: (tools: Readonly<{
  desk: ReturnType<typeof approvalDesk>; sql: SqlStorage; calls: Call[]; retired: string[]; sends: string[]; creates: string[]; clock: { at: number };
  holds: { google?: ReturnType<typeof gate>; googleCalled?: ReturnType<typeof gate>; send?: ReturnType<typeof gate>; sendCalled?: ReturnType<typeof gate>; create?: ReturnType<typeof gate>; createCalled?: ReturnType<typeof gate> };
  telegram: { deliver: boolean }; writesFirst: { now: boolean }; app: { has: boolean };
  tool(args: unknown): Promise<Record<string, unknown>>;
  list(revision?: number): Promise<ReturnType<typeof appApprovalListV1Schema.parse>['approvals']>;
  decideInApp(id: string, digest: string): Promise<Response>;
  email(subject: string, extra?: Partial<{ cc: string[]; account: string; body: string }>, replaces?: string): Promise<string>;
  status(id: string): string; tap(id: string, action?: string): Promise<Call[]>;
}>) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    let n = 0, mid = 0;
    const calls: Call[] = [], retired: string[] = [], sends: string[] = [], creates: string[] = [];
    const clock = { at: Date.UTC(2026, 10, 2, 9, 0) }, telegram = { deliver: true }, writesFirst = { now: true }, app = { has: true };
    const holds: Parameters<typeof run>[0]['holds'] = {};
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      sendRaw: async () => { holds.sendCalled?.open(); await holds.send?.opened; sends.push('email'); return { message_id: 'g1', thread_id: 't1' }; },
      findSentByMessageId: async (id: string) => ({ message_id: 'g1', thread_id: 't1', rfc822_message_id: id, label_ids: ['SENT'] }),
      createEvent: async () => { holds.createCalled?.open(); await holds.create?.opened; creates.push('event'); return { id: 'new1', title: 'Walk', start: '', end: '', all_day: false, etag: 'v2' }; },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      effects: ownerEffectLedger(state.storage, () => clock.at),
      call: async (method, body) => {
        calls.push({ method, body: body as Record<string, unknown> });
        return method === 'sendMessage' ? telegram.deliver ? { message_id: ++mid, chat: { id: 42 } } : undefined : true;
      },
      owner: 42, newId: () => `${name}${++n}`, now: () => clock.at, timezone: 'Asia/Kolkata', log: () => undefined,
      google: async () => { holds.googleCalled?.open(); await holds.google?.opened; return client; },
      appIdentity: () => app.has, writesFirstNow: () => writesFirst.now,
      retire: async ({ surface, message_ref }) => { retired.push(`${surface}:${message_ref}`); },
    });
    const host = { csrf: CSRF, expires: Date.now() + 3_600_000, signedInAt: new Date().toISOString(), storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk };
    const handler = approvalHandlers(desk)[0]!;
    let messageSeq = 0;
    return run({ desk, sql: state.storage.sql, calls, retired, sends, creates, clock, holds, telegram, writesFirst, app,
      tool: async args => (await handler.handle(handler.schema.parse(args) as never) as { data: Record<string, unknown> }).data,
      list: async (revision = 7) => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request('https://owner/app/v1/approvals', { headers: { [APP_CONTRACT_HEADER]: `approvals=${revision}` } }), host)).json()).approvals,
      decideInApp: (id, digest) => appApprovalsRequest(new Request('https://owner/app/v1/approvals/decisions', { method: 'POST', body: JSON.stringify({ approval_id: id, action: 'approve', expected_digest: digest, request_id: `decision-${id}` }) }), host),
      email: async (subject, extra = {}, replaces) => {
        clock.at += 60_000;
        return desk.proposeSendEmail(await emailProposal({ to: ['varun@example.com'], subject, body: extra.body ?? 'Hi Varun, meet Jay.', message_id: `<${subject.replace(/\W/g, '')}-${++messageSeq}@waldo-send>`,
          ...(extra.cc ? { cc: extra.cc } : {}), ...(extra.account ? { account: extra.account } : {}) }), { ...(replaces ? { replaces } : {}) });
      },
      status: id => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status,
      // The owner taps a button on the Telegram card this desk sent for the approval.
      tap: async (id, action = 'a') => {
        const card = calls.findIndex(call => call.method === 'sendMessage' && JSON.stringify(call.body.reply_markup ?? '').includes(`a:${id}`));
        const before = calls.length;
        await desk.callback({ id: 'cb', from: { id: 42 }, data: `${action}:${id}`, message: { message_id: card + 1, chat: { id: 42 } } }, 'trace');
        return calls.slice(before);
      },
    });
  });

describe('Waldo lists its own cards with what tells them apart', () => {
  it('four revised drafts read apart by time, sender, cc and words, and a replaced one is no longer listed', async () => {
    await ownerDesk('withdraw-list', async ({ email, tool }) => {
      const first = await email('Varun <> Jay', { account: 'owner@example.com' });
      const second = await email('Varun <> Jay', { cc: ['jj@example.com'] });
      const third = await email('Varun <> Jay', { cc: ['jay@example.com'], body: 'Hi Varun, meet Jay. He runs growth.' });
      const listed = (await tool({ operation: 'list' })).approvals as Record<string, string>[];
      expect(listed.map(card => card.approval_id)).toEqual([first, second, third]);
      expect(new Set(listed.map(card => card.raised_at)).size).toBe(3);
      expect(listed[0]!.from).toContain('owner@example.com');
      expect(listed[1]!.card).toContain('jj@example.com');
      expect(listed[2]!.card).toContain('jay@example.com');
      expect(listed[2]!.card).toContain('He runs growth.');
      const fourth = await email('Varun <> Jay', { cc: ['jay@example.com'], body: 'Hi Varun, meet Jay (cc). He runs growth.' }, third);
      const after = (await tool({ operation: 'list' })).approvals as Record<string, string>[];
      expect(after.map(card => card.approval_id)).toEqual([first, second, fourth]);
      expect(after[2]!.replaces).toBe(third);
    });
  });
});

describe('withdraw', () => {
  it('closes a waiting card with its reason in the app, on Telegram and on any tap, and sends nothing', async () => {
    await ownerDesk('withdraw-close', async ({ desk, email, tool, list, decideInApp, retired, sends, status, tap }) => {
      const id = await email('Intro');
      const [before] = await list();
      const result = await tool({ operation: 'withdraw', approval_id: id, reason: 'You said you would call Varun instead.' });
      expect(result).toMatchObject({ approval_id: id, outcome: 'withdrawn', still_shown_on: [] });
      expect(status(id)).toBe('withdrawn');
      expect(await list()).toMatchObject([{ approval_id: id, state: 'superseded', actions: [], withdrawal: { reason: 'You said you would call Varun instead.' } }]);
      // An app build from before the withdrawal still gets the card, closed, without the field it cannot parse.
      const [old] = await list(5);
      expect(old).toMatchObject({ approval_id: id, state: 'superseded', actions: [] });
      expect(old!.withdrawal).toBeUndefined();
      expect(retired.some(ref => ref.startsWith('telegram:'))).toBe(true);
      const answered = await tap(id);
      expect(answered.find(call => call.method === 'answerCallbackQuery')?.body.text).toBe('Withdrawn');
      expect(String(answered.find(call => call.method === 'sendMessage')?.body.text)).toContain('You said you would call Varun instead.');
      const inApp = await decideInApp(id, before!.payload_digest);
      expect(inApp.status).toBe(409);
      expect(JSON.stringify(await inApp.json())).toContain('You said you would call Varun instead.');
      expect((await desk.decide(id, 'a', 'trace', { surface: 'app' })).toast).toBe('Withdrawn');
      expect(sends).toEqual([]);
      expect(status(id)).toBe('withdrawn');
      expect(desk.ledger([])).toContain('You said you would call Varun instead.');
    });
  });

  it('leaves alone a card the owner decided, one that expired, and one that is not this owner’s', async () => {
    let foreign = '';
    await ownerDesk('withdraw-foreign', async ({ email }) => { foreign = await email('Elsewhere'); });
    await ownerDesk('withdraw-refused', async ({ desk, email, tool, status, clock }) => {
      const skipped = await email('Skipped');
      await desk.decide(skipped, 's', 'trace');
      const sent = await email('Sent');
      expect((await desk.decide(sent, 'a', 'trace')).toast).toBe('Sent');
      const stale = await email('Stale');
      expect(await tool({ operation: 'withdraw', approval_id: skipped, reason: 'Old.' })).toMatchObject({ outcome: 'not_waiting', state: 'skipped' });
      expect(await tool({ operation: 'withdraw', approval_id: sent, reason: 'Old.' })).toMatchObject({ outcome: 'not_waiting', state: 'done' });
      clock.at += PROPOSAL_TTL_MS + 1;
      expect(await tool({ operation: 'withdraw', approval_id: stale, reason: 'Old.' })).toMatchObject({ outcome: 'not_waiting', state: 'expired' });
      expect(await tool({ operation: 'withdraw', approval_id: foreign, reason: 'Old.' })).toMatchObject({ outcome: 'not_found' });
      expect([status(skipped), status(sent), status(stale)]).toEqual(['skipped', 'done', 'expired']);
    });
  });

  it('a withdraw that lands while an approval waits before its claim wins, and the approval says so and sends nothing', async () => {
    await ownerDesk('withdraw-race-first', async ({ desk, email, holds, sends, status }) => {
      const id = await email('Race');
      holds.google = gate(); holds.googleCalled = gate();
      const approving = desk.decide(id, 'a', 'trace');
      await holds.googleCalled.opened;
      expect(await desk.withdraw(id, 'A newer draft is coming.')).toMatchObject({ outcome: 'withdrawn' });
      holds.google.open();
      const out = await approving;
      expect(out.toast).toBe('Withdrawn');
      expect(out.message).toContain('A newer draft is coming.');
      expect(sends).toEqual([]);
      expect(status(id)).toBe('withdrawn');
    });
  });

  it('an approval that claimed first wins: the withdraw changes nothing and the email goes out once', async () => {
    await ownerDesk('withdraw-race-second', async ({ desk, email, holds, sends, status }) => {
      const id = await email('Race');
      holds.send = gate(); holds.sendCalled = gate();
      const approving = desk.decide(id, 'a', 'trace');
      await holds.sendCalled.opened;
      expect(await desk.withdraw(id, 'Too late.')).toMatchObject({ outcome: 'not_waiting', state: 'outcome_unknown' });
      holds.send.open();
      expect((await approving).toast).toBe('Sent');
      expect(sends).toEqual(['email']);
      expect(status(id)).toBe('done');
    });
  });

  it('a calendar change whose effect is on record cannot be withdrawn, though its row still reads open', async () => {
    await ownerDesk('withdraw-race-calendar', async ({ desk, holds, creates, status }) => {
      const id = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-11-03T07:00:00+05:30'), end: iso('2026-11-03T07:30:00+05:30'), reason: 'morning' });
      holds.create = gate(); holds.createCalled = gate();
      const approving = desk.decide(id, 'a', 'trace');
      await holds.createCalled.opened;
      expect(status(id)).toBe('open');
      expect((await desk.withdraw(id, 'Not needed.')).outcome).toBe('not_waiting');
      holds.create.open();
      await approving;
      expect(creates).toEqual(['event']);
      expect(status(id)).toBe('done');
    });
  });
});

describe('replace', () => {
  it('a revised card closes exactly the card it names, in the write that shows it', async () => {
    await ownerDesk('replace-one', async ({ desk, email, list, retired, status, tap }) => {
      const a = await email('Draft');
      const b = await email('Draft', { cc: ['jj@example.com'] });
      const c = await email('Draft', { cc: ['jay@example.com'] });
      const d = await email('Draft', { cc: ['jay@example.com'], body: 'Hi Varun, meet Jay. Final.' }, c);
      expect([status(a), status(b), status(c), status(d)]).toEqual(['open', 'open', 'withdrawn', 'open']);
      expect(desk.replacement(d)).toEqual({ approval_id: c, replaced: true, state: 'superseded' });
      expect((await list()).find(item => item.approval_id === c)).toMatchObject({ state: 'superseded', withdrawal: { reason: REPLACED_REASON, replaced_by: d } });
      expect(retired.filter(ref => ref.startsWith('telegram:'))).toHaveLength(1);
      expect(String((await tap(c)).find(call => call.method === 'sendMessage')?.body.text)).toContain(REPLACED_REASON);
    });
  });

  it('refuses before proposing anything when the card it names is decided or not the owner’s', async () => {
    await ownerDesk('replace-refused', async ({ desk, email, sql }) => {
      const a = await email('Draft');
      await desk.decide(a, 's', 'trace');
      const rows = () => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ledger').one().n;
      const before = rows();
      await expect(email('Draft v2', {}, a)).rejects.toEqual(new ApprovalReplaceError('skipped'));
      await expect(email('Draft v3', {}, 'pnobody1')).rejects.toEqual(new ApprovalReplaceError('not_found'));
      expect(rows()).toBe(before);
    });
  });

  it('the earlier card stays the owner’s to decide until the revised one reaches them', async () => {
    await ownerDesk('replace-waits', async ({ desk, email, status, telegram, writesFirst, app }) => {
      app.has = false;
      const a = await email('Draft');
      telegram.deliver = false; writesFirst.now = false;
      const b = await email('Draft', { cc: ['jay@example.com'] }, a);
      expect([status(a), status(b)]).toEqual(['open', 'card_unconfirmed']);
      telegram.deliver = true; writesFirst.now = true;
      await desk.ownerWrote();
      expect([status(a), status(b)]).toEqual(['withdrawn', 'open']);
      expect(desk.replacement(b)).toMatchObject({ approval_id: a, replaced: true });
    });
  });
});
