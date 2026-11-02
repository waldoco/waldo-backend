// Every email Waldo writes from the owner's Gmail ends with Waldo's signature: its name linked to its site, whose
// personal assistant it is, and its mark inline. The signature is part of the frozen bytes, so the card the owner
// approves and the digest that binds it cover it. Parsed back with the MIME parser agent mail reads inbound mail with.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { WALDO_MARK_PNG_BASE64 } from '../src/channels/agent-mail/mark';
import { agentMailFirstName } from '../src/channels/agent-mail/handles';
import { WALDO_SITE, ownerMailText, renderOwnerMail } from '../src/channels/agent-mail/render';
import { approvalDesk } from '../src/channels/approvals';
import type { GoogleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';
import { sentMime } from './fixtures/email-send';

const DRAFT = { subject: 'Waldo update for Varun', body_markdown: 'Hi Varun and JJ,\n\nShivansh would like to share an update on **Waldo**.\n\nThanks,' };
const TO = { to: ['varun@example.test'], cc: ['jj@example.test'] };
const WIRE = { messageId: '<sig-1@waldo-send>' };
const ok = (result: ReturnType<typeof renderOwnerMail>) => {
  if (!result.ok) throw new Error(`render refused: ${result.code}`);
  return result;
};
const headerNames = (mime: string) => mime.slice(0, mime.indexOf('\r\n\r\n')).split('\r\n').filter(line => !/^[ \t]/.test(line)).map(line => line.slice(0, line.indexOf(':')));

describe('renderOwnerMail', () => {
  it('is multipart/alternative: a plain-text part, then related HTML with the mark inline under the Content-ID the HTML names', async () => {
    const result = ok(renderOwnerMail(DRAFT, 'Shivansh', TO, WIRE));
    // Gmail sets From and Date from the account, so the bytes carry neither.
    expect(headerNames(result.mime)).toEqual(['To', 'Cc', 'Subject', 'Message-ID', 'MIME-Version', 'Content-Type']);
    const mail = await PostalMime.parse(result.mime, { attachmentEncoding: 'base64' });
    expect(mail.text?.replace(/\r\n/g, '\n')).toBe(result.text);
    expect(mail.attachments).toHaveLength(1);
    const [mark] = mail.attachments;
    expect(mark).toMatchObject({ mimeType: 'image/png', disposition: 'inline', content: WALDO_MARK_PNG_BASE64 });
    const cid = /<img src="cid:([^"]+)"/.exec(mail.html ?? '')?.[1];
    expect(mark!.contentId).toBe(`<${cid}>`);
    // The signature follows the model's words in both parts: Waldo linked to its site, then the assistant line.
    expect(mail.html).toMatch(new RegExp(`Thanks,</p>\\n<p [^>]*><a href="${WALDO_SITE.replace(/\./g, '\\.')}"[^>]*>Waldo</a><br><span [^>]*>Shivansh&#39;s personal assistant</span></p><img src="cid:`));
    expect(result.text).toBe(`Hi Varun and JJ,\n\nShivansh would like to share an update on Waldo.\n\nThanks,\n\nWaldo\nShivansh's personal assistant\n${WALDO_SITE}`);
    expect(ownerMailText(DRAFT.body_markdown, 'Shivansh')).toBe(result.text);
  });

  it('threads a reply and carries Bcc for Gmail to deliver', async () => {
    const result = ok(renderOwnerMail(DRAFT, 'Shivansh', { ...TO, bcc: ['quiet@example.test'] }, { ...WIRE, inReplyTo: '<parent@example.test>', references: ['<root@example.test>', '<parent@example.test>'] }));
    expect(headerNames(result.mime)).toEqual(['To', 'Cc', 'Bcc', 'Subject', 'Message-ID', 'In-Reply-To', 'References', 'MIME-Version', 'Content-Type']);
    const mail = await PostalMime.parse(result.mime);
    expect([mail.inReplyTo, mail.references]).toEqual(['<parent@example.test>', '<root@example.test> <parent@example.test>']);
  });

  it('with no first name, signs as Waldo with no assistant line', async () => {
    const result = ok(renderOwnerMail(DRAFT, null, TO, WIRE));
    expect(result.text.endsWith(`Thanks,\n\nWaldo\n${WALDO_SITE}`)).toBe(true);
    const mail = await PostalMime.parse(result.mime);
    expect(mail.html).not.toContain('personal assistant');
    expect(mail.html).toContain('>Waldo</a></p><img src="cid:');
    // The same first name agent mail signs with.
    expect(agentMailFirstName(null)).toBeNull();
    expect(agentMailFirstName('  \r\n ')).toBeNull();
    expect(agentMailFirstName('Shivansh Fulper')).toBe('Shivansh');
  });

  it('renders a long table whole: an owner\'s mail is not refused for HTML Gmail would only clip', () => {
    const rows = Array.from({ length: 1600 }, (_, i) => `| ${i} | x |`).join('\n');
    const result = ok(renderOwnerMail({ ...DRAFT, body_markdown: `| a | b |\n| --- | --- |\n${rows}`.slice(0, 10_000) }, 'Shivansh', TO, WIRE));
    expect(result.text).toContain('\n800 | x\n');
  });

  it('is the same bytes for the same draft and signer, and different bytes for another signer', () => {
    expect(ok(renderOwnerMail(DRAFT, 'Shivansh', TO, WIRE)).mime).toBe(ok(renderOwnerMail(DRAFT, 'Shivansh', TO, WIRE)).mime);
    expect(ok(renderOwnerMail(DRAFT, 'Priya', TO, WIRE)).mime).not.toBe(ok(renderOwnerMail(DRAFT, 'Shivansh', TO, WIRE)).mime);
  });
});

