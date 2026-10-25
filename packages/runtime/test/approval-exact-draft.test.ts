import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appApprovalDecisionResultV1Schema, appApprovalListV1Schema, type AppApprovalV1 } from '../../contracts/src/app/approvals';
import { appApprovalsRequest } from '../src/channels/app-approvals';
import { approvalDesk, type MessageSendProposal } from '../src/channels/approvals';
import { appApprovalLink } from '../src/channels/surfaces/app';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';
import type { TurnLogEntry } from '../src/channels/telegram-listener';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import { emailProposal, sentMime } from './fixtures/email-send';

const CSRF = 'c'.repeat(64);
const BODY = 'Hi Sam,\n\nThe deck is ready — see slide 3 (and the 2× chart).\r\nThanks,\nRo';

// A Telegram desk whose cards also show in the app, with a Gmail and a messaging fake that record what goes out.
const harness = (state: DurableObjectState) => {
  let n = 0, card = 0;
  const sent: string[] = [], messages: MessageSendProposal[] = [], logs: TurnLogEntry[] = [];
  const client = {
    account: { connection_id: 'local:owner@example.com', email: 'owner@example.com' },
    sendRaw: async (raw: string) => { sent.push(raw); return { message_id: `g${sent.length}`, thread_id: 't1' }; },
    findSentByMessageId: async (id: string) => sent.length ? { message_id: `g${sent.length}`, thread_id: 't1', rfc822_message_id: id, label_ids: ['SENT'] } : false,
    threadPage: async () => ({ messages: [{ id: 'parent-1', message_id: '<parent@example.com>', references: ['<root@example.com>'], subject: 'Friday deck' }] }),
  } as unknown as GoogleClient;
  const desk = approvalDesk(state.storage.sql, {
    surface: 'telegram', owner: 42, appIdentity: () => true, appLink: appApprovalLink,
    call: async (method: string, body: object) => method === 'sendMessage' ? { message_id: ++card, chat: { id: 42 }, body } : true,
    google: async () => client, newId: () => `draft${++n}`, now: () => Date.now(), timezone: 'UTC', log: entry => { logs.push(entry); },
    canSendMessage: () => true, sendMessage: async (proposal: MessageSendProposal) => { messages.push(proposal); return { provider_id: `m${messages.length}` }; },
  });
  const host = { csrf: CSRF, expires: Date.now() + 3_600_000, signedInAt: new Date().toISOString(), storage: state.storage, assertCurrent: async () => {}, sessions: async () => [{ csrf: CSRF, expires: Date.now() + 3_600_000 }], desk };
  const list = async (header?: string) => (await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals', { headers: header === undefined ? {} : { 'x-waldo-app-contract': header } }), host)).text();
  const approvals = async (header = 'approvals=3') => appApprovalListV1Schema.parse(JSON.parse(await list(header))).approvals;
  const decide = async (body: Readonly<{ approval_id: string; action: string; expected_digest: string; request_id: string }>) => {
    const response = await appApprovalsRequest(new Request('https://telegram-owner/app/v1/approvals/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), host);
    return { status: response.status, text: await response.text() };
  };
  // The send_email tool itself drafts the email, so the bytes it freezes are the ones under test.
  const access: GoogleAccess = { client: async () => client };
  const sendEmail = googleHandlers(access, desk, { timezone: 'UTC', now: () => new Date() }).find(tool => tool.name === 'send_email')!;
  const draftEmail = async (args: Readonly<Record<string, unknown>>) => {
    const result = await sendEmail.handle({ to: ['sam@example.com'], cc: ['pat@example.org'], subject: 'Friday deck', body_markdown: BODY, ...args } as never) as { ok: boolean; data: { proposal_id: string } };
    expect(result.ok).toBe(true);
    return result.data.proposal_id;
  };
  const row = (id: string) => state.storage.sql.exec<{ status: string; payload_json: string }>('SELECT status, payload_json FROM ledger WHERE id = ?', id).one();
  return { desk, sent, messages, logs, list, approvals, decide, draftEmail, row };
};

it('a send approval carries its frozen subject and body only to a build that declares approvals revision 3', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`exact-draft-revision-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { desk, list, approvals, draftEmail } = harness(state);
    const email = await draftEmail({});
    const message = await desk.proposeSendMessage({ channel: 'telegram', content: 'Running ten minutes late.', idempotency_key: 'exact-message-0001' });
    const earlier = await list('approvals=2');
    expect(earlier).not.toContain('"message"');
    for (const header of [undefined, 'approvals=1']) expect([header, await list(header)]).toEqual([header, earlier]);
    const before = appApprovalListV1Schema.parse(JSON.parse(earlier)).approvals, now = await approvals();
    expect(now.find(item => item.approval_id === email)!.exact.message).toEqual({ subject: 'Friday deck', body: BODY });
    expect(now.find(item => item.approval_id === message)!.exact.message).toEqual({ subject: null, body: 'Running ten minutes late.' });
    // Revision 3 adds the draft and nothing else.
    const withoutDraft = ({ exact: { message: _message, ...exact }, ...item }: AppApprovalV1) => ({ ...item, exact });
    expect(now.map(withoutDraft)).toEqual(before);
  });
});

it('the body the card shows is byte for byte the body Gmail is handed', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`exact-draft-bytes-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { sent, approvals, decide, draftEmail } = harness(state);
    const id = await draftEmail({});
    const [shown] = await approvals();
    expect(shown).toMatchObject({ approval_id: id, state: 'open' });
    const approved = await decide({ approval_id: id, action: 'approve', expected_digest: shown!.payload_digest, request_id: 'exact-bytes-0001' });
    expect(appApprovalDecisionResultV1Schema.parse(JSON.parse(approved.text))).toMatchObject({ receipt: { state: 'recorded' }, approval_state: 'done' });
    expect(sent).toHaveLength(1);
    const wire = sentMime(sent[0]!);
    expect(await sha256Hex(wire.body)).toBe(await sha256Hex(shown!.exact.message!.body));
    expect(wire.headers).toContain(`Subject: ${shown!.exact.message!.subject}`);
    expect(wire.headers).toContain(`To: ${shown!.exact.recipients!.to.join(', ')}`);
    expect(wire.headers).toContain(`Cc: ${shown!.exact.recipients!.cc.join(', ')}`);
  });
});

