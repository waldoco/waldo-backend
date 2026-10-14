import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

const iso = (s: string) => s as never;

// The console renders a stored review itself, so a card shown anywhere would serve it. The desk still lets it approve one
// kind only, a calendar change without invite details: the route rule (consoleMayApprove) is not the only guard.
it('the console approves a plain calendar change and no other kind, whatever card was shown', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-console-scope')), async (_instance, state) => {
    const effects: string[] = [];
    let n = 0;
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      event: async (id: string) => ({ id, title: 'Walk', start: '2026-09-26T07:00:00+05:30', end: '2026-09-26T07:30:00+05:30', all_day: false, etag: 'v1' }),
      createEvent: async () => { effects.push('create'); return { id: 'new1', title: 'Walk', start: '', end: '', all_day: false, etag: 'v2' }; },
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      call: async () => ({}), owner: 42, google: async () => client, newId: () => String(++n), now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      mcpCall: async () => { effects.push('mcp'); return 'ran'; },
      canSendMessage: () => true, sendMessage: async () => { effects.push('send'); return { provider_id: 'tg-1' }; },
    });
    const mcp = await desk.proposeMcpCall({ server: 'github', tool: 'merge_pr', args: { number: 1 } });
    const message = await desk.proposeSendMessage({ channel: 'telegram', content: 'On my way', idempotency_key: 'm-1' });
    for (const id of [mcp, message]) {
      expect((await desk.decide(id, 'a', 'trace', { surface: 'console' })).toast).toBe('Not available here');
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('open');
    }
    expect(effects).toEqual([]);
    const walk = await desk.propose({ action: 'create', title: 'Walk', start: iso('2026-09-26T07:00:00+05:30'), end: iso('2026-09-26T07:30:00+05:30'), reason: 'morning' });
    await desk.decide(walk, 'a', 'trace', { surface: 'console' });
    expect(effects).toEqual(['create']);
    expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', walk).one().status).toBe('done');
  });
});

// Neither approve nor change reaches the console for any other kind, nor for a calendar change that invites someone, and
// no effect runs: the desk gate holds without the route rule.
it('the console can neither approve nor change a send, a browser action, a task change or an invite', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('approval-console-scope-kinds')), async (_instance, state) => {
    const effects: string[] = [];
    let n = 0;
    const client = {
      account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
      sendRaw: async () => { effects.push('email'); return { message_id: 'g1' }; },
      findSentByMessageId: async () => false,
      event: async (id: string) => ({ id, title: 'Lunch', start: '2026-09-26T12:00:00+05:30', end: '2026-09-26T13:00:00+05:30', all_day: false, etag: 'v1' }),
      createEvent: async () => { effects.push('create'); return { id: 'new1', title: 'Lunch', start: '', end: '', all_day: false, etag: 'v2' }; },
    } as unknown as GoogleClient;
    const before = { id: 't1', task_list_id: 'l1', title: 'Buy milk', status: 'todo' as const, notes: null, due_date: null, etag: '"e1"', parent: null, deleted: false, assigned: false };
    const task = { source: 'google_tasks' as const, action: 'update' as const, task_list_id: 'l1', task_id: 't1', changes: { title: 'Buy oat milk' }, reason: 'Owner asked' };
    const desk = approvalDesk(state.storage.sql, {
      call: async () => ({}), owner: 42, google: async () => client, newId: () => String(++n), now: () => 1_000_000, timezone: 'Asia/Kolkata', log: () => undefined,
      effects: ownerEffectLedger(state.storage, () => 1_000_000),
      mcpCall: async () => { effects.push('mcp'); return 'ran'; },
      canSendMessage: () => true, sendMessage: async () => { effects.push('send'); return { provider_id: 'tg-1' }; },
      browserSubmit: async () => { effects.push('browser'); return { status: 'submitted' } as never; },
      googleTasks: () => ({
        prepare: async () => ({ args: task, account: { connection_id: 'conn-1', email: 'owner@example.com' }, list: { id: 'l1', title: 'Errands', etag: '"le"' }, before }),
        apply: async () => { effects.push('task'); return {} as never; },
      }) as never,
    });
    const raw = 'To: a@x.test\r\nSubject: Hi\r\n\r\nHello';
    const ids = [
      await desk.proposeMcpCall({ server: 'github', tool: 'merge_pr', args: { number: 1 } }),
      await desk.proposeSendMessage({ channel: 'telegram', content: 'On my way', idempotency_key: 'm-1' }),
      await desk.proposeSendEmail({ to: ['a@x.test'], subject: 'Hi', body: 'Hello', message_id: '<c1@waldo-send>', raw, digest: await sha256Hex(raw) }),
      await desk.proposeBrowserSubmit({ url: 'https://fixture.invalid', action: { selector: '#submit', description: 'Submit' }, binding: { value: 'synthetic' }, steps: [] }),
      await desk.proposeGoogleTaskChange(task),
      await desk.propose({ action: 'create', title: 'Lunch', start: iso('2026-09-26T12:00:00+05:30'), end: iso('2026-09-26T13:00:00+05:30'), reason: 'lunch', location: 'The cafe' }),
    ];
    for (const id of ids) {
      for (const action of ['a', 'e'] as const) {
        expect((await desk.decide(id, action, 'trace', { surface: 'console' })).toast).toBe('Not available here');
        expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('open');
      }
    }
    expect(effects).toEqual([]);
  });
});
