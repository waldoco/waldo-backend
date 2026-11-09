import { expect, it } from 'vitest';
import { createOwnerResponder, type OwnerContextIntegration } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { evaluateTurnClaims, unbackedClaimLine } from '../src/hooks/claim-hook';
import { receiptLine } from '../src/hooks/receipt-line';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { sendMessageHandler } from '../src/tools/live/messaging';
import { ownerTyped } from './helpers/owner-typed';

// WALDO_CLAIM_CHECK: before the owner's reply goes, a model reads it and names the effects it says were done; code compares
// those names with the turn's receipts, and a claim no accepted receipt backs goes out marked as not confirmed. The model's
// judgment is scripted here; the owner turn, its tool loop and the receipts are real.

const REPLY = 'Sent. Sam knows you are running ten minutes late.';
const SEND = { name: 'send_message', arguments: JSON.stringify({ channel: 'whatsapp', content: 'Running 10 minutes late', idempotency_key: 'a'.repeat(64) }) };
type Send = 'none' | 'sent' | 'failed';

const scripted = (send: Send, judgment: Readonly<{ claims: readonly string[] } | { fails: true }>) => {
  const judged: LLMGatewayRequest[] = [], replies: LLMGatewayRequest[] = [];
  const calls = send === 'none' ? [] : [SEND];
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const answer = (text: string, call?: typeof SEND) => ({ ok: true as const, data: { model: request.request.model, text, ...(call ? { tool_calls: [{ call_id: 'c1', ...call }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    const format = request.request.response_format?.name;
    if (format === 'done_claims') {
      judged.push(request);
      return 'fails' in judgment ? { ok: false as const, code: 'transient' as const, error: 'down', retry: { allowed: false } } : answer(JSON.stringify({ claims: judgment.claims.map(effect => ({ effect })) }));
    }
    if (format) return answer('{}');
    replies.push(request);
    const next = calls.shift();
    return next ? answer('', next) : answer(REPLY);
  } };
  return { gateway, judged, replies };
};

// The handler's own outcome, past the argument check: ran counts the calls that reached it.
const sendTool = (send: Send, ran: { count: number }) => ({ ...sendMessageHandler({ proposeSendMessage: async () => 'p1' }), handle: async () => {
  ran.count += 1;
  return send === 'failed' ? { ok: false as const, code: 'rejected', error: 'The channel refused the message.' }
    : { ok: true as const, data: { proposal_id: 'p1', status: 'sent', sent: true }, source_taint: null };
} });

const turnOf = async (send: Send, judgment: Readonly<{ claims: readonly string[] } | { fails: true }>, owner: OwnerContextIntegration = { claimCheck: true }) => {
  const { gateway, judged, replies } = scripted(send, judgment);
  const hops: TurnLogEntry[] = [];
  const ran = { count: 0 };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[3] = (entry) => hops.push(entry); args[5] = [sendTool(send, ran)] as never; args[10] = gateway; args[21] = owner;
  const turn = (text: string) => ownerTyped({ traceId: `claim-${crypto.randomUUID()}`, conversationRef: 'owner', surface: 'whatsapp', text });
  const responder = createOwnerResponder(...args);
  const out = await responder.respond(turn('tell Sam I am running late'), async (_hop, work) => work());
  expect(ran.count).toBe(send === 'none' ? 0 : 1);
  // The next turn, for what the model reads back of this one.
  const next = async () => { await responder.respond(turn('did it go?'), async (_hop, work) => work()); return replies.at(-1)!.request.messages.map(message => String(message.content)); };
  return { out, judged, next, checks: hops.filter(entry => entry.hop === 'claim_check') };
};
// The same turn with the switch off: what the owner got before the check existed.
const unchecked = (send: Send) => turnOf(send, { claims: [] }, {});
const SENT_CLAIM = ['message_send_proposed'];
const sendEvent = (ok: boolean) => ({ seq: 1, call: { name: 'send_message', args: JSON.parse(SEND.arguments) }, ok });

it('a reply that says a send went out when no send ran goes out marked as not confirmed', async () => {
  const { out, judged, next, checks } = await turnOf('none', { claims: SENT_CLAIM });
  // The judgment reads the reply the owner would get.
  expect(String(judged[0]!.request.messages.at(-1)!.content)).toContain(REPLY);
  const line = unbackedClaimLine(evaluateTurnClaims([{ seq: 1, effect: 'message_send_proposed' }], []));
  expect(line).not.toBeNull();
  expect(out).toBe(`${REPLY}\n\n${line}`);
  expect(out).not.toBe((await unchecked('none')).out);
  expect(checks).toMatchObject([{ ok: false, code: 'message_send_proposed:no_matching_receipt' }]);
  // The model reads its earlier reply back with the mark, so a later turn does not take the send as done.
  expect(await next()).toContain(`${REPLY}\n\n${line}`);
});

it('the same reply after a send that succeeded goes out unchanged', async () => {
  const { out, judged, checks } = await turnOf('sent', { claims: SENT_CLAIM });
  expect(judged).toHaveLength(1);
  expect(out).toBe((await unchecked('sent')).out);
  expect(out).toBe(`${REPLY}\n\n${receiptLine([sendEvent(true)])}`);
  expect(checks).toMatchObject([{ ok: true }]);
});

it('a send that failed is not done: the reply that says it went out is marked', async () => {
  const { out, checks } = await turnOf('failed', { claims: SENT_CLAIM });
  const line = unbackedClaimLine(evaluateTurnClaims([{ seq: 2, effect: 'message_send_proposed' }], [sendEvent(false)]));
  expect(line).not.toBeNull();
  expect(out).toBe(`${REPLY}\n\n${line}\n\n${receiptLine([sendEvent(false)])}`);
  expect(out).not.toBe((await unchecked('failed')).out);
  expect(checks).toMatchObject([{ ok: false, code: 'message_send_proposed:receipt_failed' }]);
});

it('a reply the model judges to claim nothing is not marked, whatever the turn did', async () => {
  for (const send of ['none', 'failed'] as const) {
    const { out } = await turnOf(send, { claims: [] });
    expect(out).toBe((await unchecked(send)).out);
  }
});

it('with the switch off no judgment is asked for', async () => {
  const { judged, checks } = await unchecked('none');
  expect(judged).toEqual([]);
  expect(checks).toEqual([]);
});

it('a judgment that fails leaves the reply as it was and says in the trace that it went unchecked', async () => {
  const { out, checks } = await turnOf('none', { fails: true });
  expect(out).toBe((await unchecked('none')).out);
  expect(checks).toMatchObject([{ ok: false, code: 'unchecked' }]);
});
