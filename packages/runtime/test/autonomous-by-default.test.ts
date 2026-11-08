// Autonomous by default (AUTONOMOUS_BY_DEFAULT). Work the owner asked for in their own message runs with no card and is
// reported with an undo where one exists. Cards stay for what outside content asked for and for the kinds whose effect code
// cannot see (a browser submit that may pay or enter a password, an MCP call), and every card left is decided on the
// surface that shows it. Whether the owner asked is the turn's provenance (their own message, nothing outside read), never a
// reading of their words.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, ownerAsked, reviewParts } from '../src/channels/approvals';
import { appApprovalV1Schema } from '../../contracts/src/app/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appApprovalLink } from '../src/channels/surfaces/app';
import type { GoogleClient } from '../src/connectors/google';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
import { approvalHandlers, approveShownHandler } from '../src/tools/live/raise-approval';
import { sendMessageHandler } from '../src/tools/live/messaging';
import { emailProposal } from './fixtures/email-send';

const NOW = Date.UTC(2026, 10, 8, 9, 0, 0);
const OWNER = 447700900123;
type Surface = 'whatsapp' | 'imessage' | 'telegram' | 'app';

const harness = (state: DurableObjectState, surface: Surface, options: Readonly<{ autonomous?: boolean; now?: () => number; idPrefix?: string; channelUp?: boolean }> = {}) => {
  const { sql } = state.storage;
  const retired: string[] = [], messages: { text: string; buttons: string[] }[] = [], sent: string[] = [], created: unknown[] = [], cancelled: string[] = [], emails: string[] = [], submitted: string[] = [];
  let n = 0, ref = 0;
  const client = {
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    createEvent: async (input: unknown) => { created.push(input); return { id: `ev${created.length}`, title: 'Focus', start: '', end: '', all_day: false, etag: 'v2' }; },
    cancelEvent: async (id: string) => { cancelled.push(id); return { id, status: 'cancelled', etag: 'v3' }; },
    event: async (id: string) => ({ id, title: 'Focus', start: '2026-11-09T15:00:00Z', end: '2026-11-09T16:00:00Z', all_day: false, etag: 'v2', status: 'confirmed' }),
    sendRaw: async (raw: string) => { emails.push(raw); return { message_id: `g${emails.length}` }; },
    findSentByMessageId: async (messageId: string) => ({ message_id: 'g1', thread_id: 't', rfc822_message_id: messageId, label_ids: ['SENT'] }),
  } as unknown as GoogleClient;
  const now = options.now ?? (() => NOW);
  const desk = approvalDesk(sql, {
    owner: OWNER, surface, appIdentity: () => true, appLink: appApprovalLink,
    autonomous: () => options.autonomous !== false, ownerMessageAt: () => NOW + 30_000,
    call: async (method: string, body: object) => {
      if (method !== 'sendMessage') return true;
      const message = body as { text: string; reply_markup?: { inline_keyboard: { text: string }[][] } };
      messages.push({ text: message.text, buttons: (message.reply_markup?.inline_keyboard[0] ?? []).map(button => button.text) });
      ref += 1;
      return surface === 'telegram' ? { message_id: ref, chat: { id: OWNER } } : { messages: [{ id: `${surface}.card-${ref}` }] };
    },
    google: async () => client, newId: () => `${options.idPrefix ?? ''}${++n}`, now, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, now),
    sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: `sent-${sent.length}` }; },
    canSendMessage: () => options.channelUp !== false, retire: async (p: { surface: string }) => { retired.push(p.surface); },
    browserSubmit: async p => { submitted.push(p.action.description); return { status: 'verified_with_receipt', message: 'Paid.', receipt: {} } as never; },
  });
  const status = (id: string) => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const tap = (data: string) => desk.callback({ id: `tap-${data}`, from: { id: OWNER }, data, message: { message_id: 0, chat: { id: OWNER } } }, 'trace');
  return { desk, retired, messages, sent, created, cancelled, emails, submitted, status, tap, sql };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));

