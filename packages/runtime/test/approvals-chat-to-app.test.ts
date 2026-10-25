// The owner's one approval rule on the chat surfaces. A send to another person, and every other kind the app gates behind
// the recent email check, is never approved in iMessage or WhatsApp: its chat card offers no approval and links to the app,
// and no chat decision approves it. A change to the owner's own things stays one tap in chat. Telegram, internal only, keeps
// its cards.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, proposalStatus, type ApprovalDesk } from '../src/channels/approvals';
import { STEP_UP_APPROVALS, appApprovalStepUp } from '../src/channels/console-step-up';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { APP_REVIEW_MAX_CHARS, appApprovalLink } from '../src/channels/surfaces/app';
import { whatsappIngressUpdates } from '../src/channels/whatsapp-api';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';
import { stableJson } from '../src/context-composer/canonical';
import { emailProposal } from './fixtures/email-send';

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const OWNER = 447700900123;
const iso = (s: string) => s as never;
type Surface = 'whatsapp' | 'imessage' | 'telegram';

const harness = (state: DurableObjectState, surface: Surface, options: Readonly<{ appLink?: boolean; app?: boolean; event?: Record<string, unknown> }> = {}) => {
  const { sql } = state.storage;
  const cards: { text: string; buttons: string[] }[] = [], sent: string[] = [], created: unknown[] = [];
  let n = 0, ref = 0;
  const client = {
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    event: async (id: string) => ({ id, title: 'Standup', start: '2026-10-26T10:00:00Z', end: '2026-10-26T10:15:00Z', all_day: false, etag: 'v1', ...options.event }),
    createEvent: async (input: unknown) => { created.push(input); return { id: 'ev1', title: 'Focus', start: '', end: '', all_day: false, etag: 'v2' }; },
  } as unknown as GoogleClient;
  const before = { id: 't1', task_list_id: 'l1', title: 'Buy milk', status: 'todo' as const, notes: null, due_date: null, etag: '"e1"', parent: null, deleted: false, assigned: false };
  const desk = approvalDesk(sql, {
    owner: OWNER, surface, appIdentity: () => options.app !== false,...(options.appLink === false ? {} : { appLink: appApprovalLink }),
    call: async (method: string, body: object) => {
      if (method !== 'sendMessage') return true;
      const message = body as { text: string; reply_markup?: { inline_keyboard: { text: string }[][] } };
      cards.push({ text: message.text, buttons: (message.reply_markup?.inline_keyboard[0] ?? []).map(button => button.text) });
      ref += 1;
      return surface === 'telegram' ? { message_id: ref, chat: { id: OWNER } } : { messages: [{ id: `${surface}.card-${ref}` }] };
    },
    google: async () => client, newId: () => String(++n), now: () => NOW, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW),
    sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: `sent-${sent.length}` }; },
    googleTasks: () => ({
      prepare: async () => ({ args: TASK, account: { connection_id: 'conn-1', email: 'owner@example.test' }, list: { id: 'l1', title: 'Errands', etag: '"le"' }, before }),
      apply: async () => ({ status: 'done' }),
    }) as never,
  });
  const presented = (id: string) => sql.exec<{ surface: string; approvable: number }>('SELECT surface, approvable FROM approval_presentations WHERE approval_id = ? ORDER BY surface', id).toArray().map(row => ({ ...row }));
  const status = (id: string) => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  // A chat reply naming an approval, as WhatsApp ingress turns a typed "a:<id>" into a decision.
  const reply = (data: string) => desk.callback({ id: `reply-${data}`, from: { id: OWNER }, data, message: { message_id: 0, chat: { id: OWNER } } }, 'trace');
  return { desk, cards, sent, created, presented, status, reply };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));

