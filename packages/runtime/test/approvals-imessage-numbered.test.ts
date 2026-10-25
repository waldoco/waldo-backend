// iMessage approves by numbered reply. A card for a kind chat approves in one tap ends "Reply 1 to <verb>, or 2 to skip.",
// and the owner's next message "1" or "2" (whitespace aside) decides the latest numbered card in the thread while it waits.
// Any other text, a tapback, a gated kind's card and a card already decided leave the message a normal turn.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appApprovalLink } from '../src/channels/surfaces/app';
import type { GoogleClient } from '../src/connectors/google';

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const OWNER = 7_000_000_000_001;
const iso = (s: string) => s as never;

const harness = (state: DurableObjectState) => {
  const cards: { text: string; markup: boolean }[] = [], applied: string[] = [], sent: string[] = [];
  // Outside a turn iMessage has no sender to answer, so a card waits for the owner's next message.
  let n = 0, inTurn = true;
  const client = {
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    event: async (id: string) => ({ id, title: 'Standup', start: '2026-10-26T10:00:00Z', end: '2026-10-26T10:15:00Z', all_day: false, etag: 'v1' }),
    createEvent: async (input: { title: string }) => { applied.push(`add ${input.title}`); return { id: `ev-${applied.length}`, title: input.title, start: '', end: '', all_day: false, etag: 'v2' }; },
    cancelEvent: async (id: string) => { applied.push(`cancel ${id}`); },
  } as unknown as GoogleClient;
  const desk = approvalDesk(state.storage.sql, {
    owner: OWNER, surface: 'imessage', appLink: appApprovalLink, appIdentity: () => true, writesFirstNow: () => false,
    call: async (method: string, body: object) => {
      if (method !== 'sendMessage' || !inTurn) return undefined;
      const message = body as { text: string; reply_markup?: unknown };
      cards.push({ text: message.text, markup: message.reply_markup !== undefined });
      return { messages: [{ id: `wac_${cards.length}` }] };
    },
    google: async () => client, newId: () => String(++n), now: () => NOW, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW),
    sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: `sent-${sent.length}` }; },
  });
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  return { desk, cards, applied, sent, status, outsideTurn: (outside: boolean) => { inTurn = !outside; } };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));
const hold = (title: string) => ({ action: 'create' as const, title, start: iso('2026-10-26T15:00:00Z'), end: iso('2026-10-26T16:00:00Z'), reason: 'deep work' });

describe('a one-tap card on iMessage is answered by number', () => {
  it('reads "Reply 1 to add it, or 2 to skip." with no buttons, and "1" approves it exactly once', async () => {
    await owner('imsg-numbered-approve', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      expect(f.cards[0]!.text).toMatch(/\n\nReply 1 to add it, or 2 to skip\.$/);
      expect(f.cards[0]!.markup).toBe(false);
      expect(await f.desk.numberedReply(' 1\n', 'trace')).toMatchObject({ toast: 'Done' });
      expect(f.applied).toEqual(['add Focus']);
      expect(f.status(id)).toBe('done');
      // A second "1" finds no waiting card: it is a normal turn, and nothing is applied again.
      expect(await f.desk.numberedReply('1', 'trace')).toBeNull();
      expect(f.applied).toEqual(['add Focus']);
    });
  });

  it('"2" skips the card', async () => {
    await owner('imsg-numbered-skip', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      expect(await f.desk.numberedReply('2', 'trace')).toMatchObject({ toast: 'Not now' });
      expect(f.status(id)).toBe('skipped');
      expect(f.applied).toEqual([]);
    });
  });

  it('uses the verb of the change: a cancel reads "1 to cancel it"', async () => {
    await owner('imsg-numbered-verb', async state => {
      const f = harness(state);
      await f.desk.propose({ action: 'cancel', event_id: 'e1', title: 'Standup', reason: 'off' });
      expect(f.cards.at(-1)!.text).toMatch(/Reply 1 to cancel it, or 2 to skip\.$/);
    });
  });
});

