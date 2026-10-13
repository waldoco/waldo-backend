import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, type EmailSendProposal } from '../src/channels/approvals';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

// Synthetic mail only. Asking for the same email again on a later turn is the owner's call: the desk raises a new
// card, and when an identical earlier send's outcome is still unknown, the card says so.
const SENT_AT = Date.UTC(2026, 9, 13, 1, 0);
const email = async (subject: string, turn: string, messageId: string, body = 'QA'): Promise<EmailSendProposal> => {
  const raw = `${subject} ${body} bytes for ${turn}`;
  return { to: ['owner@example.test'], subject, body, raw, digest: await sha256Hex(raw), message_id: messageId, dedupe_key: turn };
};

const repeat = async (name: string, second: (first: EmailSendProposal) => Promise<EmailSendProposal>, firstOutcome: 'unknown' | 'sent') => {
  const cards: string[] = [];
  let now = SENT_AT, next = 0;
  let firstId = '', secondId = '';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const client: Partial<GoogleClient> = firstOutcome === 'unknown'
      ? { sendRaw: (async () => { throw new TypeError('network connection lost'); }) as GoogleClient['sendRaw'], findSentByMessageId: (async () => false) as GoogleClient['findSentByMessageId'] }
      : { sendRaw: (async () => ({ message_id: 'g1', thread_id: 't1' })) as GoogleClient['sendRaw'],
        findSentByMessageId: (async () => ({ message_id: 'g1', thread_id: 't1', rfc822_message_id: '<first@waldo-send>', label_ids: ['SENT'] })) as GoogleClient['findSentByMessageId'] };
    const desk = approvalDesk(state.storage.sql, {
      owner: 42, call: async (method, body) => { if (method === 'sendMessage') cards.push((body as { text: string }).text); return {}; },
      google: async () => client as GoogleClient, newId: () => String(++next), now: () => now, timezone: 'Asia/Kolkata', log: () => undefined, wait: async () => undefined,
    });
    const first = await email('QA', 'turn-1', '<first@waldo-send>');
    firstId = await desk.proposeSendEmail(first);
    const decided = await desk.decide(firstId, 'a', 'test');
    expect(decided.toast).toBe(firstOutcome === 'unknown' ? 'Outcome unknown' : 'Sent');
    now += 10 * 60_000;
    cards.length = 0;
    secondId = await desk.proposeSendEmail(await second(first));
  });
  return { firstId, secondId, card: cards[0] ?? '' };
};

describe('a later turn asking for an email again', () => {
  it('raises a new card that says an identical earlier send may already have gone out', async () => {
    const { firstId, secondId, card } = await repeat('send-repeat-identical', first => email(first.subject, 'turn-2', '<second@waldo-send>'), 'unknown');
    expect(secondId).not.toBe(firstId);
    expect(card).toBe("Send this email? An identical email from Tue 13 Oct, 06:30 may already have gone out; check Gmail's Sent folder before sending it again.\nTo: owner@example.test\nSubject: QA\n\nQA");
  });

  it.each([
    ['another subject', () => email('QA again', 'turn-2', '<second@waldo-send>'), 'Send this email? To: owner@example.test\nSubject: QA again\n\nQA'],
    ['the same subject and another body', () => email('QA', 'turn-2', '<second@waldo-send>', 'QA, take two'), 'Send this email? To: owner@example.test\nSubject: QA\n\nQA, take two'],
  ])('raises a plain card for a different email, whatever an earlier send left unknown: %s', async (_shape, second, shown) => {
    const { secondId, firstId, card } = await repeat(`send-repeat-different-${shown.length}`, second, 'unknown');
    expect(secondId).not.toBe(firstId);
    expect(card).toBe(shown);
  });

  it('raises a plain card when the identical earlier send is confirmed, not unknown', async () => {
    const { secondId, firstId, card } = await repeat('send-repeat-confirmed', first => email(first.subject, 'turn-2', '<second@waldo-send>'), 'sent');
    expect(secondId).not.toBe(firstId);
    expect(card).toBe('Send this email? To: owner@example.test\nSubject: QA\n\nQA');
  });
});