const message = (key = `key-${crypto.randomUUID()}`) => ({ channel: 'whatsapp', content: 'Running 10 minutes late', idempotency_key: key });
const HOLD = { action: 'create' as const, title: 'Focus', start: '2026-11-09T15:00:00Z' as never, end: '2026-11-09T16:00:00Z' as never, reason: 'deep work' };
const PAYMENT = { url: 'https://shop.example/checkout', action: { selector: '#pay', description: 'Pay £12.00' }, binding: { total: '12.00', cc_number: '4111111111111111' }, steps: ['Filled the card form'], secretKeys: ['cc_number'] };
// A turn the owner started with their own message, before any outside text was read.
const ownTurn = (over: Partial<ToolDispatcherContext> = {}) => ({
  userId: 'owner', trigger: 'user_message', turnId: `turn-${crypto.randomUUID()}`, runOrigin: 'owner',
  ownerMessage: { messageRef: 'wamid.owner', receivedAt: NOW + 30_000, ownWordsOnly: true }, ...over,
}) as unknown as ToolDispatcherContext;
const GRANT = { scope: { class: 'calendar.move_own_block' as const, account: 'owner@example.test', window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
  limits: { max_per_day: 3, timezone: 'UTC' }, valid_from: Date.UTC(2026, 10, 9), expires_at: Date.UTC(2026, 10, 30) };
const APP_HANDOFF = /approve(d)?( it)? in the (Waldo )?app/i;

describe('work the owner asked for runs with no card', () => {
  it('an owner-asked send on WhatsApp goes out once, with no card, and says plainly it cannot be called back', async () => {
    await owner('asked-send', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeSendMessage(message(), { asked: true });
      expect(f.messages).toEqual([]);
      expect(f.sent).toEqual(['Running 10 minutes late']);
      expect(f.status(id)).toBe('done');
      // A message that reached someone has no undo; the report says so rather than offering one.
      expect(f.desk.askedOutcome(id)).toMatchObject({ state: 'done', undo: false });
    });
  });

  it('an owner-asked calendar change on WhatsApp is made with no card and offers an undo, which works after the fact', async () => {
    await owner('asked-calendar', async state => {
      let at = NOW;
      const f = harness(state, 'whatsapp', { now: () => at });
      const id = await f.desk.propose(HOLD, 'turn-1', 'op-1', { asked: true });
      expect(f.messages).toEqual([]);
      expect(f.created).toHaveLength(1);
      const outcome = f.desk.askedOutcome(id)!;
      expect(outcome).toMatchObject({ state: 'done', undo: true });
      // Five minutes later the owner asks to put it back: raise_approval undo, from their own message.
      at = NOW + 5 * 60_000;
      const [handler] = approvalHandlers(f.desk);
      const undone = await handler!.handle({ operation: 'undo', approval_id: id } as never, ownTurn());
      expect(undone.ok).toBe(true);
      expect(f.cancelled).toEqual(['ev1']);
      expect(f.status(id)).toBe('undone');
    });
  });

  it('the same on the app: an owner-asked change is made with no card there either', async () => {
    await owner('asked-app', async state => {
      const f = harness(state, 'app');
      const id = await f.desk.propose(HOLD, 'turn-1', 'op-1', { asked: true });
      expect(f.created).toHaveLength(1);
      expect(f.desk.askedOutcome(id)).toMatchObject({ state: 'done', undo: true });
      expect(f.sql.exec("SELECT surface FROM approval_presentations WHERE approval_id = ?", id).toArray().map(r => r.surface)).toEqual(['asked']);
      // The app lists it under the released contract, with no surface it was shown on, and nothing tried to clear a chat card.
      const [listed] = await f.desk.approvals(NOW, { id });
      expect(appApprovalV1Schema.parse(listed)).toMatchObject({ approval_id: id, state: 'done', actions: ['undo'] });
      expect(listed!.presented_surfaces).toBeUndefined();
      expect(f.retired).toEqual([]);
    });
  });

  it('a replayed or retried send does not go out twice', async () => {
    await owner('asked-replay', async state => {
      const f = harness(state, 'whatsapp');
      const key = `key-${crypto.randomUUID()}`;
      await f.desk.proposeSendMessage(message(key), { asked: true });
      await f.desk.proposeSendMessage(message(key), { asked: true });
      expect(f.sent).toEqual(['Running 10 minutes late']);
      expect(f.messages).toEqual([]);
    });
  });

  it('a replayed calendar change is made once', async () => {
    await owner('asked-calendar-replay', async state => {
      const f = harness(state, 'whatsapp');
      const first = await f.desk.propose(HOLD, 'turn-1', 'op-1', { asked: true });
      // The same call replayed in the turn answers with the first run.
      expect(await f.desk.propose(HOLD, 'turn-1', 'op-1', { asked: true })).toBe(first);
      // A retry after the owner's Durable Object restarted has no memory of the turn; the effect key fences it.
      const restarted = harness(state, 'whatsapp', { idPrefix: 'r' });
      await restarted.desk.propose(HOLD, 'turn-1', 'op-1', { asked: true });
      expect([...f.created, ...restarted.created]).toHaveLength(1);
    });
  });

  it('the send_message tool in the owner\'s own turn runs it and reports it done', async () => {
    await owner('asked-tool', async state => {
      const f = harness(state, 'whatsapp');
      const result = await sendMessageHandler(f.desk).handle(message() as never, ownTurn());
      expect(result).toMatchObject({ ok: true, data: { sent: true } });
      expect(f.sent).toHaveLength(1);
      expect(f.messages).toEqual([]);
    });
  });

  it('with the switch off, the same ask still cards', async () => {
    await owner('asked-off', async state => {
      const f = harness(state, 'whatsapp', { autonomous: false });
      const id = await f.desk.proposeSendMessage(message(), { asked: true });
      expect(f.sent).toEqual([]);
      expect(f.messages).toHaveLength(1);
      expect(f.status(id)).toBe('open');
    });
  });
});