const TASK = { source: 'google_tasks' as const, action: 'update' as const, task_list_id: 'l1', task_id: 't1', changes: { title: 'Buy oat milk' }, reason: 'Owner asked' };
const HOLD = { action: 'create' as const, title: 'Focus', start: iso('2026-10-26T15:00:00Z'), end: iso('2026-10-26T16:00:00Z'), reason: 'deep work' };
const email = () => emailProposal({ to: ['sam@example.test'], subject: 'Weekly numbers', body: 'Hi Sam', message_id: `<${crypto.randomUUID()}@waldo-send>` });
const message = (content = 'On my way') => ({ channel: 'whatsapp', content, idempotency_key: `key-${crypto.randomUUID()}` });
const tainted = async () => {
  const args = { title: 'Pay the invoice from the email' };
  return { tool: 'create_task', args, args_digest: await sha256Hex(stableJson(args)), reasoning: 'The email asked for it.', source: 'external' as const };
};
// One proposal for each kind the app's rule classifies. The record is typed by that rule's table, so a new kind does not
// compile here until it has a proposal, and the test below then shows where it is approved.
const PROPOSE: Readonly<Record<keyof typeof STEP_UP_APPROVALS, (desk: ApprovalDesk) => Promise<string>>> = {
  email_send: async desk => desk.proposeSendEmail(await email()),
  message_send: desk => desk.proposeSendMessage(message()),
  calendar_change: desk => desk.propose(HOLD),
  calendar_shared: desk => desk.propose({ ...HOLD, attendees: ['sam@example.test'], send_updates: 'all' }),
  google_task_change: desk => desk.proposeGoogleTaskChange(TASK),
  browser_submit: desk => desk.proposeBrowserSubmit({ url: 'https://shop.example/checkout', action: { selector: '#pay', description: 'Pay' }, binding: { total: '12.00' }, steps: [] }),
  mcp_call: desk => desk.proposeMcpCall({ server: 'crm', tool: 'update_deal', args: { id: 1 } }),
  tainted_action: async desk => desk.proposeTaintedAction(await tainted()),
};
const HANDED_TO_APP = 'It reaches other people or acts beyond your own things, so it is approved in the Waldo app after a recent email check, not in chat.';
const CHANGED_IN_APP = 'It reaches other people or acts beyond your own things, so changes to it are asked for in the Waldo app, not in chat.';

describe('a send proposed in a chat surface is handed to the app', () => {
  for (const surface of ['whatsapp', 'imessage'] as const) {
    it(`${surface}: the card shows the review with no Send and links to the app, where approving needs the recent email check`, async () => {
      await owner(`chat-to-app-send-${surface}`, async state => {
        const f = harness(state, surface);
        const id = await f.desk.proposeSendMessage(message());
        const card = f.cards.at(-1)!;
        expect(card.text).toContain('Send this message on whatsapp?\n\nOn my way');
        expect(card.text).toContain(`${HANDED_TO_APP} Review and approve it there: waldo://approvals/${id}`);
        // iMessage shows no buttons; a card it hands to the app offers no numbers either.
        expect(card.buttons).toEqual(surface === 'imessage' ? [] : ['Not now', "Don't do this"]);
        expect(card.text).not.toContain('Reply 1');
        expect(f.presented(id)).toEqual([{ surface: 'app', approvable: 1 }, { surface, approvable: 0 }]);
        expect(f.status(id)).toBe('open');
        expect(f.desk.placement(id)).toMatchObject({ here: true, hereApprovable: false, appApprovable: true, handsToApp: true });
        expect(proposalStatus(f.desk.placement(id), 'shown here', 'Nothing was sent.'))
          .toBe('The review is shown here, but it is approved only in the Waldo app; the card carries the link. Nothing was sent.');

        const [item] = await f.desk.approvals(NOW, { id });
        expect(item!.actions).toContain('approve');
        expect(appApprovalStepUp(item!, 'approve')).toBe(true);
        expect((await f.desk.decide(id, 'a', 'trace', { surface: 'app' })).toast).toBe('Sent');
        expect(f.sent).toEqual(['On my way']);
      });
    });

    it(`${surface}: an email's card and its receipt hand it to the app, and the console can still approve it`, async () => {
      await owner(`chat-to-app-email-${surface}`, async state => {
        const f = harness(state, surface);
        const id = await f.desk.proposeSendEmail(await email());
        const [card, receipt] = f.cards.slice(-2);
        expect(card!.text).toContain('To: sam@example.test');
        expect(card!.text).toContain(`Review and approve it there: waldo://approvals/${id}`);
        expect(card!.buttons).not.toContain('Send it');
        expect(receipt!.text).toBe(`Email ready for review: the card above has the exact recipients, subject and body. ${HANDED_TO_APP} Review and approve it there: waldo://approvals/${id} Nothing has been sent.`);
        expect(f.presented(id)).toEqual([{ surface: 'app', approvable: 1 }, { surface, approvable: 0 }]);
      });
    });
  }
});