describe('send_email signs what it freezes, and the card shows it', () => {
  const harness = (state: DurableObjectState, name: string | null) => {
    const cards: string[] = [], sent: string[] = [];
    let n = 0;
    const client = {
      account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
      sendRaw: async (raw: string) => { sent.push(raw); return { message_id: `g${sent.length}`, thread_id: 't1' }; },
      findSentByMessageId: async (id: string) => sent.length ? { message_id: `g${sent.length}`, thread_id: 't1', rfc822_message_id: id, label_ids: ['SENT'] } : false,
    } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, {
      owner: 42, google: async () => client, newId: () => `sig${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => undefined,
      call: async (method: string, body: object) => { if (method === 'sendMessage') cards.push((body as { text: string }).text); return method === 'sendMessage' ? { message_id: cards.length, chat: { id: 42 } } : true; },
    });
    const tool = googleHandlers({ client: async () => client }, desk, { timezone: 'UTC', now: () => new Date() }, undefined, undefined, () => name).find(handler => handler.name === 'send_email')!;
    const propose = async (args: Readonly<Record<string, unknown>> = {}) => {
      const result = await tool.handle({ ...TO, ...DRAFT, ...args } as never, { authenticatedUserId: 'owner', turnId: `turn-${crypto.randomUUID()}`, toolCallId: 'call-1' } as never) as { ok: boolean; data: { proposal_id: string } };
      expect(result.ok).toBe(true);
      return result.data.proposal_id;
    };
    const stored = (id: string) => JSON.parse(state.storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM ledger WHERE id = ?', id).one().payload_json) as { raw: string; signature?: { first_name: string | null } };
    return { desk, cards, sent, propose, stored };
  };
  const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
    runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));

  it('the card shows the signature lines, and what goes out is the card\'s text, signature included', async () => {
    await owner('sig-card', async state => {
      const f = harness(state, 'Shivansh Fulper');
      const id = await f.propose();
      expect(f.stored(id).signature).toEqual({ first_name: 'Shivansh' });
      expect(f.cards[0]).toContain(`Thanks,\n\nWaldo\nShivansh's personal assistant\n${WALDO_SITE}`);
      expect((await f.desk.decide(id, 'a', 'trace')).toast).toBe('Sent');
      expect(f.cards[0]).toContain(sentMime(f.sent[0]!).body);
    });
  });

  it('the card shows the subject as the bytes carry it, on one line', async () => {
    await owner('sig-subject', async state => {
      const f = harness(state, 'Shivansh');
      const id = await f.propose({ subject: ' Weekly  numbers\t' });
      expect(f.cards[0]).toContain('Subject: Weekly numbers\n');
      expect((await f.desk.decide(id, 'a', 'trace')).toast).toBe('Sent');
      expect(sentMime(f.sent[0]!).headers).toContain('Subject: Weekly numbers');
    });
  });

  it('a signature changed after the card was shown is refused before anything goes out', async () => {
    await owner('sig-tamper', async state => {
      const f = harness(state, 'Shivansh');
      const id = await f.propose();
      state.storage.sql.exec("UPDATE ledger SET payload_json = json_set(payload_json, '$.signature.first_name', 'Mallory') WHERE id = ?", id);
      expect(await f.desk.decide(id, 'a', 'trace')).toMatchObject({ toast: 'Email changed' });
      expect(f.sent).toEqual([]);
    });
  });

  it('with no first name for the owner, the card and the email sign as Waldo alone', async () => {
    await owner('sig-no-name', async state => {
      const f = harness(state, null);
      const id = await f.propose();
      expect(f.stored(id).signature).toEqual({ first_name: null });
      expect(f.cards[0]).toContain(`Thanks,\n\nWaldo\n${WALDO_SITE}`);
      expect(f.cards[0]).not.toContain('personal assistant');
    });
  });
});