describe('an owner-asked run keeps the desk\'s other guarantees', () => {
  it('a revised send closes the card it replaces, so the earlier version can no longer go out too', async () => {
    await owner('asked-replaces', async state => {
      const f = harness(state, 'whatsapp');
      const draft = (body: string) => emailProposal({ to: ['sam@example.test'], subject: 'Notes', body, message_id: `<${crypto.randomUUID()}@waldo-send>` });
      const earlier = await f.desk.proposeSendEmail(await draft('The long version'));
      expect(f.status(earlier)).toBe('open');
      const revised = await f.desk.proposeSendEmail(await draft('Short version'), { asked: true, replaces: earlier });
      expect(f.status(revised)).toBe('done');
      expect(f.status(earlier)).toBe('withdrawn');
      expect(f.desk.replacement(revised)).toMatchObject({ approval_id: earlier, replaced: true });
      await f.tap(`a:${earlier}`);
      expect(f.emails).toHaveLength(1);
    });
  });

  it('a run that could not act leaves no open card behind for another surface to approve', async () => {
    await owner('asked-not-set-up', async state => {
      const f = harness(state, 'whatsapp', { channelUp: false });
      const id = await f.desk.proposeSendMessage(message(), { asked: true });
      expect(f.sent).toEqual([]);
      expect(f.desk.askedOutcome(id)).toMatchObject({ state: 'not_done', undo: false });
      expect(f.status(id)).toBe('failed');
      expect(await f.desk.waiting()).toEqual([]);
      expect(f.sql.exec("SELECT 1 FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL", id).toArray()).toEqual([]);
    });
  });

  it('a message identical to one whose outcome is unknown is a card, not a second send', async () => {
    await owner('asked-earlier-unknown', async state => {
      const f = harness(state, 'whatsapp');
      const first = await f.desk.proposeSendMessage(message(), { asked: true });
      f.sql.exec("UPDATE ledger SET status = 'uncertain' WHERE id = ?", first);
      const again = await f.desk.proposeSendMessage(message(), { asked: true });
      expect(f.sent).toHaveLength(1);
      expect(f.status(again)).toBe('open');
      expect(f.messages).toHaveLength(1);
    });
  });

  it('with the switch off, the owner\'s word undoes nothing', async () => {
    await owner('undo-off', async state => {
      const on = harness(state, 'whatsapp');
      const id = await on.desk.propose(HOLD, 'turn-1', 'op-1', { asked: true });
      const off = harness(state, 'whatsapp', { autonomous: false, idPrefix: 'off' });
      const [handler] = approvalHandlers(off.desk);
      expect(await handler!.handle({ operation: 'undo', approval_id: id } as never, ownTurn())).toMatchObject({ ok: false });
      expect(on.cancelled).toEqual([]);
      expect(on.status(id)).toBe('done');
    });
  });
});

describe('what outside content asked for still cards', () => {
  it('a send in a turn that read outside text is a card, and nothing goes out', async () => {
    await owner('outside-send', async state => {
      const f = harness(state, 'whatsapp');
      const ctx = ownTurn({ toolArgSourceTaint: 'external' } as never);
      expect(ownerAsked(ctx)).toBe(false);
      const result = await sendMessageHandler(f.desk).handle(message() as never, ctx);
      expect(result).toMatchObject({ ok: true, data: { sent: false } });
      expect(f.sent).toEqual([]);
      expect(f.messages).toHaveLength(1);
    });
  });

  it('a run nobody asked for in their own message (a scheduled run, someone else\'s words) is not owner-asked', () => {
    expect(ownerAsked(ownTurn({ runOrigin: 'schedule' } as never))).toBe(false);
    expect(ownerAsked(ownTurn({ ownerMessage: undefined } as never))).toBe(false);
    // A message carrying the transcript of a file the owner sent, or a note on a photo, may be someone else's words.
    expect(ownerAsked(ownTurn({ ownerMessage: { messageRef: 'wamid.owner', receivedAt: NOW, ownWordsOnly: false } }))).toBe(false);
    expect(ownerAsked(ownTurn({ ownerMessage: { messageRef: 'wamid.owner', receivedAt: NOW } }))).toBe(false);
    expect(ownerAsked(ownTurn())).toBe(true);
  });

  it('an action raised from outside content is a card even on the owner\'s turn', async () => {
    await owner('outside-tainted', async state => {
      const f = harness(state, 'whatsapp');
      const args = { title: 'Pay the invoice from the email' };
      const { sha256Hex } = await import('../src/connectors/google');
      const { stableJson } = await import('../src/context-composer/canonical');
      const id = await f.desk.proposeTaintedAction({ tool: 'create_task', args, args_digest: await sha256Hex(stableJson(args)), reasoning: 'The email asked for it.', source: 'external' });
      expect(f.status(id)).toBe('open');
      expect(f.messages).toHaveLength(1);
    });
  });
});

