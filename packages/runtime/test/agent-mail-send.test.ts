// Sending as Waldo: the flag and binding gate, the error codes, the frozen card and the one send its approval makes. The
// binding is a fake; nothing here reaches Cloudflare. Every address and word is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { agentMailDisplayName, agentMailFirstName } from '../src/channels/agent-mail/handles';
import { agentMailInbox } from '../src/channels/agent-mail/inbox';
import { renderAgentMail, type AgentMailParts } from '../src/channels/agent-mail/render';
import {
  AGENT_MAIL_SEND_CODES, agentMailIntact, agentMailRefusal, agentMailSendCode, agentMailSending, type AgentMailSenderBinding, type AgentMailSendProposal,
} from '../src/channels/agent-mail/send';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { STEP_UP_APPROVALS } from '../src/channels/approval-step-up';
import { approvalDesk, EmailProposalError } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { sha256Hex } from '../src/connectors/google';
import type { TurnLogEntry } from '../src/channels/telegram-listener';
import { agentMailProposal } from './fixtures/agent-mail-send';

const binding: AgentMailSenderBinding = { send: async () => ({ messageId: '<x@mail.example.test>' }) };
const ON = { AGENT_MAIL_INBOUND: '1', AGENT_MAIL_SEND: '1', AGENT_MAIL_DOMAIN: 'Mail.Example.Test', AGENT_MAIL_SENDER: binding };
const CANARY = 'canary-7f3e9b1d';
const CSRF = 'c'.repeat(64);

describe('agentMailSending', () => {
  it('is on only with agent mail on, sending on, a domain and the binding, and lower-cases the domain', () => {
    expect(agentMailSending(ON)).toEqual({ domain: 'mail.example.test', sender: binding });
    for (const off of [{ AGENT_MAIL_INBOUND: '0' }, { AGENT_MAIL_SEND: '0' }, { AGENT_MAIL_SEND: undefined }, { AGENT_MAIL_DOMAIN: '' }, { AGENT_MAIL_DOMAIN: undefined }, { AGENT_MAIL_SENDER: undefined }])
      expect([off, agentMailSending({ ...ON, ...off })]).toEqual([off, null]);
  });
});

describe('the service error codes', () => {
  it('reads the fixed code alone, never the message', () => {
    const error = { code: 'E_RECIPIENT_SUPPRESSED', get message(): string { throw new Error('the message was read'); } };
    expect(agentMailSendCode(error)).toBe('E_RECIPIENT_SUPPRESSED');
    for (const other of [new Error(`E_RATE_LIMIT_EXCEEDED ${CANARY}`), { code: 'E_SOMETHING_NEW' }, { code: 42 }, null, 'E_DAILY_LIMIT_EXCEEDED', new TypeError('network connection lost')])
      expect(agentMailSendCode(other)).toBe('other');
  });

  it('treats every listed code but the internal error as nothing sent, and the internal error, an unknown code or none as maybe sent', () => {
    expect(agentMailRefusal('E_INTERNAL_SERVER_ERROR')).toBeNull();
    expect(agentMailRefusal('other')).toBeNull();
    for (const code of AGENT_MAIL_SEND_CODES.filter(code => code !== 'E_INTERNAL_SERVER_ERROR')) expect([code, agentMailRefusal(code)]).not.toEqual([code, null]);
    expect([agentMailRefusal('E_SENDER_NOT_VERIFIED'), agentMailRefusal('E_RECIPIENT_SUPPRESSED'), agentMailRefusal('E_DAILY_LIMIT_EXCEEDED'), agentMailRefusal('E_HEADERS_TOO_MANY'), agentMailRefusal('E_DELIVERY_FAILED')])
      .toEqual(['sender', 'recipient', 'limit', 'content', 'delivery']);
  });
});

