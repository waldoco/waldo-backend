// An approval card on a surface that lets Waldo write first only for a while after the owner's last message (WhatsApp's
// 24-hour window), through the real window layer. A card the surface cannot take now is neither held as text nor recorded as
// presented: it waits, and goes out once the owner writes there, which is when its presentation is recorded, in the same commit
// as the row opening. A card is sent at most once, and never for an approval that is no longer waiting on the owner.
// A send to another person is approved only in the app, so it always opens there at once; the cards that can wait unpresented
// are the ones chat approves, such as a hold on the owner's own calendar.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, endCardWaits, forgetWaitingCards, PROPOSAL_TTL_MS, proposalStatus } from '../src/channels/approvals';
import type { TurnLogEntry } from '../src/channels/telegram-listener';
import { WhatsAppApiError } from '../src/channels/whatsapp-api';
import { whatsappWindowCaller, whatsappWindowOpen } from '../src/channels/whatsapp-window';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';
import { stableJson } from '../src/context-composer/canonical';

const NOW = Date.UTC(2026, 9, 18, 9, 0, 0);
const HOUR = 60 * 60_000;
const OWNER = 447700900123;
const SHOWN_HERE = 'review card requested in chat; nothing was sent';

const fixture = (state: DurableObjectState, options: Readonly<{ app?: boolean }> = {}) => {
  const { kv, sql } = state.storage;
  let now = NOW, wamid = 0, next: 'unknown' | 'refused' | null = null, n = 0;
  // The owner last wrote 30 hours ago, so the window is closed.
  kv.put('wa_last_inbound_ms', NOW - 30 * HOUR);
  const attempts: string[] = [], delivered: string[] = [], sent: string[] = [], ran: string[] = [], holds: string[] = [], logs: TurnLogEntry[] = [];
  const calendar = { createEvent: async (input: { title: string }) => { holds.push(input.title); return { id: `ev-${holds.length}`, title: input.title, start: '', end: '', all_day: false, etag: 'v1' }; } } as unknown as GoogleClient;
  let duringSend: ((text: string) => void) | null = null;
  const inner = async (method: string, body: object) => {
    if (method === 'sendTemplate') { delivered.push('knock'); return { messages: [{ id: 'wamid.knock' }] }; }
    // WhatsApp has no callback answers or keyboards to edit.
    if (method !== 'sendMessage') return undefined;
    const { text } = body as { text: string };
    attempts.push(text);
    const failing = next; next = null;
    if (failing === 'unknown') throw new Error('whatsapp send timed out; delivery uncertain');
    if (failing === 'refused') throw new WhatsAppApiError(400, JSON.stringify({ error: { code: 131047 } }));
    wamid += 1; delivered.push(text);
    duringSend?.(text);
    return { messaging_product: 'whatsapp', contacts: [{ input: String(OWNER), wa_id: String(OWNER) }], messages: [{ id: `wamid.card-${wamid}` }] };
  };
  const call = whatsappWindowCaller(inner, { kv, template: { name: 'waldo_update_ready', language: 'en' }, now: () => now, log: () => undefined });
  const desk = approvalDesk(sql, { owner: OWNER, surface: 'whatsapp', call, writesFirstNow: () => whatsappWindowOpen(kv, now),
    google: async () => calendar, newId: () => `w${++n}`, now: () => now, timezone: 'UTC', log: entry => { logs.push(entry); }, commit: work => state.storage.transactionSync(work),
    sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: `wamid.sent-${sent.length}` }; },
    replayTaintedAction: async proposal => { ran.push(proposal.tool); return { status: 'done', message: 'Created.' }; },
    ...(options.app ? { appIdentity: () => true } : {}) });
  return {
    desk, attempts, delivered, sent, ran, holds, logs, sql,
    now: () => now,
    // Runs while WhatsApp accepts a card, as a decision made elsewhere during the pass would.
    onSend: (work: (text: string) => void) => { duringSend = work; },
    tick: (ms: number) => { now += ms; },
    // The owner writes on WhatsApp, which opens the window.
    writes: () => { kv.put('wa_last_inbound_ms', now); },
    failNext: (how: 'unknown' | 'refused') => { next = how; },
    held: () => [...kv.list({ prefix: 'wa_held:' })].length,
    status: (id: string) => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status,
    shown: (id: string) => sql.exec<{ surface: string; message_ref: string; approvable: number; presented_at: number }>('SELECT surface, message_ref, approvable, presented_at FROM approval_presentations WHERE approval_id = ? ORDER BY surface', id).toArray(),
    // A WhatsApp reply carries message_id 0.
    reply: (data: string) => desk.callback({ id: `wa-${data}`, from: { id: OWNER }, data, message: { message_id: 0, chat: { id: OWNER } } }, 'trace'),
  };
};
const message = (content: string) => ({ channel: 'whatsapp', content, idempotency_key: `key-${content}` });
// A hold on the owner's own calendar, which chat approves in one tap.
const hold = (title: string) => ({ action: 'create' as const, title, start: new Date(NOW + 72 * HOUR).toISOString() as never, end: new Date(NOW + 73 * HOUR).toISOString() as never, reason: 'focus' });
const email = async () => {
  const raw = 'To: sam@example.test\r\nSubject: Weekly numbers\r\nMessage-ID: <weekly@waldo-send>\r\n\r\nHi Sam';
  return { to: ['sam@example.test'], subject: 'Weekly numbers', body: 'Hi Sam', message_id: '<weekly@waldo-send>', raw, digest: await sha256Hex(raw) };
};
// An action a turn that read external content wanted to run: it needs the owner's approval card before it runs.
const tainted = async () => {
  const args = { title: 'Pay the invoice from the email' };
  return { tool: 'create_task', args, args_digest: await sha256Hex(stableJson(args)), reasoning: 'The email asked for it.', source: 'external' as const };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));