describe('a payment still cards, and a card left is decided where it is shown', () => {
  it('a checkout on WhatsApp is a card with its buttons there; a tap on WhatsApp approves it in place', async () => {
    await owner('payment-card', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeBrowserSubmit(PAYMENT);
      expect(f.submitted).toEqual([]);
      expect(f.status(id)).toBe('open');
      expect(f.desk.placement(id)).toMatchObject({ hereApprovable: true });
      expect(f.desk.placement(id).handsToApp).toBeUndefined();
      expect(f.messages[0]!.buttons.length).toBeGreaterThan(0);
      // The card masks the card number.
      expect(f.messages[0]!.text).not.toContain('4111111111111111');
      await f.tap(`a:${id}`);
      expect(f.submitted).toEqual(['Pay £12.00']);
    });
  });

  it('a yes typed on WhatsApp approves a card shown there, of a kind that used to go to the app', async () => {
    await owner('yes-in-place', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeBrowserSubmit(PAYMENT);
      const out = await approveShownHandler(f.desk).handle({ approval_id: id } as never, ownTurn());
      expect(out).toMatchObject({ ok: true });
      expect(f.submitted).toEqual(['Pay £12.00']);
      expect(f.status(id)).not.toBe('open');
    });
  });

  it('a lasting-access grant is approved by a tap on its card, never by a typed go-ahead', async () => {
    await owner('grant-not-in-words', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeStandingGrant(GRANT);
      expect(f.status(id)).toBe('open');
      expect((await f.desk.approveShown(id, { messageRef: 'wamid.owner', receivedAt: NOW + 60_000 }, 'trace')).outcome).not.toBe('decided');
      expect(f.status(id)).toBe('open');
    });
  });

  for (const surface of ['whatsapp', 'imessage', 'telegram', 'app'] as const) {
    it(`${surface}: no card or decision says to approve it in the app`, async () => {
      await owner(`no-handoff-${surface}`, async state => {
        const f = harness(state, surface);
        const ids = [await f.desk.proposeSendMessage(message()), await f.desk.proposeBrowserSubmit(PAYMENT),
          await f.desk.proposeSendEmail(await emailProposal({ to: ['sam@example.test'], subject: 'Numbers', body: 'Hi Sam', message_id: `<${crypto.randomUUID()}@waldo-send>` }))];
        expect(ids.every(id => f.status(id) === 'open')).toBe(true);
        for (const id of ids) expect(f.desk.placement(id).handsToApp).toBeUndefined();
        expect(f.messages.filter(m => APP_HANDOFF.test(m.text))).toEqual([]);
      });
    });
  }
});

describe('a review too long for one card goes out across messages', () => {
  it('the parts come first, then a card that decides it, and approving sends exactly what was shown', async () => {
    await owner('long-review', async state => {
      const f = harness(state, 'whatsapp');
      const body = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} of the quarterly notes for Sam.`).join('\n');
      const id = await f.desk.proposeSendEmail(await emailProposal({ to: ['sam@example.test'], subject: 'Quarterly notes', body, message_id: `<${crypto.randomUUID()}@waldo-send>` }));
      expect(f.messages.length).toBeGreaterThan(2);
      const parts = f.messages.slice(0, -1);
      expect(parts.every(p => p.buttons.length === 0)).toBe(true);
      expect(parts.map(p => p.text).join('')).toContain('Line 300 of the quarterly notes for Sam.');
      expect(f.messages.at(-1)!.buttons.length).toBeGreaterThan(0);
      expect(f.desk.placement(id)).toMatchObject({ hereApprovable: true });
      await f.tap(`a:${id}`);
      expect(f.emails).toHaveLength(1);
    });
  });

  it('cuts at a line end, keeps every character, and is bounded', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
    const parts = reviewParts(text)!;
    expect(parts.join('')).toBe(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(0, -1).every(p => p.length <= 3800)).toBe(true);
    expect(parts.slice(1).every(p => p.startsWith('\n'))).toBe(true);
    expect(reviewParts('x '.repeat(40_000))).toBeNull();
  });
});