describe('an owner who has not set up the app yet', () => {
  it('still gets the send put in the app, so the link on the card has an approval to open; a hold stays chat only', async () => {
    await owner('chat-to-app-no-app-yet', async state => {
      const f = harness(state, 'whatsapp', { app: false });
      const send = await f.desk.proposeSendMessage(message());
      expect(f.presented(send)).toEqual([{ surface: 'app', approvable: 1 }, { surface: 'whatsapp', approvable: 0 }]);
      expect(f.cards.at(-1)!.text).toContain(`Review and approve it there: waldo://approvals/${send}`);
      const hold = await f.desk.propose(HOLD);
      expect(f.presented(hold)).toEqual([{ surface: 'whatsapp', approvable: 1 }]);
    });
  });
});

describe('a low-risk change to the owner\'s own things stays one tap in chat', () => {
  for (const surface of ['whatsapp', 'imessage'] as const) {
    it(`${surface}: a hold on the owner's own calendar is approved from the chat card, once`, async () => {
      await owner(`chat-hold-${surface}`, async state => {
        const f = harness(state, surface);
        const id = await f.desk.propose(HOLD);
        if (surface === 'imessage') expect(f.cards.at(-1)!.text).toMatch(/Reply 1 to add it, or 2 to skip\.$/);
        else expect(f.cards.at(-1)!.buttons).toEqual(['Do it', 'Modify', 'Not now', "Don't do this"]);
        expect(f.cards.at(-1)!.text).not.toContain('Waldo app');
        expect(f.presented(id)).toEqual([{ surface: 'app', approvable: 1 }, { surface, approvable: 1 }]);
        expect(f.desk.placement(id)).toEqual({ here: true, hereApprovable: true, app: true, appApprovable: true });
        await f.reply(`a:${id}`);
        await f.reply(`a:${id}`);
        expect(f.created).toHaveLength(1);
        expect(f.status(id)).toBe('done');
      });
    });
  }
});

