// An approval card on a surface that lets Waldo write first only for a while after the owner's last message (WhatsApp's
// 24-hour window), through the real window layer. A card the surface cannot take now is neither held as text nor recorded as
// presented: it waits, and goes out once the owner writes there, which is when its presentation is recorded, in the same commit
// as the row opening. A card is sent at most once, and never for an approval that is no longer waiting on the owner.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, PROPOSAL_TTL_MS, proposalStatus } from '../src/channels/approvals';
import { WhatsAppApiError } from '../src/channels/whatsapp-api';
import { whatsappWindowCaller, whatsappWindowOpen } from '../src/channels/whatsapp-window';
import { sha256Hex } from '../src/connectors/google';

const NOW = Date.UTC(2026, 9, 18, 9, 0, 0);
const HOUR = 60 * 60_000;
const OWNER = 447700900123;
const SHOWN_HERE = 'review card requested in chat; nothing was sent';

const fixture = (state: DurableObjectState, options: Readonly<{ app?: boolean }> = {}) => {
  const { kv, sql } = state.storage;
  let now = NOW, wamid = 0, next: 'unknown' | 'refused' | null = null, n = 0;
  // The owner last wrote 30 hours ago, so the window is closed.
  kv.put('wa_last_inbound_ms', NOW - 30 * HOUR);
  const attempts: string[] = [], delivered: string[] = [], sent: string[] = [];
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
    return { messaging_product: 'whatsapp', contacts: [{ input: String(OWNER), wa_id: String(OWNER) }], messages: [{ id: `wamid.card-${wamid}` }] };
  };
  const call = whatsappWindowCaller(inner, { kv, template: { name: 'waldo_update_ready', language: 'en' }, now: () => now, log: () => undefined });
  const desk = approvalDesk(sql, { owner: OWNER, surface: 'whatsapp', call, writesFirstNow: () => whatsappWindowOpen(kv, now),
    google: async () => null, newId: () => `w${++n}`, now: () => now, timezone: 'UTC', log: () => undefined, commit: work => state.storage.transactionSync(work),
    sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: `wamid.sent-${sent.length}` }; },
    ...(options.app ? { appIdentity: () => true } : {}) });
  return {
    desk, attempts, delivered, sent,
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
const email = async () => {
  const raw = 'To: sam@example.test\r\nSubject: Weekly numbers\r\nMessage-ID: <weekly@waldo-send>\r\n\r\nHi Sam';
  return { to: ['sam@example.test'], subject: 'Weekly numbers', body: 'Hi Sam', message_id: '<weekly@waldo-send>', raw, digest: await sha256Hex(raw) };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));

describe('an approval card the surface cannot send now', () => {
  it('waits: it is not held as text, has no presentation, stays unconfirmed, and the tool and ledger say it waits', async () => {
    await owner('approval-card-waits', async state => {
      const f = fixture(state);
      const proposal = await email();
      const id = await f.desk.proposeSendEmail(proposal);
      // The window layer refused the card and knocked once; the email's chat receipt was not sent either.
      expect(f.delivered).toEqual(['knock']);
      expect(f.held()).toBe(0);
      expect(f.status(id)).toBe('card_unconfirmed');
      expect(f.shown(id)).toEqual([]);
      expect(f.desk.placement(id)).toEqual({ here: false, hereApprovable: false, app: false, appApprovable: false, waitsHere: true });
      expect(proposalStatus(f.desk.placement(id), SHOWN_HERE, 'Nothing was sent.')).toBe('The review card goes out here when the owner next writes, so it cannot be approved yet. Nothing was sent.');
      expect(f.desk.ledger([])).toContain('- Send email to sam@example.test: "Weekly numbers" (review card goes out when you next write; cannot approve yet)');
      // A replay of the same proposal finds the waiting card, instead of reading it as a card whose delivery is unknown.
      expect(await f.desk.proposeSendEmail(proposal)).toBe(id);
      expect(f.attempts).toEqual([]);
    });
  });

  it('goes out once the owner writes, with its presentation recorded then, and is decided once', async () => {
    await owner('approval-card-goes-out', async state => {
      const f = fixture(state);
      const id = await f.desk.proposeSendMessage(message('On my way'));
      f.tick(2 * HOUR); f.writes();
      await f.desk.ownerWrote();
      expect(f.delivered).toEqual(['knock', expect.stringContaining('Send this message on whatsapp?')]);
      expect(f.shown(id)).toEqual([{ surface: 'whatsapp', message_ref: 'wamid.card-1', approvable: 1, presented_at: NOW + 2 * HOUR }]);
      expect(f.status(id)).toBe('open');
      expect(f.desk.placement(id)).toEqual({ here: true, hereApprovable: true, app: false, appApprovable: false });
      // Nothing waits any more, so the owner's next message sends nothing.
      await f.desk.ownerWrote();
      expect(f.attempts).toHaveLength(1);

      await f.reply(`a:${id}`);
      await f.reply(`a:${id}`);
      expect(f.sent).toEqual(['On my way']);
      expect(f.status(id)).toBe('done');
      expect(f.delivered.slice(2)).toEqual([expect.stringContaining('Sent:'), 'Already handled.']);
    });
  });

  it('is sent at most once: a send that ends unknown is not tried again, and a card refused again waits again', async () => {
    await owner('approval-card-at-most-once', async state => {
      const f = fixture(state);
      const first = await f.desk.proposeSendMessage(message('first'));
      const second = await f.desk.proposeSendMessage(message('second'));
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
      expect(f.desk.ledger([])).toContain('- Send this on whatsapp: "first" (review card delivery unconfirmed; cannot approve)');
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
      const id = await f.desk.proposeSendMessage(message('Running late'));
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
      const id = await f.desk.proposeSendMessage(message('Raised later'));
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
      await expect(desk.proposeSendMessage(message('blocked'))).rejects.toThrow('Approval card not confirmed');
      expect(desk.placement('pb1')).toEqual({ here: false, hereApprovable: false, app: false, appApprovable: false });
      expect(desk.ledger([])).toContain('(review card delivery unconfirmed; cannot approve)');
    });
  });
});