describe('only an exact 1 or 2, for a waiting numbered card, is a decision', () => {
  it('"1" with no card waiting is a normal turn', async () => {
    await owner('imsg-numbered-none', async state => {
      const f = harness(state);
      expect(await f.desk.numberedReply('1', 'trace')).toBeNull();
    });
  });

  it('other text, a text tapback and words around the number are normal turns', async () => {
    await owner('imsg-numbered-other', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      for (const text of ['yes', 'send', 'ok 1', '1.', '12', 'Liked "Reply 1 to add it, or 2 to skip."', '👍', '']) expect(await f.desk.numberedReply(text, 'trace')).toBeNull();
      expect(f.status(id)).toBe('open');
      expect(f.applied).toEqual([]);
    });
  });

  it('a gated kind gets no numbers, and "1" leaves it waiting for the app', async () => {
    await owner('imsg-numbered-gated', async state => {
      const f = harness(state);
      const id = await f.desk.proposeSendMessage({ channel: 'imessage', content: 'On my way', idempotency_key: 'k1' });
      expect(f.cards.at(-1)!.text).not.toMatch(/Reply 1/);
      expect(f.cards.at(-1)!.text).toContain(`waldo://approvals/${id}`);
      expect(await f.desk.numberedReply('1', 'trace')).toBeNull();
      expect(f.sent).toEqual([]);
      expect(f.status(id)).toBe('open');
    });
  });
});

describe('a card made outside a turn', () => {
  it('waits for the owner\'s next message, and a "1" in that message does not answer the card it brings', async () => {
    await owner('imsg-numbered-waits', async state => {
      const f = harness(state);
      f.outsideTurn(true);
      const id = await f.desk.propose(hold('Focus'));
      expect(f.cards).toEqual([]);
      expect(f.desk.placement(id)).toMatchObject({ here: false, waitsHere: true });
      // The owner writes "1" before ever seeing the card: the number is read first and answers nothing.
      f.outsideTurn(false);
      expect(await f.desk.numberedReply('1', 'trace')).toBeNull();
      await f.desk.ownerWrote();
      expect(f.cards.at(-1)!.text).toMatch(/Reply 1 to add it, or 2 to skip\.$/);
      expect(f.status(id)).toBe('open');
      expect(f.applied).toEqual([]);
      expect(await f.desk.numberedReply('1', 'trace')).toMatchObject({ toast: 'Done' });
      expect(f.applied).toEqual(['add Focus']);
    });
  });
});

describe('two cards waiting', () => {
  it('the numbers answer the latest card, which says so; the earlier one is not answered by number after it', async () => {
    await owner('imsg-numbered-two', async state => {
      const f = harness(state);
      const first = await f.desk.propose(hold('First'));
      const second = await f.desk.propose(hold('Second'));
      expect(f.cards[0]!.text).not.toContain('earlier');
      expect(f.cards[1]!.text).toMatch(/Reply 1 to add it, or 2 to skip\. These numbers now answer this card, not the earlier one\.$/);
      expect(await f.desk.numberedReply('1', 'trace')).toMatchObject({ toast: 'Done' });
      expect(f.applied).toEqual(['add Second']);
      expect(f.status(first)).toBe('open');
      expect(f.status(second)).toBe('done');
      expect(await f.desk.numberedReply('1', 'trace')).toBeNull();
      expect(f.applied).toEqual(['add Second']);
    });
  });

  it('a gated card after a numbered one leaves the numbers on the numbered card', async () => {
    await owner('imsg-numbered-then-gated', async state => {
      const f = harness(state);
      const hold1 = await f.desk.propose(hold('Focus'));
      await f.desk.proposeSendMessage({ channel: 'imessage', content: 'On my way', idempotency_key: 'k2' });
      expect(await f.desk.numberedReply('2', 'trace')).toMatchObject({ toast: 'Not now' });
      expect(f.status(hold1)).toBe('skipped');
      expect(f.sent).toEqual([]);
    });
  });

  it('two "1"s at once approve once', async () => {
    await owner('imsg-numbered-concurrent', async state => {
      const f = harness(state);
      await f.desk.propose(hold('Focus'));
      const outcomes = await Promise.all([f.desk.numberedReply('1', 'trace'), f.desk.numberedReply('1', 'trace')]);
      expect(f.applied).toEqual(['add Focus']);
      expect(outcomes.filter(out => out?.toast === 'Done')).toHaveLength(1);
    });
  });
});
