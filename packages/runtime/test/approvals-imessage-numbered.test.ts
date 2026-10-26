// iMessage approves by numbered reply. A card for a kind chat approves in one tap ends "Reply 1 to <verb>, or 2 to skip.",
// and the owner's next message "1" or "2" (whitespace aside) decides the latest numbered card in the thread while it is open
// and still Waldo's latest message in that chat. Any other text, a tapback, a gated kind's card, a card already decided or
// expired, and a card Waldo has written past leave the message a normal turn.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, PROPOSAL_TTL_MS, proposalStatus } from '../src/channels/approvals';
import { iMessageApprovalCaller, iMessageCardIsLatest } from '../src/channels/imessage/approval-cards';
import { IMessageFinalOutbox, targetOf } from '../src/channels/imessage/final-outbox';
import type { IMessageInboxRecord } from '../src/channels/imessage/owner-inbox';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appApprovalLink } from '../src/channels/surfaces/app';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { GoogleClient } from '../src/connectors/google';

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const OWNER = 7_000_000_000_001;
const iso = (s: string) => s as never;
// The card is still Waldo's latest message in the chat; the iMessage check itself is tested on the outbox below.
const stillLatest = () => true;

const harness = (state: DurableObjectState) => {
  const cards: { text: string; markup: boolean }[] = [], applied: string[] = [], sent: string[] = [];
  // Outside a turn iMessage has no sender to answer, so a card waits for the owner's next message.
  let n = 0, inTurn = true, now = NOW;
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
    google: async () => client, newId: () => String(++n), now: () => now, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => now),
    sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: `sent-${sent.length}` }; },
  });
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  return { desk, cards, applied, sent, status, outsideTurn: (outside: boolean) => { inTurn = !outside; }, later: (ms: number) => { now += ms; } };
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
      expect(await f.desk.numberedReply(' 1\n', 'trace', stillLatest)).toMatchObject({ toast: 'Done' });
      expect(f.applied).toEqual(['add Focus']);
      expect(f.status(id)).toBe('done');
      // A second "1" finds no waiting card: it is a normal turn, and nothing is applied again.
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toBeNull();
      expect(f.applied).toEqual(['add Focus']);
    });
  });

  it('"2" skips the card', async () => {
    await owner('imsg-numbered-skip', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      expect(await f.desk.numberedReply('2', 'trace', stillLatest)).toMatchObject({ toast: 'Not now' });
      expect(f.status(id)).toBe('skipped');
      expect(f.applied).toEqual([]);
    });
  });

  it('tells the proposing model the card is answered by number, not buttons, so its reply offers no numbered choices', async () => {
    await owner('imsg-numbered-status', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      const status = proposalStatus(f.desk.placement(id), 'sent to the owner with Do it / Modify / Not now buttons', 'Nothing has changed.');
      expect(status).toMatch(/reply 1 to approve or 2 to skip/);
      expect(status).toMatch(/do not offer numbered choices/i);
      expect(status).not.toMatch(/buttons/);
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
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toBeNull();
    });
  });

  it('other text, a text tapback and words around the number are normal turns', async () => {
    await owner('imsg-numbered-other', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      for (const text of ['yes', 'send', 'ok 1', '1.', '12', 'Liked "Reply 1 to add it, or 2 to skip."', '👍', '']) expect(await f.desk.numberedReply(text, 'trace', stillLatest)).toBeNull();
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
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toBeNull();
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
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toBeNull();
      await f.desk.ownerWrote();
      expect(f.cards.at(-1)!.text).toMatch(/Reply 1 to add it, or 2 to skip\.$/);
      expect(f.status(id)).toBe('open');
      expect(f.applied).toEqual([]);
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toMatchObject({ toast: 'Done' });
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
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toMatchObject({ toast: 'Done' });
      expect(f.applied).toEqual(['add Second']);
      expect(f.status(first)).toBe('open');
      expect(f.status(second)).toBe('done');
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toBeNull();
      expect(f.applied).toEqual(['add Second']);
    });
  });

  it('a gated card after a numbered one leaves the numbers on the numbered card', async () => {
    await owner('imsg-numbered-then-gated', async state => {
      const f = harness(state);
      const hold1 = await f.desk.propose(hold('Focus'));
      await f.desk.proposeSendMessage({ channel: 'imessage', content: 'On my way', idempotency_key: 'k2' });
      expect(await f.desk.numberedReply('2', 'trace', stillLatest)).toMatchObject({ toast: 'Not now' });
      expect(f.status(hold1)).toBe('skipped');
      expect(f.sent).toEqual([]);
    });
  });

  it('two "1"s at once approve once', async () => {
    await owner('imsg-numbered-concurrent', async state => {
      const f = harness(state);
      await f.desk.propose(hold('Focus'));
      const outcomes = await Promise.all([f.desk.numberedReply('1', 'trace', stillLatest), f.desk.numberedReply('1', 'trace', stillLatest)]);
      expect(f.applied).toEqual(['add Focus']);
      expect(outcomes.filter(out => out?.toast === 'Done')).toHaveLength(1);
    });
  });
});

describe('a number counts only while the card is open', () => {
  it('a card the waiting() sweep expired takes no number: "1" and "2" are ordinary turns, and nothing is decided', async () => {
    await owner('imsg-numbered-expired-swept', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      f.later(PROPOSAL_TTL_MS + 60_000);
      expect(f.desk.waiting()).toEqual([]);
      expect(f.status(id)).toBe('expired');
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toBeNull();
      expect(await f.desk.numberedReply('2', 'trace', stillLatest)).toBeNull();
      expect(f.status(id)).toBe('expired');
      expect(f.applied).toEqual([]);
    });
  });

  it('a card past its expiry that no read has closed yet takes no number either', async () => {
    await owner('imsg-numbered-expired-unswept', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      f.later(PROPOSAL_TTL_MS + 60_000);
      expect(await f.desk.numberedReply('1', 'trace', stillLatest)).toBeNull();
      expect(f.status(id)).toBe('expired');
      expect(f.applied).toEqual([]);
    });
  });
});

