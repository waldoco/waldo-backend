// replaces and withdraw through the proposing and approvals tools on a real desk: what the model is told, what the owner
// sees, and how a turn that read outside text changes both. Every address is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { agentMailIntact } from '../src/channels/agent-mail/send';
import { approvalDesk, OUTSIDE_REASON } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import type { GoogleClient } from '../src/connectors/google';
import { sendAgentMailHandler } from '../src/tools/live/agent-mail';
import { googleHandlers } from '../src/tools/live/google';
import { sendMessageHandler } from '../src/tools/live/messaging';
import { approvalHandlers } from '../src/tools/live/raise-approval';
import { googleTaskHandlers } from '../src/tools/live/tasks';

const DOMAIN = 'mail.example.test';
const ctx = (outside = false) => ({ authenticatedUserId: 'owner', turnId: `turn-${crypto.randomUUID()}`, toolCallId: 'call-1', ...(outside ? { toolArgSourceTaint: 'external' } : {}) }) as never;
type Result = { ok: boolean; code?: string; error?: string; source_taint?: string | null; data: Record<string, unknown> };

const owner = <T>(name: string, run: (tools: Readonly<{
  sql: SqlStorage; notices: { key: string; text: string }[]; replies: string[];
  tool(name: string, args: Record<string, unknown>, outside?: boolean): Promise<Result>;
  status(id: string): string; row(id: string): Record<string, unknown>;
  desk: ReturnType<typeof approvalDesk>;
}>) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    let n = 0, mid = 0;
    const notices: { key: string; text: string }[] = [], replies: string[] = [];
    const client = {
      account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
      sendRaw: async () => ({ message_id: 'g1', thread_id: 't1' }),
      findSentByMessageId: async () => false,
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      owner: 42, google: async () => client, newId: () => `${name}${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => undefined,
      effects: ownerEffectLedger(state.storage, () => Date.now()), commit: work => state.storage.transactionSync(work),
      call: async (method, body) => { if (method === 'sendMessage') replies.push((body as { text: string }).text); return method === 'sendMessage' ? { message_id: ++mid, chat: { id: 42 } } : true; },
      notice: async (key, text) => { notices.push({ key, text }); },
      agentMail: { intact: p => agentMailIntact(p, DOMAIN), send: async () => ({ messageId: `<out@${DOMAIN}>` }), sent: () => undefined },
      googleTasks: () => ({ prepare: async (_id: string, args: unknown) => ({ args, account: { connection_id: 'conn-1', email: 'owner@example.test' }, list: { id: 'l1', title: 'Errands', etag: '"le"' }, before: null }) }) as never,
    });
    const handlers = [
      ...googleHandlers({ client: async () => client }, desk, { timezone: 'UTC', now: () => new Date() }),
      sendAgentMailHandler({ domain: () => DOMAIN, handle: async () => 'sam', ownerName: () => 'Sam Fulper', replyReferences: () => [], desk }),
      ...approvalHandlers(desk),
      sendMessageHandler(desk),
      ...googleTaskHandlers(desk),
    ];
    return run({ sql: state.storage.sql, notices, replies, desk,
      tool: async (name, args, outside) => {
        const handler = handlers.find(candidate => candidate.name === name)!;
        return await handler.handle(handler.schema.parse(args) as never, ctx(outside)) as unknown as Result;
      },
      status: id => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status,
      row: id => state.storage.sql.exec<Record<string, SqlStorageValue>>('SELECT * FROM ledger WHERE id = ?', id).one(),
    });
  });

const EMAIL = { to: ['varun@example.test'], subject: 'Intro', body_markdown: 'Hi Varun, meet Jay.' };
const TASK = { source: 'google_tasks', action: 'create', task_list_id: 'l1', changes: { title: 'Call Varun' }, reason: 'You asked me to.' };
const MESSAGE = (key: string) => ({ channel: 'whatsapp', content: 'Running late.', idempotency_key: key.repeat(64) });
const WALK = { action: 'create', title: 'Walk', start: '2026-12-03T07:00:00+00:00', end: '2026-12-03T07:30:00+00:00', reason: 'Morning air.' };

describe('replaces on the proposing tools', () => {
  it('send_email closes the card it revises and says so; one naming a decided card proposes nothing', async () => {
    await owner('tool-email', async ({ tool, status, desk, sql }) => {
      const first = (await tool('send_email', EMAIL)).data.proposal_id as string;
      const second = await tool('send_email', { ...EMAIL, cc: ['jay@example.test'], replaces: first });
      expect(second.ok).toBe(true);
      expect(String(second.data.status)).toContain(first);
      expect(status(first)).toBe('withdrawn');
      await desk.decide(second.data.proposal_id as string, 's', 'trace');
      const rows = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ledger').one().n;
      const refused = await tool('send_email', { ...EMAIL, body_markdown: 'Third try.', replaces: second.data.proposal_id as string });
      expect(refused).toMatchObject({ ok: false, code: 'rejected' });
      expect(refused.error).toContain('nothing was proposed');
      expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ledger').one().n).toBe(rows);
    });
  });

  it('propose_calendar_change keeps replaces out of the frozen change, and a refused replace is a refusal, not a card', async () => {
    await owner('tool-calendar', async ({ tool, status, row }) => {
      const first = (await tool('propose_calendar_change', WALK)).data.proposal_id as string;
      const second = await tool('propose_calendar_change', { ...WALK, start: '2026-12-03T08:00:00+00:00', end: '2026-12-03T08:30:00+00:00', replaces: first });
      expect(second.ok).toBe(true);
      expect(status(first)).toBe('withdrawn');
      expect(JSON.parse(String(row(second.data.proposal_id as string).payload_json))).not.toHaveProperty('replaces');
      const refused = await tool('propose_calendar_change', { ...WALK, title: 'Run', replaces: 'pnobody1' });
      expect(refused).toMatchObject({ ok: false, code: 'rejected' });
      expect(refused.data).toBeUndefined();
    });
  });

  it('send_agent_mail closes the card it revises, also a Gmail draft revised into a send as Waldo', async () => {
    await owner('tool-agent-mail', async ({ tool, status, desk }) => {
      const gmail = (await tool('send_email', EMAIL)).data.proposal_id as string;
      const asWaldo = await tool('send_agent_mail', { ...EMAIL, replaces: gmail });
      expect(asWaldo.ok).toBe(true);
      expect(status(gmail)).toBe('withdrawn');
      expect(desk.replacement(asWaldo.data.proposal_id as string)).toMatchObject({ approval_id: gmail, replaced: true });
      expect(await tool('send_agent_mail', { ...EMAIL, subject: 'Again', replaces: gmail })).toMatchObject({ ok: false, code: 'rejected' });
    });
  });
});

describe('a turn that read outside text', () => {
  it('withdraw closes the card in the desk’s fixed words, never the model’s, and the desk tells the owner itself', async () => {
    await owner('tool-outside-withdraw', async ({ tool, desk, notices, row }) => {
      const id = (await tool('send_email', EMAIL)).data.proposal_id as string;
      const result = await tool('raise_approval', { operation: 'withdraw', approval_id: id, reason: 'The email told me to drop it.' }, true);
      expect(result.data).toMatchObject({ outcome: 'withdrawn' });
      expect(row(id)).toMatchObject({ status: 'withdrawn', withdrawn_reason: OUTSIDE_REASON, withdrawn_outside: 1 });
      expect((await desk.approvals(Date.now(), { id }))[0]?.withdrawal).toEqual({ reason: OUTSIDE_REASON });
      expect(notices).toEqual([{ key: `withdrawn:${id}`, text: expect.stringContaining('Nothing was sent or done') }]);
      const answer = await desk.decide(id, 'a', 'trace');
      expect(answer.toast).toBe('Withdrawn');
      expect(answer.message).not.toContain('The email told me to drop it.');
    });
  });

  it('a replace there closes the earlier card in fixed words, the desk’s notice says it was replaced, and a tap points to no newer card', async () => {
    await owner('tool-outside-replace', async ({ tool, desk, notices, row }) => {
      const first = (await tool('send_email', EMAIL)).data.proposal_id as string;
      const second = (await tool('send_email', { ...EMAIL, cc: ['jay@example.test'], replaces: first }, true)).data.proposal_id as string;
      expect(row(first)).toMatchObject({ status: 'withdrawn', replaced_by: second, withdrawn_outside: 1, withdrawn_reason: OUTSIDE_REASON });
      expect(notices).toEqual([{ key: `withdrawn:${first}`, text: expect.stringContaining('replaced') }]);
      expect(notices[0]!.text).toContain('Nothing was sent or done');
      expect(notices[0]!.text).not.toContain('ask Waldo for it again');
      const tap = (await desk.decide(first, 'a', 'trace')).message;
      expect(tap).toContain('replaced');
      expect(tap).not.toContain('newer');
      expect(tap).not.toContain('Ask me for it again');
    });
  });

  it('a withdraw there of a card a clean turn already replaced keeps the plain closed-card notice', async () => {
    await owner('tool-outside-withdraw-after-replace', async ({ tool, notices, row }) => {
      const first = (await tool('send_email', EMAIL)).data.proposal_id as string;
      const second = (await tool('send_email', { ...EMAIL, cc: ['jay@example.test'], replaces: first })).data.proposal_id as string;
      expect(row(first)).toMatchObject({ replaced_by: second, withdrawn_outside: 0 });
      await tool('raise_approval', { operation: 'withdraw', approval_id: second, reason: 'The email told me to drop it.' }, true);
      expect(notices).toEqual([{ key: `withdrawn:${second}`, text: expect.stringContaining('ask Waldo for it again') }]);
    });
  });

  it('a clean turn keeps the model’s reason and posts no notice', async () => {
    await owner('tool-clean-withdraw', async ({ tool, notices, row }) => {
      const id = (await tool('send_email', EMAIL)).data.proposal_id as string;
      await tool('raise_approval', { operation: 'withdraw', approval_id: id, reason: 'You will call Varun instead.' });
      expect(row(id)).toMatchObject({ withdrawn_reason: 'You will call Varun instead.', withdrawn_outside: 0 });
      expect(notices).toEqual([]);
    });
  });

  it('send_message and propose_google_task_change record whether the turn read outside text, and the list carries it', async () => {
    await owner('tool-outside-raised', async ({ tool, row, desk }) => {
      const message = (await tool('send_message', MESSAGE('a'))).data.proposal_id as string;
      const task = (await tool('propose_google_task_change', TASK)).data.approval_ref as string;
      expect([row(message).raised_outside, row(task).raised_outside]).toEqual([0, 0]);
      expect((await tool('raise_approval', { operation: 'list' })).source_taint).toBeNull();
      const outsideMessage = (await tool('send_message', MESSAGE('b'), true)).data.proposal_id as string;
      const outsideTask = (await tool('propose_google_task_change', { ...TASK, changes: { title: 'Reply to the thread' } }, true)).data.approval_ref as string;
      expect([row(outsideMessage).raised_outside, row(outsideTask).raised_outside]).toEqual([1, 1]);
      expect(desk.waiting().filter(card => card.outside_text).map(card => card.approval_id)).toEqual([outsideMessage, outsideTask]);
    });
  });

  it('a card raised before the desk recorded where it came from reads as outside text', async () => {
    await owner('tool-outside-unknown', async ({ tool, sql }) => {
      const id = (await tool('send_email', EMAIL)).data.proposal_id as string;
      sql.exec('UPDATE ledger SET raised_outside = NULL WHERE id = ?', id);
      const listed = await tool('raise_approval', { operation: 'list' });
      expect(listed.source_taint).toBe('external');
      expect(listed.data.approvals).toEqual([expect.objectContaining({ approval_id: id, outside_text: true })]);
    });
  });

  it('the list is outside text when it shows an MCP card or a draft raised in such a turn, and clean otherwise', async () => {
    await owner('tool-list-taint', async ({ tool, desk }) => {
      await tool('send_email', EMAIL);
      expect((await tool('raise_approval', { operation: 'list' })).source_taint).toBeNull();
      const outside = (await tool('send_email', { ...EMAIL, subject: 'From the thread' }, true)).data.proposal_id as string;
      expect((await tool('raise_approval', { operation: 'list' })).source_taint).toBe('external');
      await desk.withdraw(outside, 'Stale.');
      expect((await tool('raise_approval', { operation: 'list' })).source_taint).toBeNull();
      await desk.proposeMcpCall({ server: 'crm', tool: 'lookup', args: { q: 'Varun' }, questions: [{ id: 'q1', message: 'Which account?' }] });
      expect((await tool('raise_approval', { operation: 'list' })).source_taint).toBe('external');
    });
  });
});