describe('an approval card the surface cannot send now', () => {
  it('waits: it is not held as text, has no presentation, stays unconfirmed, and the tool and ledger say it waits', async () => {
    await owner('approval-card-waits', async state => {
      const f = fixture(state);
      const id = await f.desk.propose(hold('Weekly review'), 'turn-1');
      // The window layer refused the card and knocked once.
      expect(f.delivered).toEqual(['knock']);
      expect(f.held()).toBe(0);
      expect(f.status(id)).toBe('card_unconfirmed');
      expect(f.shown(id)).toEqual([]);
      expect(f.desk.placement(id)).toEqual({ here: false, hereApprovable: false, app: false, appApprovable: false, waitsHere: true });
      expect(proposalStatus(f.desk.placement(id), SHOWN_HERE, 'Nothing was sent.')).toBe('The review card goes out here when the owner next writes, so it cannot be approved yet. Nothing was sent.');
      expect(f.desk.ledger([])).toContain('- Add "Weekly review"');
      expect(f.desk.ledger([])).toContain('(review card goes out when you next write; cannot approve yet)');
      // A replay of the same proposal finds the waiting card, instead of reading it as a card whose delivery is unknown.
      expect(await f.desk.propose(hold('Weekly review'), 'turn-1')).toBe(id);
      expect(f.attempts).toEqual([]);
    });
  });

  it('goes out once the owner writes, with its presentation recorded then, and is decided once', async () => {
    await owner('approval-card-goes-out', async state => {
      const f = fixture(state);
      const id = await f.desk.propose(hold('Focus'));
      f.tick(2 * HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.delivered).toEqual(['knock', expect.stringContaining('Add "Focus"')]);
      expect(f.shown(id)).toEqual([{ surface: 'whatsapp', message_ref: 'wamid.card-1', approvable: 1, presented_at: NOW + 2 * HOUR }]);
      expect(f.status(id)).toBe('open');
      expect(f.desk.placement(id)).toEqual({ here: true, hereApprovable: true, app: false, appApprovable: false });
      // Nothing waits any more, so the owner's next message sends nothing.
      await f.desk.ownerWrote();
      expect(f.attempts).toHaveLength(1);

      await f.reply(`a:${id}`);
      await f.reply(`a:${id}`);
      expect(f.holds).toEqual(['Focus']);
      expect(f.status(id)).toBe('done');
      expect(f.delivered.slice(2)).toEqual([expect.stringContaining('Done: Add "Focus"'), 'Already handled.']);
    });
  });

  it('a tainted action opens in the app at once; its chat card waits, goes out without an approval, and the app runs it once', async () => {
    await owner('approval-card-tainted-action', async state => {
      const f = fixture(state);
      const id = await f.desk.proposeTaintedAction(await tainted());
      expect(f.delivered).toEqual(['knock']);
      expect(f.held()).toBe(0);
      expect(f.status(id)).toBe('open');
      expect(f.shown(id)).toMatchObject([{ surface: 'app', approvable: 1 }]);
      expect(f.desk.placement(id)).toEqual({ here: false, hereApprovable: false, app: true, appApprovable: true, waitsHere: true, handsToApp: true });
      expect(proposalStatus(f.desk.placement(id), 'sent to the owner with Do it / Not now buttons', 'Nothing ran.')).toBe('The review card is in the Waldo app; here it goes out when the owner next writes. Nothing ran.');
      expect((await f.desk.decide(id, 'a', 'trace', { surface: 'whatsapp', messageRef: `${OWNER}:0` })).toast).toBe('Review it in the app');
      expect(f.ran).toEqual([]);
      expect(f.attempts).toEqual([]);

      f.tick(HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([expect.stringContaining('Run this action?')]);
      expect(f.attempts[0]).toContain('approved in the Waldo app');
      expect(f.shown(id).map(row => [row.surface, row.approvable])).toEqual([['app', 1], ['whatsapp', 0]]);

      await f.reply(`a:${id}`);
      expect(f.ran).toEqual([]);
      await f.desk.decide(id, 'a', 'trace', { surface: 'app' });
      await f.desk.decide(id, 'a', 'trace', { surface: 'app' });
      expect(f.ran).toEqual(['create_task']);
      expect(f.status(id)).toBe('done');
    });
  });

  it('is sent at most once: a send that ends unknown is not tried again, and a card refused again waits again', async () => {
    await owner('approval-card-at-most-once', async state => {
      const f = fixture(state);
      const first = await f.desk.propose(hold('first'));
      const second = await f.desk.propose(hold('second'));
      f.tick(HOUR); f.writes();
      f.failNext('unknown');
      await f.desk.ownerWrote();
      // The first card may have arrived, so it stays unconfirmed and is never sent again; the pass stopped before the second.
      expect(f.attempts).toEqual([expect.stringContaining('first')]);
      expect(f.status(first)).toBe('card_unconfirmed');
      expect(f.shown(first)).toEqual([]);
      expect(f.desk.placement(first)).toEqual({ here: false, hereApprovable: false, app: false, appApprovable: false });
      expect(f.desk.placement(second)).toMatchObject({ waitsHere: true });

      // WhatsApp refuses the second for the window after all, so it waits for the owner's next message again.
      f.failNext('refused');
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([expect.stringContaining('first'), expect.stringContaining('second')]);
      expect(f.status(second)).toBe('card_unconfirmed');
      expect(f.desk.placement(second)).toMatchObject({ waitsHere: true });
      expect(f.held()).toBe(0);

      f.tick(HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([expect.stringContaining('first'), expect.stringContaining('second'), expect.stringContaining('second')]);
      expect(f.status(second)).toBe('open');
      expect(f.status(first)).toBe('card_unconfirmed');
      expect(f.desk.ledger([])).toMatch(/- Add "first".*\(review card delivery unconfirmed; cannot approve\)/);
    });
  });

  it('is never sent for an approval that expired, was decided, or was put off before the owner wrote', async () => {
    await owner('approval-card-no-longer-waiting', async state => {
      const f = fixture(state, { app: true });
      const expired = await f.desk.proposeSendMessage(message('expires'));
      f.tick(PROPOSAL_TTL_MS - HOUR);
      const skipped = await f.desk.proposeSendMessage(message('skipped'));
      const putOff = await f.desk.proposeSendMessage(message('put off'));
      const changing = await f.desk.proposeSendMessage(message('changing'));
      await f.desk.decide(skipped, 's', 'trace', { surface: 'app' });
      await f.desk.decide(putOff, 'd', 'trace', { surface: 'app' });
      await f.desk.decide(changing, 'e', 'trace', { surface: 'app' });
      f.tick(2 * HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([]);
      expect([expired, skipped, putOff, changing].map(f.status)).toEqual(['expired', 'skipped', 'open', 'changing']);
    });
  });

  it('waits beside the app card: the row opens through the app at once, and the chat card follows when the owner writes', async () => {
    await owner('approval-card-beside-app', async state => {
      const f = fixture(state, { app: true });
      const id = await f.desk.propose(hold('Running'));
      expect(f.status(id)).toBe('open');
      expect(f.shown(id)).toMatchObject([{ surface: 'app', approvable: 1 }]);
      expect(f.desk.placement(id)).toEqual({ here: false, hereApprovable: false, app: true, appApprovable: true, waitsHere: true });
      expect(proposalStatus(f.desk.placement(id), SHOWN_HERE, 'Nothing was sent.')).toBe('The review card is in the Waldo app; here it goes out when the owner next writes. Nothing was sent.');
      // Before the chat card arrives, it cannot be approved from WhatsApp.
      expect((await f.desk.decide(id, 'a', 'trace', { surface: 'whatsapp', messageRef: `${OWNER}:0` })).toast).toBe('Not available here');

      f.tick(HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.shown(id).map(row => row.surface)).toEqual(['app', 'whatsapp']);
      expect(f.desk.placement(id)).toEqual({ here: true, hereApprovable: true, app: true, appApprovable: true });
    });
  });

  it('goes out once when it is raised after being put off: the raise sends it, and the owner\'s next message does not', async () => {
    await owner('approval-card-raised', async state => {
      const f = fixture(state, { app: true });
      const id = await f.desk.propose(hold('Raised later'));
      await f.desk.decide(id, 'd', 'trace', { surface: 'app' });
      f.tick(HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([]);
      expect(await f.desk.reraise(id)).toMatchObject({ outcome: 'raised', shown_on: ['whatsapp', 'app'] });
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([expect.stringContaining('Raised later')]);
      expect(f.desk.placement(id)).toEqual({ here: true, hereApprovable: true, app: true, appApprovable: true });
    });
  });

  it('on a surface that could write first now, a card that did not go out is a failed presentation, as before', async () => {
    await owner('approval-card-blocked', async state => {
      let n = 0;
      const desk = approvalDesk(state.storage.sql, { owner: OWNER, surface: 'whatsapp', call: async () => undefined, writesFirstNow: () => true,
        google: async () => null, newId: () => `b${++n}`, now: () => NOW, timezone: 'UTC', log: () => undefined });
      await expect(desk.propose(hold('blocked'))).rejects.toThrow('Approval card not confirmed');
      expect(desk.placement('pb1')).toEqual({ here: false, hereApprovable: false, app: false, appApprovable: false });
      expect(desk.ledger([])).toContain('(review card delivery unconfirmed; cannot approve)');
    });
  });
});

describe('a waiting approval card the owner can no longer be shown', () => {
  it('is ended by a forget that names it, so the owner\'s next message never sends it; one that does not name it still goes out', async () => {
    await owner('approval-card-forget', async state => {
      const f = fixture(state);
      const named = await f.desk.propose(hold('Weekly numbers'));
      const other = await f.desk.propose(hold('Running late'));
      expect(forgetWaitingCards(f.sql, ['weekly numbers'], f.now())).toEqual({ ended: 1, remaining: 0 });
      expect(f.status(named)).toBe('skipped');
      expect(f.desk.placement(named)).toEqual({ here: false, hereApprovable: false, app: false, appApprovable: false });
      f.tick(HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([expect.stringContaining('Running late')]);
      expect(f.attempts.join('\n')).not.toContain('Weekly numbers');
      expect(f.status(other)).toBe('open');
      // Nothing is left waiting, and a second forget finds nothing.
      expect(forgetWaitingCards(f.sql, ['weekly numbers'], f.now())).toEqual({ ended: 0, remaining: 0 });
    });
  });

  it('a forget before any approval was ever made finds no ledger and ends nothing', async () => {
    await owner('approval-card-forget-empty', async state => {
      expect(forgetWaitingCards(state.storage.sql, ['weekly numbers'], NOW)).toEqual({ ended: 0, remaining: 0 });
      expect(() => endCardWaits(state.storage.sql, 'whatsapp')).not.toThrow();
    });
  });

  it('stops waiting when the surface is bound to another number: the new number never gets a card made before it was linked', async () => {
    await owner('approval-card-rebind', async state => {
      const f = fixture(state);
      const id = await f.desk.propose(hold('Made for the old number'));
      endCardWaits(f.sql, 'whatsapp');
      f.tick(HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([]);
      expect(f.desk.placement(id)).toEqual({ here: false, hereApprovable: false, app: false, appApprovable: false });
      expect(f.desk.ledger([])).toMatch(/- Add "Made for the old number".*\(review card delivery unconfirmed; cannot approve\)/);
    });
  });

  it('is not sent when it was decided elsewhere while the pass was sending the card before it', async () => {
    await owner('approval-card-decided-mid-pass', async state => {
      const f = fixture(state, { app: true });
      const first = await f.desk.proposeSendMessage(message('first'));
      const second = await f.desk.proposeSendMessage(message('second'));
      f.onSend(text => { if (text.includes('first')) f.sql.exec("UPDATE ledger SET status = 'skipped', decided_at = ? WHERE id = ?", f.now(), second); });
      f.tick(HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.attempts).toEqual([expect.stringContaining('first')]);
      expect(f.status(first)).toBe('open');
      expect(f.status(second)).toBe('skipped');
    });
  });

  it('a card shown before, put off, raised and refused again counts as not shown in this pass', async () => {
    await owner('approval-card-refused-again', async state => {
      const f = fixture(state);
      // The owner wrote 23 hours ago, so the card goes out at once, and the window closes an hour later.
      f.writes(); f.tick(23 * HOUR);
      const id = await f.desk.propose(hold('shown once'));
      expect(f.shown(id)).toHaveLength(1);
      await f.desk.decide(id, 'd', 'trace', { surface: 'whatsapp', messageRef: `${OWNER}:0` });
      f.tick(2 * HOUR);
      await f.desk.reraise(id);
      expect(f.desk.placement(id)).toMatchObject({ waitsHere: true });
      f.writes(); f.failNext('refused');
      f.logs.length = 0;
      await f.desk.ownerWrote();
      expect(f.logs.filter(entry => entry.hop === 'approval_card_waited').map(entry => [entry.ok, entry.code ?? entry.detail])).toEqual([[false, 'waits_again']]);
    });
  });

  it('answers a decision on a card that has not gone out yet with when it will, not "Already handled."', async () => {
    await owner('approval-card-decide-waiting', async state => {
      const f = fixture(state);
      const id = await f.desk.propose(hold('not out yet'));
      const out = await f.desk.decide(id, 'a', 'trace', { surface: 'app' });
      expect(out.message).not.toBe('Already handled.');
      expect(out.message).toContain('when you next write');
      expect(f.holds).toEqual([]);
      expect(f.status(id)).toBe('card_unconfirmed');
    });
  });
});