it('a draft whose stored words changed after its card was shown is refused before anything goes out', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`exact-draft-tamper-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { desk, sent, messages, approvals, decide, draftEmail, row } = harness(state);
    // The replacement is a well-formed draft: its bytes match its words and its digest, so only the card's digest can tell.
    const swap = async (id: string) => {
      const stored = JSON.parse(row(id).payload_json) as Parameters<typeof emailProposal>[0];
      state.storage.sql.exec('UPDATE ledger SET payload_json = ? WHERE id = ?', JSON.stringify(await emailProposal({ ...stored, body: 'Wire the deposit to the new account today.' })), id);
    };
    const inChat = await draftEmail({});
    await swap(inChat);
    expect(await desk.decide(inChat, 'a', 'trace')).toMatchObject({ toast: 'Email changed' });
    expect(row(inChat).status).toBe('failed');

    const inApp = await draftEmail({ subject: 'Friday deck, take two' });
    await swap(inApp);
    const current = (await approvals()).find(item => item.approval_id === inApp)!;
    expect(current.exact.message!.body).toBe('Wire the deposit to the new account today.');
    const refused = await decide({ approval_id: inApp, action: 'approve', expected_digest: current.payload_digest, request_id: 'exact-tamper-0001' });
    expect([refused.status, JSON.parse(refused.text).receipt.state]).toEqual([409, 'rejected']);
    expect(row(inApp).status).toBe('failed');

    const message = await desk.proposeSendMessage({ channel: 'telegram', content: 'Running late.', idempotency_key: 'exact-tamper-message' });
    state.storage.sql.exec("UPDATE ledger SET payload_json = json_set(payload_json, '$.content', 'Send me your login code.') WHERE id = ?", message);
    expect(await desk.decide(message, 'a', 'trace')).toMatchObject({ toast: 'Message changed' });
    expect(row(message).status).toBe('failed');
    expect([sent, messages]).toEqual([[], []]);
  });
});

it('an email whose frozen bytes say other words than its card is refused, even with a matching digest', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`exact-draft-bytes-differ-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { desk, sent, approvals, decide, row } = harness(state);
    const draft = { to: ['sam@example.com'], subject: 'Friday deck', body: 'See you Friday.', message_id: '<differ@waldo-send>' };
    const id = await desk.proposeSendEmail(await emailProposal(draft, { body: 'Wire the deposit today.' }));
    const [shown] = await approvals();
    // The card showed what is stored now, so the card's digest holds; only the bytes check refuses.
    const presented = state.storage.sql.exec<{ payload_digest: string }>('SELECT payload_digest FROM approval_presentations WHERE approval_id = ?', id).toArray();
    expect(presented.map(p => p.payload_digest)).toEqual([shown!.payload_digest, shown!.payload_digest]);
    const refused = await decide({ approval_id: id, action: 'approve', expected_digest: shown!.payload_digest, request_id: 'exact-differ-0001' });
    expect([refused.status, JSON.parse(refused.text).receipt.state]).toEqual([409, 'rejected']);
    expect(row(id).status).toBe('failed');
    // Gmail is sent the subject on one line, so a subject that breaks it is not what the card would show: the app
    // gets no draft to approve against, and the send is refused wherever it is approved.
    const headerBreak = await desk.proposeSendEmail(await emailProposal({ ...draft, subject: 'Friday deck\nBcc: x@example.com', message_id: '<header@waldo-send>' }));
    expect((await approvals()).find(item => item.approval_id === headerBreak)!.exact.message).toBeUndefined();
    expect(await desk.decide(headerBreak, 'a', 'trace')).toMatchObject({ toast: 'Email changed' });
    expect(sent).toEqual([]);
  });
});