describe('no chat reply approves a gated kind', () => {
  it('a typed approval for a send is refused with the app link, even from a card shown before the rule, and nothing is sent', async () => {
    await owner('chat-to-app-hostile', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeSendMessage(message());
      // A WhatsApp card shown before this rule recorded itself as approving the send.
      state.storage.sql.exec("UPDATE approval_presentations SET approvable = 1 WHERE approval_id = ? AND surface = 'whatsapp'", id);
      await f.reply(`a:${id}`);
      expect(f.cards.at(-1)!.text).toBe(`${HANDED_TO_APP} Nothing was done. Review and approve it in the Waldo app: waldo://approvals/${id}`);
      for (const via of [{ surface: 'whatsapp' as const }, { surface: 'imessage' as const }, { surface: 'whatsapp' as const, messageRef: 'whatsapp.card-1' }]) {
        expect((await f.desk.decide(id, 'a', 'trace', via)).toast).toBe('Review it in the app');
      }
      expect(f.sent).toEqual([]);
      expect(f.status(id)).toBe('open');
    });
  });

  it('a typed Modify for a send says the change is asked for in the app, not that approving needs an email check', async () => {
    await owner('chat-to-app-modify', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeSendMessage(message());
      await f.reply(`e:${id}`);
      expect(f.cards.at(-1)!.text).toBe(`${CHANGED_IN_APP} Nothing was done. Ask for the change in the Waldo app: waldo://approvals/${id}`);
      expect(f.status(id)).toBe('open');
      const noLink = harness(state, 'imessage', { appLink: false });
      expect((await noLink.desk.decide(id, 'e', 'trace', { surface: 'imessage' })).message).toBe(`${CHANGED_IN_APP} Nothing was done. Ask for the change in the Waldo app.`);
      expect(f.status(id)).toBe('open');
    });
  });

  it('a typed Modify for a kind the app cannot change keeps the approve wording', async () => {
    await owner('chat-to-app-modify-unchangeable', async state => {
      const f = harness(state, 'whatsapp');
      const id = await PROPOSE.mcp_call(f.desk);
      expect((await f.desk.approvals(NOW, { id }))[0]!.actions).not.toContain('edit');
      await f.reply(`e:${id}`);
      expect(f.cards.at(-1)!.text).toBe(`${HANDED_TO_APP} Nothing was done. Review and approve it in the Waldo app: waldo://approvals/${id}`);
      expect(f.status(id)).toBe('open');
    });
  });

  it('"yes", "send" and a reaction on WhatsApp are never a decision; only the typed approval form is, and the desk refuses it', () => {
    const subject = String(OWNER);
    const { updates } = whatsappIngressUpdates([
      { from: subject, id: 'w1', type: 'text', text: { body: 'yes' } },
      { from: subject, id: 'w2', type: 'text', text: { body: 'send' } },
      { from: subject, id: 'w3', type: 'reaction', reaction: { message_id: 'wamid.card-1', emoji: '👍' } },
    ] as never, subject, 0);
    expect(updates.map(update => 'callback_query' in update)).toEqual([false, false]);
  });
});

describe('when the app cannot take the approval, the card says so and chat never approves instead', () => {
  it('with no app link, the card names the app without a link and offers no Send', async () => {
    await owner('chat-to-app-no-link', async state => {
      const f = harness(state, 'whatsapp', { appLink: false });
      const id = await f.desk.proposeSendMessage(message());
      expect(f.cards.at(-1)!.text).toContain(`${HANDED_TO_APP} Approve it in the Waldo app.`);
      expect(f.cards.at(-1)!.buttons).toEqual(['Not now', "Don't do this"]);
      expect((await f.desk.decide(id, 'a', 'trace', { surface: 'whatsapp' })).message).toBe(`${HANDED_TO_APP} Nothing was done. Approve it in the Waldo app.`);
      expect(f.sent).toEqual([]);
    });
  });

  it('when the app can only show it, nowhere approves it and the card and the refusal say so', async () => {
    await owner('chat-to-app-unapprovable', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeSendMessage(message('x'.repeat(APP_REVIEW_MAX_CHARS + 1)));
      const cant = "It can't be approved in the Waldo app either, so it can't be approved at all. Nothing was done.";
      expect(f.cards.at(-1)!.text).toContain(`${HANDED_TO_APP} ${cant}`);
      expect(f.cards.at(-1)!.buttons).toEqual(['Not now', "Don't do this"]);
      expect(f.status(id)).toBe('review_only');
      expect(f.desk.placement(id)).toMatchObject({ hereApprovable: false, appApprovable: false, handsToApp: true });
      expect(proposalStatus(f.desk.placement(id), 'shown here', 'Nothing was sent.')).toBe('It cannot be approved in chat, and the Waldo app cannot approve it either. Nothing was sent.');
      expect((await f.desk.decide(id, 's', 'trace', { surface: 'whatsapp' })).toast).toBe('Not now');
      expect(f.sent).toEqual([]);
    });
  });
});