describe('the frozen draft', () => {
  it('renders the same parts whatever Message-ID and date the wire carries; only the threading headers change them', () => {
    const draft = { subject: 'Friday', body_markdown: 'See you at **4**.' }, sender = { address: 'sam@mail.example.test', ownerFirstName: 'Sam' }, to = { to: ['lee@example.test'] };
    const a = renderAgentMail(draft, sender, to, { messageId: '<one@mail.example.test>', date: 0 });
    const b = renderAgentMail(draft, sender, to, { messageId: '<two@elsewhere.test>', date: Date.UTC(2026, 9, 31) });
    const reply = renderAgentMail(draft, sender, to, { messageId: '<one@mail.example.test>', date: 0, inReplyTo: '<m1@example.test>', references: ['<m1@example.test>'] });
    if (!a.ok || !b.ok || !reply.ok) throw new Error('render failed');
    expect(b.parts).toEqual(a.parts);
    expect(a.mime).not.toBe(b.mime);
    expect(reply.parts.headers).toEqual({ 'In-Reply-To': '<m1@example.test>', References: '<m1@example.test>' });
  });

  it('signs with the same name the owner sees on their Waldo address', async () => {
    const p = await agentMailProposal({ owner_first_name: agentMailFirstName('Sam "Q" Fulper') });
    expect(p.from.name).toBe(agentMailDisplayName('Sam "Q" Fulper'));
    expect(p.from.name).toBe("Waldo, Sam's assistant");
    expect((await agentMailProposal({ owner_first_name: agentMailFirstName('  ') })).from.name).toBe('Waldo');
  });

  it('is intact only while it renders to the words, sender, subject and parts the card froze', async () => {
    const p = await agentMailProposal();
    const parts = await agentMailIntact(p, 'mail.example.test');
    expect(parts?.from).toEqual({ email: 'sam@mail.example.test', name: "Waldo, Sam's assistant" });
    for (const changed of [{ body: `${p.body} ` }, { body_markdown: 'See you at 5.' }, { parts_digest: `sha256:${'0'.repeat(64)}` }, { subject: 'Friday\r\nBcc: x@example.test' },
      { subject: 'Saturday' }, { from: { ...p.from, name: 'Waldo' } }, { from: { ...p.from, address: 'lee@mail.example.test' } }, { to: ['other@example.test'] }, { owner_first_name: 'Lee' }] as Partial<AgentMailSendProposal>[])
      expect([changed, await agentMailIntact({ ...p, ...changed })]).toEqual([changed, null]);
    expect(await agentMailIntact(p, 'other.example.test')).toBeNull();
    expect(await agentMailIntact({ ...p, handle: 'lee' }, 'mail.example.test')).toBeNull();
  });
});

type Fake = { attempts: AgentMailParts[]; answer: (parts: AgentMailParts) => Promise<{ messageId: string }> };
const harness = (state: DurableObjectState, options: Readonly<{ sender?: boolean; logs?: TurnLogEntry[] }> = {}) => {
  let n = 0;
  const fake: Fake = { attempts: [], answer: async () => ({ messageId: '<sent-1@mail.example.test>' }) };
  const inbox = agentMailInbox(state.storage);
  const desk = approvalDesk(state.storage.sql, {
    surface: 'app', owner: 7_000_000_000_001, call: appCaller(), appLink: appApprovalLink, google: async () => null, newId: () => `am${++n}`, now: () => Date.now(), timezone: 'UTC',
    log: entry => options.logs?.push(entry), commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => Date.now()),
    ...(options.sender === false ? {} : { agentMail: {
      intact: p => agentMailIntact(p, 'mail.example.test'),
      send: async parts => { fake.attempts.push(parts); return fake.answer(parts); },
      sent: (messageId, p) => inbox.recordOutbound(messageId, p.in_reply_to),
    } }),
  });
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const approve = (id: string) => desk.decide(id, 'a', 'trace', { surface: 'app' });
  const threads = () => state.storage.sql.exec<{ message_id: string; direction: string; thread: string }>('SELECT message_id, direction, thread FROM agent_mail_threads ORDER BY at, rowid').toArray().map(row => ({ ...row }));
  return { desk, fake, inbox, status, approve, threads };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));
