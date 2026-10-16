import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appApprovalV1Schema } from '../../contracts/src/app/approvals';
import { replyApprovalPartV1Schema } from '../../contracts/src/app/parts';
import { appApprovalParts, approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appCaller } from '../src/channels/surfaces/app';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

// Synthetic proposals only. The desk names what each approval decides, in one line, and each action it offers by its
// effect, so the app shows the server's words rather than its own.
const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);
const iso = (s: string) => s as never;
const OPEN = { edit: 'Change it', skip: "Don't do this", defer: 'Skip' };
const PUT_OFF = { skip: "Don't do this", defer: 'Skip' };

describe('the wording of an approval', () => {
  it('names each kind in one line and labels each action by its effect, in the approvals list', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-wording-kinds')), async (_instance, state) => {
      let n = 0;
      const before = { id: 't1', task_list_id: 'l1', title: 'Buy milk', status: 'todo' as const, notes: null, due_date: null, etag: '"e1"', parent: null, deleted: false, assigned: false };
      const args = { source: 'google_tasks' as const, action: 'update' as const, task_list_id: 'l1', task_id: 't1', changes: { title: 'Buy oat milk' }, reason: 'Owner asked' };
      const desk = approvalDesk(state.storage.sql, { owner: 42, newId: () => `w${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, appIdentity: () => true, google: async () => null,
        call: async (method: string) => method === 'sendMessage' ? { message_id: 900 + n, chat: { id: 42 } } : true, effects: ownerEffectLedger(state.storage, () => NOW),
        googleTasks: () => ({ prepare: async () => ({ args, account: { connection_id: 'conn-1', email: 'me@example.com' }, list: { id: 'l1', title: 'Errands', etag: '"le"' }, before }) }) as never });
      const raw = 'To: a@x.test\r\nSubject: Hi\r\n\r\nHello';
      const ids = {
        calendar: await desk.propose({ action: 'create', title: 'Walk\nwith Sam', start: iso('2026-10-10T15:00:00Z'), end: iso('2026-10-10T15:30:00Z'), reason: 'afternoon slot' }),
        email: await desk.proposeSendEmail({ account: 'me@example.com', to: ['a@x.test'], cc: ['c@x.test'], subject: 'Hi', body: 'Hello', message_id: '<w@waldo-send>', raw, digest: await sha256Hex(raw) }),
        long: await desk.proposeSendEmail({ to: ['a@x.test'], subject: 'A'.repeat(100), body: 'Hello', message_id: '<w2@waldo-send>', raw: `${raw}2`, digest: await sha256Hex(`${raw}2`) }),
        message: await desk.proposeSendMessage({ channel: 'whatsapp', content: 'Running late.', idempotency_key: 'w-1' }),
        browser: await desk.proposeBrowserSubmit({ url: 'https://reservations.example/book?party=4#slot', action: { selector: '#book', description: 'Book the table' }, binding: { time: '18:30' }, steps: [] }),
        mcp: await desk.proposeMcpCall({ server: 'crm', tool: 'lookup', args: { q: 'x' } }),
        task: await desk.proposeGoogleTaskChange(args),
      };
      const listed = Object.fromEntries((await desk.approvals(NOW)).map(item => [item.approval_id, item]));
      for (const item of Object.values(listed)) expect(appApprovalV1Schema.safeParse(item).success).toBe(true);
      const wording = (id: string) => ({ question: listed[id]!.question, labels: listed[id]!.labels });
      expect(wording(ids.calendar)).toEqual({ question: 'Add "Walk with Sam" on Sat 10 Oct, 15:00–15:30?', labels: { approve: 'Add the event', ...OPEN } });
      expect(wording(ids.email)).toEqual({ question: 'Send "Hi" to a@x.test and 1 more?', labels: { approve: 'Send email', ...OPEN } });
      expect(wording(ids.long)).toEqual({ question: `Send "${'A'.repeat(39)}…" to a@x.test?`, labels: { approve: 'Send email', ...OPEN } });
      expect(wording(ids.message)).toEqual({ question: 'Send this message on WhatsApp?', labels: { approve: 'Send message', ...OPEN } });
      expect(wording(ids.browser)).toEqual({ question: 'Submit on reservations.example?', labels: { approve: 'Submit on the site', ...PUT_OFF } });
      expect(wording(ids.mcp)).toEqual({ question: 'Run lookup on the crm server?', labels: { approve: 'Run the tool', ...PUT_OFF } });
      expect(wording(ids.task)).toEqual({ question: 'Change "Buy milk"?', labels: { approve: 'Change the task', ...OPEN } });
    });
  });

  it('names a move by where it goes and a cancel by when it was, in the owner\'s zone', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-wording-calendar')), async (_instance, state) => {
      let n = 0;
      const client = { event: async (id: string) => ({ id, title: 'QA', start: '2026-10-13T16:00:00+05:30', end: '2026-10-13T17:00:00+05:30', all_day: false, etag: 'v1' }) } as unknown as GoogleClient;
      const desk = approvalDesk(state.storage.sql, { owner: 42, newId: () => `c${++n}`, now: () => Date.UTC(2026, 9, 13, 4, 0), timezone: 'Asia/Kolkata', log: () => {}, appIdentity: () => true,
        google: async () => client, call: async (method: string) => method === 'sendMessage' ? { message_id: 900 + n, chat: { id: 42 } } : true });
      const move = await desk.propose({ action: 'move', event_id: 'e1', title: 'QA', start: iso('2026-10-13T17:00:00+05:30'), end: iso('2026-10-13T18:00:00+05:30'), reason: 'owner asked' });
      const cancel = await desk.propose({ action: 'cancel', event_id: 'e2', title: 'QA', reason: 'owner asked' });
      const listed = Object.fromEntries((await desk.approvals(Date.UTC(2026, 9, 13, 4, 0))).map(item => [item.approval_id, item]));
      expect(listed[move]).toMatchObject({ question: 'Move "QA" to Tue 13 Oct, 17:00–18:00?', labels: { approve: 'Move the event', ...OPEN } });
      expect(listed[cancel]).toMatchObject({ question: 'Cancel "QA" on Tue 13 Oct, 16:00?', labels: { approve: 'Cancel the event', ...OPEN } });
    });
  });

  it('labels only the actions offered as the approval moves: put off, done with undo, then closed', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-wording-states')), async (_instance, state) => {
      let n = 0;
      const client = { createEvent: async () => ({ id: 'ev1', etag: 'e1' }), event: async () => ({ id: 'ev1', etag: 'e1', status: 'confirmed' }) } as unknown as GoogleClient;
      const desk = approvalDesk(state.storage.sql, { owner: 42, newId: () => `s${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, appIdentity: () => true, google: async () => client,
        call: async (method: string) => method === 'sendMessage' ? { message_id: 900 + n, chat: { id: 42 } } : true, effects: ownerEffectLedger(state.storage, () => NOW) });
      const id = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-10-10T15:00:00Z'), end: iso('2026-10-10T15:30:00Z'), reason: 'afternoon slot' });
      const wording = async (now = NOW) => { const [item] = await desk.approvals(now, { id }); expect(appApprovalV1Schema.safeParse(item).success).toBe(true); return { labels: item!.labels, undo_until: item!.undo_until }; };
      await desk.decide(id, 'd', 'trace', { surface: 'app' });
      expect(await wording()).toEqual({ labels: { approve: 'Add the event', edit: 'Change it', skip: "Don't do this" }, undo_until: undefined });
      await desk.decide(id, 'a', 'trace', { surface: 'app' });
      expect(await wording()).toEqual({ labels: { undo: 'Undo' }, undo_until: NOW + 10 * 60_000 });
      expect(await wording(NOW + 10 * 60_000)).toEqual({ labels: { undo: 'Undo' }, undo_until: NOW + 10 * 60_000 });
      expect(await wording(NOW + 10 * 60_000 + 1)).toEqual({ labels: {}, undo_until: undefined });
    });
  });

  it('labels the chat card\'s actions the same way', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-wording-chat')), async (_instance, state) => {
      let n = 0;
      const desk = approvalDesk(state.storage.sql, { owner: 7_000_000_000_001, surface: 'app', call: appCaller(), newId: () => `h${++n}`, now: () => NOW, timezone: 'UTC', log: () => {},
        google: async () => null, currentRunRef: () => 'app-run-wording' });
      const mcp = await desk.proposeMcpCall({ server: 'crm', tool: 'lookup', args: { q: 'x' } });
      const [card] = appApprovalParts(state.storage.sql)('app-run-wording').live;
      expect(replyApprovalPartV1Schema.safeParse(card).success).toBe(true);
      expect(card).toMatchObject({ approval_id: mcp, actions: ['approve', 'skip', 'defer'], labels: { approve: 'Run the tool', ...PUT_OFF } });
      expect(card).not.toHaveProperty('question');
    });
  });

  it('keeps every question within the contract at the longest names, and never cuts a character in two', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-wording-limits')), async (_instance, state) => {
      let n = 0;
      const long = (c: string, length = 200) => c.repeat(length);
      const before = { id: 't1', task_list_id: 'l1', title: long('t'), status: 'todo' as const, notes: null, due_date: null, etag: '"e1"', parent: null, deleted: false, assigned: false };
      const args = { source: 'google_tasks' as const, action: 'complete' as const, task_list_id: 'l1', task_id: 't1', reason: 'Owner asked' };
      const desk = approvalDesk(state.storage.sql, { owner: 42, newId: () => `m${++n}`, now: () => NOW, timezone: 'UTC', log: () => {}, appIdentity: () => true, google: async () => null,
        call: async (method: string) => method === 'sendMessage' ? { message_id: 900 + n, chat: { id: 42 } } : true, effects: ownerEffectLedger(state.storage, () => NOW),
        googleTasks: () => ({ prepare: async () => ({ args, account: { connection_id: 'conn-1', email: 'me@example.com' }, list: { id: 'l1', title: 'Errands', etag: '"le"' }, before }) }) as never });
      const address = `${long('a', 64)}@${long('b', 60)}.example`;
      const raw = (tag: string) => `To: ${address}\r\nSubject: ${tag}\r\n\r\nHello`;
      const ids = {
        email: await desk.proposeSendEmail({ to: [address, 'b@x.test'], cc: Array.from({ length: 50 }, (_, i) => `c${i}@x.test`), bcc: Array.from({ length: 50 }, (_, i) => `d${i}@x.test`),
          subject: `${long('x', 38)}😀 and the rest`, body: 'Hello', message_id: '<l1@waldo-send>', raw: raw('1'), digest: await sha256Hex(raw('1')) }),
        blank: await desk.proposeSendEmail({ to: ['a@x.test'], subject: ' ', body: 'Hello', message_id: '<l2@waldo-send>', raw: raw('2'), digest: await sha256Hex(raw('2')) }),
        calendar: await desk.propose({ action: 'create', title: long('w'), start: iso('2026-09-30T23:30:00Z'), end: iso('2026-10-01T00:30:00Z'), reason: 'late slot' }),
        browser: await desk.proposeBrowserSubmit({ url: `https://${long('h', 60)}.${long('i', 60)}.example/book`, action: { selector: '#book', description: 'Book' }, binding: {}, steps: [] }),
        mcp: await desk.proposeMcpCall({ server: long('s', 64), tool: long('q', 64), args: {} }),
        message: await desk.proposeSendMessage({ channel: long('z', 64), content: 'Hello', idempotency_key: 'l-3' }),
        task: await desk.proposeGoogleTaskChange(args),
      };
      const listed = Object.fromEntries((await desk.approvals(NOW)).map(item => [item.approval_id, item]));
      for (const id of Object.values(ids)) {
        expect(appApprovalV1Schema.safeParse(listed[id]).success).toBe(true);
        expect(listed[id]!.question!.length).toBeLessThanOrEqual(120);
      }
      expect(listed[ids.email]!.question).toBe(`Send "${long('x', 38)}…" to ${long('a', 39)}… and 101 more?`);
      expect(listed[ids.blank]!.question).toBe('Send this email to a@x.test?');
      expect(listed[ids.calendar]!.question).toMatch(new RegExp(`^Add "${long('w', 39)}…" on Wed 30 Sept?, 23:30 to Thu 1 Oct, 00:30\\?$`));
      expect(listed[ids.browser]!.question).toBe(`Submit on ${long('h', 60)}.${long('i', 38)}…?`);
      expect(listed[ids.mcp]!.question).toBe(`Run ${long('q', 39)}… on the ${long('s', 39)}… server?`);
      expect(listed[ids.message]!.question).toBe(`Send this message on ${long('z', 39)}…?`);
      expect(listed[ids.task]!.question).toBe(`Complete "${long('t', 39)}…"?`);
    });
  });
});