describe('a number counts only while the card is Waldo\'s latest message in that chat', () => {
  it('asks about the card that offered the numbers, and a card Waldo wrote past stays open for the model\'s turn', async () => {
    await owner('imsg-numbered-written-past', async state => {
      const f = harness(state);
      const id = await f.desk.propose(hold('Focus'));
      const asked: string[] = [];
      expect(await f.desk.numberedReply('1', 'trace', ref => { asked.push(ref); return false; })).toBeNull();
      expect(asked).toEqual(['wac_1']);
      expect(f.status(id)).toBe('open');
      expect(f.applied).toEqual([]);
    });
  });
});

// The real iMessage composition: a card goes out through the approval caller under its turn's scope, and the numbered
// reply asks the frozen outbox whether that card is still Waldo's latest message in the chat the reply came from.
const OWNER_CHAT = 'owner@example.invalid', OTHER_CHAT = 'other@example.invalid';
let turns = 0;
const inbound = (subject = OWNER_CHAT) => {
  const id = `imsg-${++turns}`;
  return { id, updateId: turns, dedupKey: `dedup-${id}`, digest: '0'.repeat(64), text: '1', conversationRef: 'c', binding: { subject } as never, bindingDigest: 'b',
    revision: '1', environment: 'test', bridgeDoName: 'bridge', ownerDoName: 'owner', commandId: `cmd-${id}`, occurredAt: 1, admittedAt: 1, state: 'admitted' } as IMessageInboxRecord;
};
const thread = (state: DurableObjectState) => {
  const applied: string[] = [];
  let running: IMessageInboxRecord | null = null, n = 0;
  const scope = { commit: <T>(work: () => T) => state.storage.transactionSync(work) } as unknown as RunEffectScope;
  const client = {
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    createEvent: async (input: { title: string }) => { applied.push(`add ${input.title}`); return { id: `ev-${applied.length}`, title: input.title, start: '', end: '', all_day: false, etag: 'v2' }; },
  } as unknown as GoogleClient;
  const desk = approvalDesk(state.storage.sql, {
    owner: OWNER, surface: 'imessage', appLink: appApprovalLink, appIdentity: () => true, writesFirstNow: () => false,
    call: iMessageApprovalCaller(state.storage, () => running && { record: running, scope }),
    google: async () => client, newId: () => String(++n), now: () => NOW, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW),
  });
  const outbox = new IMessageFinalOutbox(state.storage);
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  // One owner turn: the card it proposes goes out ahead of its reply, which closes it.
  const turn = async (record: IMessageInboxRecord, work: () => Promise<unknown> = async () => undefined) => {
    running = record;
    try { await work(); } finally { running = null; }
    outbox.freeze(record, 'Scripted reply.');
  };
  const number = (record: IMessageInboxRecord, text: string) => desk.numberedReply(text, 'trace', iMessageCardIsLatest(state.storage, record));
  return { desk, outbox, applied, status, turn, number };
};
type Thread = ReturnType<typeof thread>;

describe('on the iMessage outbox, the card must still be Waldo\'s latest message in that chat', () => {
  it('a card whose own turn\'s reply follows it is still the latest: "1" approves it, after an earlier turn\'s reply', async () => {
    await owner('imsg-latest-own-reply', async state => {
      const f = thread(state);
      await f.turn(inbound());
      let id = '';
      await f.turn(inbound(), async () => { id = await f.desk.propose(hold('Focus')); });
      expect(await f.number(inbound(), '1')).toMatchObject({ toast: 'Done' });
      expect(f.status(id)).toBe('done');
      expect(f.applied).toEqual(['add Focus']);
    });
  });

  const writtenPast: readonly (readonly [string, (f: Thread) => unknown])[] = [
    ["a later turn's reply", f => f.turn(inbound())],
    ['a later reply that offers its own numbered choices', f => f.outbox.freeze(inbound(), 'Which day?\n1. Tuesday\n2. Wednesday')],
    ["a later turn's progress note", f => f.outbox.freezeProgress(inbound(), 1, 'Still checking your calendar.')],
    ['a message Waldo started', f => f.outbox.freezeProactive('job-1', 'wpc_job-1', targetOf(inbound()), 'Time to call Sam.')],
  ];
  for (const [what, writePast] of writtenPast) {
    it(`after ${what}, "1" and "2" go to the model and the card stays open`, async () => {
      await owner('imsg-latest-written-past', async state => {
        const f = thread(state);
        let id = '';
        await f.turn(inbound(), async () => { id = await f.desk.propose(hold('Focus')); });
        await writePast(f);
        expect(await f.number(inbound(), '1')).toBeNull();
        expect(await f.number(inbound(), '2')).toBeNull();
        expect(f.status(id)).toBe('open');
        expect(f.applied).toEqual([]);
      });
    });
  }

  it('a "1" from another chat answers nothing, and a message to that chat does not write past the card', async () => {
    await owner('imsg-latest-other-chat', async state => {
      const f = thread(state);
      let id = '';
      await f.turn(inbound(OTHER_CHAT));
      await f.turn(inbound(), async () => { id = await f.desk.propose(hold('Focus')); });
      expect(await f.number(inbound(OTHER_CHAT), '1')).toBeNull();
      await f.turn(inbound(OTHER_CHAT));
      expect(f.status(id)).toBe('open');
      expect(await f.number(inbound(), '1')).toMatchObject({ toast: 'Done' });
      expect(f.applied).toEqual(['add Focus']);
    });
  });
});
