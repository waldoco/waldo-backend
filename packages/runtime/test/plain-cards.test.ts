// A card raised after outside content reads as words on the first screen: what will run, on what, and why it needs the owner.
// The exact call sits under Details in the app. On WhatsApp such a card is approved in the app, so its message carries one
// link there and stays inside the reply buttons' body limit, so its buttons show.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { approvalDesk, type TaintedActionProposal } from '../src/channels/approvals';
import { appApprovalLink } from '../src/channels/surfaces/app';
import { WHATSAPP_REPLY_BODY_MAX, whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { sha256Hex } from '../src/connectors/google';
import { stableJson } from '../src/context-composer/canonical';
import { approveShownHandler } from '../src/tools/live/raise-approval';

const OWNER = 15550004444;
const NOW = Date.UTC(2026, 10, 7, 9, 0, 0);
const proposal = async (tool: string, args: Record<string, unknown>, extra: Partial<TaintedActionProposal> = {}): Promise<TaintedActionProposal> =>
  ({ tool, args, args_digest: await sha256Hex(stableJson(args)), reasoning: 'The Loops alert lists five new signups to look up.', source: 'external', ...extra });
const research = { profile: 'reader', title: 'Five new signups', goal: 'Find each signup on the public web and in my mail.', context: 'Names from the alert.', done_when: 'A line on each.' };

const whatsappDesk = (state: DurableObjectState) => {
  const graph = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ messages: [{ id: `wamid.${graph.mock.calls.length}` }], contacts: [{ wa_id: String(OWNER) }] }));
  const call = whatsappTelegramShim('tok', 'pn1', String(OWNER), graph as unknown as typeof fetch, { replyButtons: true });
  let n = 0;
  const desk = approvalDesk(state.storage.sql, {
    owner: OWNER, surface: 'whatsapp', call, appLink: appApprovalLink, appIdentity: () => true, writesFirstNow: () => true,
    google: async () => null, newId: () => `c${++n}`, now: () => NOW, timezone: 'UTC', log: () => undefined, commit: work => state.storage.transactionSync(work),
    replayTaintedAction: async () => ({ status: 'done', message: '' }),
  });
  const sent = () => graph.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, any>);
  return { desk, sent };
};
const owner = (work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`plain-cards-${crypto.randomUUID()}`)), (_instance, state) => work(state));

describe('a card raised after outside content', () => {
  it('on WhatsApp reads as words, says why in one line, links to the app once, and goes out with its reply buttons', () => owner(async (state) => {
    const { desk, sent } = whatsappDesk(state);
    const id = await desk.proposeTaintedAction(await proposal('start_task', research));
    const [card] = sent();
    expect(card).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
    const body: string = card!.interactive.body.text;
    expect(body.split('\n')[0]).toBe('Do this? Start a background task: "Five new signups".');
    expect(body).toContain('It would read your mail and the web together, after reading outside content.');
    expect(body).not.toContain('start_task');
    expect(body).not.toMatch(/[{}]/);
    expect(body.match(/waldo:\/\/approvals\/\S+/g)).toEqual([`waldo://approvals/${id}`]);
    expect(card!.interactive.action.buttons.map((button: { reply: { title: string } }) => button.reply.title)).toEqual(['Not now', "Don't do this"]);
  }));

  it('keeps its buttons on WhatsApp however long its review is', () => owner(async (state) => {
    const { desk, sent } = whatsappDesk(state);
    const long = Array.from({ length: 20 }, (_, i) => `Memory ${i}: ${'a long remembered sentence about the owner '.repeat(4)}`);
    await desk.proposeTaintedAction(await proposal('forget_memory', { claim_ids: Array.from({ length: 20 }, (_, i) => i + 1), scope_note: 'old notes' }, { preview: long }));
    const [card] = sent();
    expect(card!.type).toBe('interactive');
    expect(card!.interactive.body.text.length).toBeLessThanOrEqual(WHATSAPP_REPLY_BODY_MAX);
    expect(card!.interactive.body.text).toContain('approved in the Waldo app');
  }));

  it('an email card handed to the app keeps its buttons on WhatsApp, its closing lines inside the limit', () => owner(async (state) => {
    const { desk, sent } = whatsappDesk(state);
    const raw = `To: sam@example.test\r\nSubject: Notes\r\nMessage-ID: <notes@waldo-send>\r\n\r\n${'All the notes from today. '.repeat(120)}`;
    await desk.proposeSendEmail({ to: ['sam@example.test'], subject: 'Notes', body: 'All the notes from today. '.repeat(120), message_id: '<notes@waldo-send>', raw, digest: await sha256Hex(raw) } as never);
    const [card] = sent();
    expect(card!.type).toBe('interactive');
    expect(card!.interactive.body.text.length).toBeLessThanOrEqual(WHATSAPP_REPLY_BODY_MAX);
  }));

  it('keeps the exact call one step below the words in the app review', () => owner(async (state) => {
    const { desk } = whatsappDesk(state);
    const id = await desk.proposeTaintedAction(await proposal('start_task', research));
    const review = desk.waiting().find((item) => item.approval_id === id)!.card;
    expect(review.split('\n')[0]).toBe('Do this? Start a background task: "Five new signups".');
    expect(review.indexOf('Details: start_task')).toBeGreaterThan(review.indexOf("Waldo's reasoning"));
    expect(review.slice(review.indexOf('Details: start_task'))).toContain('"profile": "reader"');
  }));

  it('a typed yes on a card approved only by its button is refused, as before, and now points to the button and its link', async () => {
    const handler = approveShownHandler({ approveShown: async () => ({ outcome: 'app_only', link: 'waldo://approvals/p1' }) });
    const result = await handler.handle({ approval_id: 'p1' } as never, { ownerMessage: { messageRef: 'm1', receivedAt: NOW }, runOrigin: 'owner', trigger: 'user_message', toolArgSourceTaint: null } as never);
    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    expect((result as { error: string }).error).toMatch(/never in words\. Nothing was done\./);
    expect((result as { error: string }).error).toContain("Point them to the card's own button, or to it in the Waldo app: waldo://approvals/p1");
  });
});