// Changes the stored card and the digest its app presentation recorded together, so the change reaches the send check.
const rewrite = async (state: DurableObjectState, id: string, p: AgentMailSendProposal) => {
  const json = JSON.stringify(p);
  state.storage.sql.exec('UPDATE ledger SET payload_json = ? WHERE id = ?', json, id);
  state.storage.sql.exec('UPDATE approval_presentations SET payload_digest = ? WHERE approval_id = ?', `sha256:${await sha256Hex(json)}`, id);
};

describe('a send as Waldo on the approval desk', () => {
  it('shows the sender, recipients, subject and words, and sends the re-rendered parts once on approval', async () => {
    await owner('agent-mail-send-approve', async state => {
      const f = harness(state);
      const p = await agentMailProposal({ cc: ['kim@example.test'] });
      const id = await f.desk.proposeAgentMailSend(p);
      expect(f.status(id)).toBe('open');
      const [item] = await f.desk.approvals(Date.now(), { id });
      expect(item!.review).toBe(`Send this email as Waldo? From: Waldo, Sam's assistant <sam@mail.example.test>\nTo: lee@example.test\nCc: kim@example.test\nSubject: Friday\n\n${p.body}`);
      expect(item!.exact).toEqual({ recipients: { to: ['lee@example.test'], cc: ['kim@example.test'], bcc: [] }, sender: { name: "Waldo, Sam's assistant", address: 'sam@mail.example.test' }, message: { subject: 'Friday', body: p.body } });
      expect(item!.actions).toEqual(['approve', 'edit', 'skip', 'defer']);
      expect(STEP_UP_APPROVALS.agent_mail_send.gated).toBe(true);
      expect(f.desk.stepUp(id, 'approve')).toBe(true);
      expect(f.fake.attempts).toEqual([]);

      const out = await f.approve(id);
      expect(out).toEqual({ toast: 'Sent', message: 'Sent: Send email as Waldo from sam@mail.example.test to lee@example.test: "Friday". This one can\'t be undone.' });
      expect(f.fake.attempts).toHaveLength(1);
      expect(f.fake.attempts[0]).toEqual(await agentMailIntact(p));
      expect(f.fake.attempts[0]!.from).toEqual({ email: 'sam@mail.example.test', name: "Waldo, Sam's assistant" });
      expect(f.fake.attempts[0]!.text).toBe(p.body);
      expect(f.status(id)).toBe('done');
      expect(f.threads()).toEqual([{ message_id: 'sent-1@mail.example.test', direction: 'out', thread: 'sent-1@mail.example.test' }]);

      expect((await f.approve(id)).toast).toBe('Already handled.');
      expect(await f.desk.decide(id, 'u', 'trace', { surface: 'app' })).toEqual({ toast: "Can't be undone", message: 'A sent email cannot be undone. Nothing was reversed.' });
      expect(f.fake.attempts).toHaveLength(1);
    });
  });

  it('sends nothing when the stored words or the digest of the parts no longer match the card', async () => {
    await owner('agent-mail-send-changed', async state => {
      const f = harness(state);
      for (const change of [(p: AgentMailSendProposal) => ({ ...p, body: p.body.replace('See you', 'Meet me') }), (p: AgentMailSendProposal) => ({ ...p, parts_digest: `sha256:${'0'.repeat(64)}` })]) {
        const p = await agentMailProposal();
        const id = await f.desk.proposeAgentMailSend(p);
        await rewrite(state, id, change(p));
        const out = await f.approve(id);
        expect(out.toast).toBe('Email changed');
        expect(out.message).toContain('so nothing was sent');
        expect(f.status(id)).toBe('failed');
        expect((await f.approve(id)).toast).toBe('Already handled.');
      }
      expect(f.fake.attempts).toEqual([]);
    });
  });

  it('a refusal ends not sent and an approval again sends nothing', async () => {
    await owner('agent-mail-send-refused', async state => {
      const f = harness(state);
      f.fake.answer = async () => { throw Object.assign(new Error(`suppressed ${CANARY}`), { code: 'E_RECIPIENT_SUPPRESSED' }); };
      const p = await agentMailProposal();
      const id = await f.desk.proposeAgentMailSend(p);
      expect(await f.approve(id)).toEqual({ toast: 'Not sent', message: 'Not sent: the mail service will not send to one of those addresses, so nothing went out: Send email as Waldo from sam@mail.example.test to lee@example.test: "Friday".' });
      expect(f.status(id)).toBe('failed');
      expect((await f.approve(id)).toast).toBe('Already handled.');
      expect(f.fake.attempts).toHaveLength(1);
      expect(f.threads()).toEqual([]);
    });
  });

  for (const [name, failure] of [
    ['a thrown error without a code', () => new Error(`timed out ${CANARY}`)],
    ['the internal error code', () => Object.assign(new Error(CANARY), { code: 'E_INTERNAL_SERVER_ERROR' })],
    ['an answer without an id', null],
  ] as const) {
    it(`${name} leaves the outcome unknown, and an approval again never sends it again`, async () => {
      await owner('agent-mail-send-unknown', async state => {
        const f = harness(state);
        f.fake.answer = async () => { if (failure) throw failure(); return { messageId: '' }; };
        const id = await f.desk.proposeAgentMailSend(await agentMailProposal());
        const out = await f.approve(id);
        expect(out.toast).toBe('Outcome unknown');
        expect(out.message).toContain('nothing was sent again');
        expect(f.status(id)).toBe('uncertain');
        f.fake.answer = async () => ({ messageId: '<late@mail.example.test>' });
        expect((await f.approve(id)).toast).toBe('Outcome unknown');
        expect(f.fake.attempts).toHaveLength(1);
        expect(f.status(id)).toBe('uncertain');
      });
    });
  }

  it('logs the fixed code only: never the error message, an address, the subject, the words or the provider id', async () => {
    await owner('agent-mail-send-logs', async state => {
      const logs: TurnLogEntry[] = [];
      const f = harness(state, { logs });
      const body = `Use the code ${CANARY}-body.`;
      f.fake.answer = async () => { throw Object.assign(new Error(`refused for lee@example.test ${CANARY}`), { code: 'E_DAILY_LIMIT_EXCEEDED' }); };
      const refused = await f.desk.proposeAgentMailSend(await agentMailProposal({ body_markdown: body, subject: `Codes ${CANARY}` }));
      expect((await f.approve(refused)).toast).toBe('Not sent');
      f.fake.answer = async () => { throw new Error(`socket closed ${CANARY}`); };
      expect((await f.approve(await f.desk.proposeAgentMailSend(await agentMailProposal({ body_markdown: body })))).toast).toBe('Outcome unknown');
      f.fake.answer = async () => ({ messageId: `<${CANARY}-id@mail.example.test>` });
      expect((await f.approve(await f.desk.proposeAgentMailSend(await agentMailProposal({ body_markdown: body })))).toast).toBe('Sent');
      const sendLogs = logs.filter(entry => entry.hop === 'agent_mail_send');
      expect(sendLogs.map(entry => [entry.ok, entry.code])).toEqual([[false, 'E_DAILY_LIMIT_EXCEEDED'], [false, 'other'], [true, 'sent']]);
      const logged = JSON.stringify(logs);
      for (const secret of [CANARY, 'lee@example.test', 'sam@mail.example.test', 'Codes', 'Use the code']) expect([secret, logged.includes(secret)]).toEqual([secret, false]);
    });
  });

  it('answers that sending is not set up, and sends nothing, without the sender', async () => {
    await owner('agent-mail-send-off', async state => {
      const f = harness(state, { sender: false });
      const id = await f.desk.proposeAgentMailSend(await agentMailProposal());
      expect(await f.approve(id)).toEqual({ toast: 'Not set up', message: 'Sending as Waldo is not set up on this Waldo yet, so nothing was sent.' });
      expect(f.status(id)).toBe('open');
    });
  });

  it('reuses the card for the same send key and content, and refuses the key with other content or a draft that does not render as stored', async () => {
    await owner('agent-mail-send-dedupe', async state => {
      const f = harness(state);
      const p = await agentMailProposal({ idempotency_key: 'turn-key' });
      const id = await f.desk.proposeAgentMailSend(p);
      expect(await f.desk.proposeAgentMailSend({ ...p, operation_ref: 'tool:another-call' })).toBe(id);
      await expect(f.desk.proposeAgentMailSend(await agentMailProposal({ idempotency_key: 'turn-key', subject: 'Saturday' }))).rejects.toEqual(new EmailProposalError('identifier_reused'));
      await expect(f.desk.proposeAgentMailSend({ ...await agentMailProposal(), body: 'Not what renders.' })).rejects.toThrow('does not render as stored');
      await f.approve(id);
      await expect(f.desk.proposeAgentMailSend(p)).rejects.toEqual(new EmailProposalError('already_handled'));
      expect(f.fake.attempts).toHaveLength(1);
    });
  });
});

