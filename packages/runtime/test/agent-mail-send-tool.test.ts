// send_agent_mail through the real dispatcher and its hooks: it only raises the owner's card, from the owner's own Waldo
// address, and refuses with a fixed answer whenever it cannot. The binding is a fake; every address is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { buildSessionState } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { agentMailInbox } from '../src/channels/agent-mail/inbox';
import type { AgentMailParts } from '../src/channels/agent-mail/render';
import { agentMailIntact, type AgentMailSendProposal } from '../src/channels/agent-mail/send';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool } from '../src/tools/dispatcher';
import { sendAgentMailHandler, type AgentMailToolHost } from '../src/tools/live/agent-mail';

const DOMAIN = 'mail.example.test';
const context = (taint: 'external' | null) => ({
  authenticatedUserId: 'owner', trigger: 'user_message' as const, turnId: 'turn-1',
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
  hasApproval: () => false, sourceTaint: taint, toolArgSourceTaint: taint, sanitise,
});

const harness = (state: DurableObjectState, host: Partial<Omit<AgentMailToolHost, 'desk'>> = {}) => {
  let n = 0;
  const sent: AgentMailParts[] = [], inbox = agentMailInbox(state.storage);
  const desk = approvalDesk(state.storage.sql, {
    surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appLink: appApprovalLink, google: async () => null, newId: () => `t${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => Date.now()),
    agentMail: { intact: p => agentMailIntact(p, DOMAIN), send: async parts => { sent.push(parts); return { messageId: `<out-${sent.length}@${DOMAIN}>` }; }, sent: (id, p) => inbox.recordOutbound(id, p.in_reply_to) },
  });
  const handler = sendAgentMailHandler({
    domain: () => DOMAIN, handle: async () => 'sam', ownerName: () => 'Sam Fulper', replyReferences: id => inbox.replyReferences(id), ...host,
    desk: { proposeAgentMailSend: p => desk.proposeAgentMailSend(p), placement: id => desk.placement(id) },
  });
  const call = (args: unknown, taint: 'external' | null = null, id = `call-${crypto.randomUUID()}`) => dispatchTool({ id, name: 'send_agent_mail', args }, context(taint) as never, { handlers: [handler as never] });
  const rows = () => state.storage.sql.exec<{ id: string; status: string; payload_json: string }>("SELECT id, status, payload_json FROM ledger WHERE kind = 'agent_mail_send'").toArray()
    .map(row => ({ id: row.id, status: row.status, payload: JSON.parse(row.payload_json) as AgentMailSendProposal }));
  return { desk, handler, call, rows, sent, inbox };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));
const ARGS = { to: ['lee@example.test'], cc: ['kim@example.test'], subject: 'Friday', body_markdown: 'See you at **4**.' };

describe('send_agent_mail', () => {
  it('is not offered, and refuses, while sending as Waldo is off', async () => {
    await owner('agent-mail-tool-off', async state => {
      const f = harness(state, { domain: () => null });
      expect(await f.handler.eligible!()).toEqual({ ok: false, reason: 'not_configured' });
      expect(await f.handler.handle(ARGS, context(null) as never)).toMatchObject({ ok: false, code: 'rejected', error: 'Sending email as Waldo is not turned on for this Waldo, so nothing was proposed.' });
      expect(f.rows()).toEqual([]);
    });
  });

  it('refuses when the owner holds no Waldo address, or the directory cannot say', async () => {
    await owner('agent-mail-tool-no-handle', async state => {
      expect(await harness(state, { handle: async () => null }).handler.handle(ARGS, context(null) as never)).toMatchObject({ ok: false, code: 'rejected', error: expect.stringContaining('no Waldo address yet') });
      expect(await harness(state, { handle: async () => { throw new Error('directory down'); } }).handler.handle(ARGS, context(null) as never))
        .toMatchObject({ ok: false, code: 'transient', error: "I couldn't check the owner's Waldo address just now, so nothing was proposed. Try again shortly." });
      expect(harness(state).rows()).toEqual([]);
    });
  });

  it('refuses a reply in a thread Waldo is not part of', async () => {
    await owner('agent-mail-tool-unknown-thread', async state => {
      const f = harness(state);
      expect(await f.handler.handle({ ...ARGS, in_reply_to: '<stranger@example.test>' }, context(null) as never)).toMatchObject({ ok: false, code: 'rejected', error: expect.stringContaining('not in a mail thread Waldo is part of') });
      expect(f.rows()).toEqual([]);
    });
  });

  for (const taint of [null, 'external'] as const) {
    it(`raises an open card from the owner's Waldo address and sends nothing, in a turn with ${taint ?? 'no'} outside text`, async () => {
      await owner('agent-mail-tool-card', async state => {
        const f = harness(state);
        const out = await f.call(ARGS, taint);
        expect(out).toMatchObject({ ok: true, data: { status: 'review card requested in chat; nothing was sent', sent: false } });
        const [row] = f.rows();
        expect(row).toMatchObject({ status: 'open', payload: { handle: 'sam', from: { name: "Waldo, Sam's assistant", address: `sam@${DOMAIN}` }, to: ['lee@example.test'], cc: ['kim@example.test'], subject: 'Friday' } });
        expect((out as { data?: { proposal_id?: string } }).data?.proposal_id).toBe(row!.id);
        expect(row!.payload.body).toContain(`Waldo, Sam's assistant\nsam@${DOMAIN}`);
        expect(f.sent).toEqual([]);
        // The same turn and arguments find the same card.
        await f.call(ARGS, taint);
        expect(f.rows()).toHaveLength(1);
      });
    });
  }

  it('checks the arguments as a send to other people: a health reading never goes on a card, and the addresses stay whole', async () => {
    await owner('agent-mail-tool-scribe', async state => {
      const f = harness(state);
      for (const body_markdown of ['Sam slept 5 hours and his HRV was 42 ms.', 'His recovery score is 38 today.'])
        expect([body_markdown, await f.call({ ...ARGS, body_markdown })]).toMatchObject([body_markdown, { ok: false }]);
      expect(f.rows()).toEqual([]);
      expect(await f.call({ ...ARGS, body_markdown: 'Call me on +1 415 555 0100 or write to kim@example.test.' })).toMatchObject({ ok: true });
      expect(f.rows()[0]!.payload.body_markdown).toBe('Call me on +1 415 555 0100 or write to kim@example.test.');
    });
  });

  it('refuses arguments the schema does not allow, before any card', async () => {
    await owner('agent-mail-tool-invalid', async state => {
      const f = harness(state);
      for (const args of [{ ...ARGS, to: [] }, { ...ARGS, bcc: ['x@example.test'] }, { ...ARGS, subject: 'Friday\r\nBcc: x@example.test' }, { ...ARGS, in_reply_to: 'no-brackets@example.test' }])
        expect(await f.call(args)).toMatchObject({ ok: false });
      expect(f.rows()).toEqual([]);
    });
  });

  it('a reply carries In-Reply-To and References from the thread, and the sent reply joins it', async () => {
    await owner('agent-mail-tool-reply', async state => {
      const f = harness(state);
      const delivery = (messageId: string, inReplyTo: string[] = [], references: string[] = []) =>
        ({ handle: 'sam', messageId, inReplyTo, references, from: ['owner@example.test'], ownerEmail: 'owner@example.test', raw: new TextEncoder().encode(messageId) });
      await f.inbox.admit(delivery('m1@example.test'));
      await f.inbox.admit(delivery('m2@example.test', ['m1@example.test'], ['m1@example.test']));
      const out = await f.call({ ...ARGS, subject: 'Re: Friday', in_reply_to: '<m2@example.test>' });
      expect(out).toMatchObject({ ok: true });
      const [row] = f.rows();
      expect(row!.payload).toMatchObject({ in_reply_to: '<m2@example.test>', references: ['<m1@example.test>', '<m2@example.test>'] });
      expect((await f.desk.decide(row!.id, 'a', 'trace', { surface: 'app' })).toast).toBe('Sent');
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]!.headers).toEqual({ 'In-Reply-To': '<m2@example.test>', References: '<m1@example.test> <m2@example.test>' });
      expect(f.inbox.replyReferences(`<out-1@${DOMAIN}>`)).toEqual(['<m1@example.test>', '<m2@example.test>', `<out-1@${DOMAIN}>`]);
    });
  });
});