it('a reply with a blind copy goes out with the threading and Bcc the card showed, and a hidden Bcc is refused', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`exact-draft-reply-bcc-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { desk, sent, approvals, decide, draftEmail, row } = harness(state);
    const id = await draftEmail({ subject: 'Re: Friday deck', bcc: ['quiet@example.net'], reply_to_thread_id: 't1', in_reply_to_msg_id: 'parent-1' });
    const shown = (await approvals()).find(item => item.approval_id === id)!;
    expect(shown.exact.recipients!.bcc).toEqual(['quiet@example.net']);
    const approved = await decide({ approval_id: id, action: 'approve', expected_digest: shown.payload_digest, request_id: 'exact-reply-0001' });
    expect(JSON.parse(approved.text)).toMatchObject({ receipt: { state: 'recorded' }, approval_state: 'done' });
    expect(sent).toHaveLength(1);
    const wire = sentMime(sent[0]!);
    expect(wire.headers).toEqual(expect.arrayContaining(['Subject: Re: Friday deck', 'Bcc: quiet@example.net', 'In-Reply-To: <parent@example.com>', expect.stringMatching(/^References: <root@example\.com>\s+<parent@example\.com>$/)]));
    expect(wire.body).toBe(shown.exact.message!.body);

    // Bytes that carry a Bcc the stored fields, and so the card, leave out.
    const reply = JSON.parse(row(id).payload_json) as Parameters<typeof emailProposal>[0];
    const { bcc: _bcc, ...unshown } = await emailProposal({ ...reply, message_id: '<hidden-bcc@waldo-send>' });
    const hidden = await desk.proposeSendEmail(unshown);
    expect((await approvals()).find(item => item.approval_id === hidden)!.exact.recipients!.bcc).toEqual([]);
    expect(await desk.decide(hidden, 'a', 'trace')).toMatchObject({ toast: 'Email changed' });
    expect(sent).toHaveLength(1);
  });
});

it('Change it leaves the reviewed draft as it was; the new draft is a new approval with its own digest', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`exact-draft-edit-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { sent, approvals, decide, draftEmail, row } = harness(state);
    const first = await draftEmail({});
    const [reviewed] = await approvals();
    const stored = row(first).payload_json;
    const edit = await decide({ approval_id: first, action: 'edit', expected_digest: reviewed!.payload_digest, request_id: 'exact-edit-0001' });
    expect(JSON.parse(edit.text)).toMatchObject({ receipt: { state: 'recorded' }, approval_state: 'edit_requested' });
    expect(row(first)).toEqual({ status: 'changing', payload_json: stored });
    const late = await decide({ approval_id: first, action: 'approve', expected_digest: reviewed!.payload_digest, request_id: 'exact-edit-0002' });
    expect([late.status, JSON.parse(late.text).error]).toEqual([409, 'no_longer_eligible']);

    const second = await draftEmail({ body_markdown: 'Hi Sam,\n\nThe deck is ready. Slide 3 changed.\n\nRo' });
    const fresh = (await approvals()).find(item => item.approval_id === second)!;
    expect(second).not.toBe(first);
    expect(fresh.payload_digest).not.toBe(reviewed!.payload_digest);
    const stale = await decide({ approval_id: second, action: 'approve', expected_digest: reviewed!.payload_digest, request_id: 'exact-edit-0003' });
    expect([stale.status, JSON.parse(stale.text).approval_state]).toEqual([409, 'superseded']);
    expect(sent).toEqual([]);
    const approved = await decide({ approval_id: second, action: 'approve', expected_digest: fresh.payload_digest, request_id: 'exact-edit-0004' });
    expect(JSON.parse(approved.text)).toMatchObject({ approval_state: 'done' });
    expect(sentMime(sent[0]!).body).toBe('Hi Sam,\n\nThe deck is ready. Slide 3 changed.\n\nRo');
    expect(row(first).payload_json).toBe(stored);
  });
});

it('the draft never reaches the desk log or a receipt, whether it is sent or refused', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`exact-draft-privacy-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { desk, logs, approvals, decide, draftEmail } = harness(state);
    const secret = 'PRIVATE-DRAFT-WORDS', subject = 'PRIVATE-SUBJECT';
    const sentId = await draftEmail({ subject, body_markdown: `${secret} one` });
    const refusedId = await desk.proposeSendEmail(await emailProposal({ to: ['sam@example.com'], subject, body: `${secret} two`, message_id: '<privacy@waldo-send>' }, { body: `${secret} three` }));
    const listed = await approvals();
    const receipts = [];
    for (const [index, id] of [sentId, refusedId].entries()) {
      receipts.push((await decide({ approval_id: id, action: 'approve', expected_digest: listed.find(item => item.approval_id === id)!.payload_digest, request_id: `exact-privacy-000${index}` })).text);
    }
    expect(JSON.parse(receipts[0]!)).toMatchObject({ approval_state: 'done' });
    expect(JSON.parse(receipts[1]!)).toMatchObject({ approval_state: 'not_done' });
    expect(JSON.stringify([logs, receipts])).not.toMatch(/PRIVATE-DRAFT-WORDS|PRIVATE-SUBJECT/);
  });
});