describe('the app approvals list', () => {
  it('shows a send as Waldo, with its sender, only to a build that reads approvals revision 6', async () => {
    await owner('agent-mail-send-app-list', async state => {
      const f = harness(state);
      const mail = await f.desk.proposeAgentMailSend(await agentMailProposal());
      const calendar = await f.desk.propose({ action: 'create', title: 'Walk', start: new Date(Date.now() + 3_600_000).toISOString() as never, end: new Date(Date.now() + 5_400_000).toISOString() as never, reason: 'afternoon slot' });
      const host = { csrf: CSRF, expires: Date.now() + 3_600_000, signedInAt: new Date().toISOString(), storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk: f.desk };
      const list = async (contract?: string) => appApprovalListV1Schema.parse(await (await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals', contract === undefined ? {} : { headers: { 'x-waldo-app-contract': contract } }), host)).json()).approvals;
      for (const contract of [undefined, 'approvals=1', 'approvals=4', 'approvals=5', 'chat=6'])
        expect([contract, (await list(contract)).map(item => item.approval_id)]).toEqual([contract, [calendar]]);
      const latest = await list('approvals=6');
      expect(latest.map(item => item.approval_id)).toEqual([calendar, mail]);
      expect(latest.find(item => item.approval_id === mail)!.exact.sender).toEqual({ name: "Waldo, Sam's assistant", address: 'sam@mail.example.test' });
    });
  });
});

describe('the mail threads', () => {
  it('a reply joins the thread it answers, and its References run from the root to the mail replied to', async () => {
    await owner('agent-mail-send-threads', async state => {
      const inbox = agentMailInbox(state.storage);
      const delivery = (messageId: string, inReplyTo: string[] = [], references: string[] = []) =>
        ({ handle: 'sam', messageId, inReplyTo, references, from: ['owner@example.test'], ownerEmail: 'owner@example.test', raw: new TextEncoder().encode(messageId) });
      expect(await inbox.admit(delivery('m1@example.test'))).toBe('admitted');
      expect(await inbox.admit(delivery('m2@example.test', ['m1@example.test'], ['m1@example.test']))).toBe('admitted');
      expect(await inbox.admit(delivery('m3@example.test', ['m2@example.test'], ['m1@example.test', 'm2@example.test']))).toBe('admitted');
      expect(inbox.replyReferences('<m2@example.test>')).toEqual(['<m1@example.test>', '<m2@example.test>']);
      expect(inbox.replyReferences('<unknown@example.test>')).toBeNull();
      inbox.recordOutbound('<w1@mail.example.test>', '<m3@example.test>');
      inbox.recordOutbound('w2@mail.example.test');
      expect(inbox.replyReferences('<w1@mail.example.test>')).toEqual(['<m1@example.test>', '<m2@example.test>', '<m3@example.test>', '<w1@mail.example.test>']);
      expect(inbox.replyReferences('w2@mail.example.test')).toEqual(['<w2@mail.example.test>']);
      // A reply to Waldo's own mail is now in a thread Waldo knows, so it is read.
      expect(await inbox.admit({ ...delivery('r1@example.test', ['w2@mail.example.test']), from: ['stranger@example.test'] })).toBe('admitted');
    });
  });
});