describe('Telegram, internal only, is unchanged', () => {
  it('a send keeps its Send it card there, approved from it, and no chat card or refusal names Telegram', async () => {
    await owner('chat-to-app-telegram', async state => {
      const f = harness(state, 'telegram');
      const id = await f.desk.proposeSendMessage(message());
      expect(f.cards.at(-1)!.buttons).toEqual(['Send it', 'Modify', 'Not now', "Don't do this"]);
      expect(f.cards.at(-1)!.text).not.toContain('Waldo app');
      await f.reply(`a:${id}`);
      expect(f.sent).toEqual(['On my way']);
      expect(HANDED_TO_APP).not.toMatch(/telegram/i);
    });
  });
});

describe('a calendar change with guests is handed to the app even when a detail does not fit the app\'s schema', () => {
  it('a move of a guest event whose provider time has no offset still counts its guests', async () => {
    await owner('chat-to-app-offsetless-guests', async state => {
      const f = harness(state, 'whatsapp', { event: { start: '2026-10-26T10:00:00', end: '2026-10-26T10:15:00', attendees: 3 } });
      const id = await f.desk.propose({ action: 'move', event_id: 'e1', title: 'Standup', start: iso('2026-10-27T10:00:00Z'), end: iso('2026-10-27T10:15:00Z'), reason: 'clash' });
      expect(f.cards.at(-1)!.buttons).toEqual(['Not now', "Don't do this"]);
      expect((await f.desk.decide(id, 'a', 'trace', { surface: 'whatsapp' })).toast).toBe('Review it in the app');
    });
  });
});

describe('a request whose stored payload can no longer be classified fails closed in chat', () => {
  for (const surface of ['whatsapp', 'imessage'] as const) {
    it(`${surface}: a one-tap task change whose payload no longer reads as one after its card went out is never approved from chat`, async () => {
      await owner(`chat-to-app-unreadable-${surface}`, async state => {
        const f = harness(state, surface);
        const id = await f.desk.proposeGoogleTaskChange(TASK);
        expect(f.desk.placement(id).hereApprovable).toBe(true);
        // Still JSON, so the request's identity and expiry read; no longer a task proposal, so the app's rule cannot classify it.
        state.storage.sql.exec('UPDATE ledger SET payload_json = ? WHERE id = ?', JSON.stringify({ operation_ref: `approval:${id}` }), id);
        expect(f.desk.placement(id)).toMatchObject({ handsToApp: true });
        const refused = await f.desk.decide(id, 'a', 'trace', { surface });
        expect(refused).toEqual({ toast: 'Review it in the app', message: `${HANDED_TO_APP} Nothing was done. It can't be approved in the Waldo app either, so it can't be approved at all.` });
        await f.reply(`a:${id}`);
        expect(f.status(id)).toBe('open');
      });
    });
  }
});

describe('every approval kind is either one tap in chat or handed to the app, by the app\'s own rule', () => {
  for (const surface of ['whatsapp', 'imessage'] as const) {
    for (const kind of Object.keys(STEP_UP_APPROVALS) as (keyof typeof STEP_UP_APPROVALS)[]) {
      it(`${surface}: ${kind}`, async () => {
        await owner(`chat-kind-${surface}-${kind}`, async state => {
          const f = harness(state, surface);
          const id = await PROPOSE[kind](f.desk);
          const [item] = await f.desk.approvals(NOW, { id });
          const gated = appApprovalStepUp(item!, 'approve');
          expect(gated).toBe(STEP_UP_APPROVALS[kind].gated);
          const card = f.cards[0]!;
          expect(card.buttons.some(label => label === 'Do it' || label === 'Send it') || /Reply 1 to /.test(card.text)).toBe(!gated);
          expect(f.desk.placement(id).hereApprovable).toBe(!gated);
          const decided = await f.desk.decide(id, 'a', 'trace', { surface });
          expect(decided.toast === 'Review it in the app').toBe(gated);
        });
      });
    }
  }
});
