import { expect, it } from 'vitest';
import { createOwnerResponder, type OwnerContextIntegration } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { evaluateTurnClaims, unbackedClaimLine } from '../src/hooks/claim-hook';
import { receiptLine } from '../src/hooks/receipt-line';
import { ownerModelAccess, ownerModels } from '../src/llm/owner-routes';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { callTimeLeftMs, THREAD_TITLE_BUDGET_MS } from '../src/llm/time-budget';
import { sendMessageHandler } from '../src/tools/live/messaging';
import { approveShownHandler } from '../src/tools/live/raise-approval';
import { rememberArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema } from '@waldo/contracts';
import { ownerTyped } from './helpers/owner-typed';

// WALDO_CLAIM_CHECK: before the owner's reply goes, a model reads it and names the effects it says were done; code compares
// those names with the turn's receipts, and a claim no accepted receipt backs goes out marked as not confirmed. The model's
// judgment is scripted here; the owner turn, its tool loop and the receipts are real.

const REPLY = 'Sent. Sam knows you are running ten minutes late.';
const SEND = { name: 'send_message', arguments: JSON.stringify({ channel: 'whatsapp', content: 'Running 10 minutes late', idempotency_key: 'a'.repeat(64) }) };
const APPROVE = { name: 'approve_shown', arguments: JSON.stringify({ approval_id: 'pwhatsapp1' }) };
const REMEMBER = { name: 'remember', arguments: JSON.stringify({ kind: 'fact', text: 'Sam is the owner\'s cofounder', evidence_quote: 'tell Sam' }) };
const MODELS = ownerModels(ownerModelAccess('fixture'));
type Call = Readonly<{ name: string; arguments: string }>;
type Send = 'none' | 'sent' | 'failed';
// hangs: the judgment answers only when its call's time is up, as a provider adapter aborts a call at its deadline.
type Judgment = Readonly<{ claims: readonly string[] } | { fails: true } | { hangs: true }>;

const scripted = (calls: Call[], judgment: Judgment) => {
  const judged: LLMGatewayRequest[] = [], replies: LLMGatewayRequest[] = [], timeLeft: number[] = [];
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const answer = (text: string, call?: Call) => ({ ok: true as const, data: { model: request.request.model, text, ...(call ? { tool_calls: [{ call_id: `c${replies.length}`, ...call }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    const format = request.request.response_format?.name;
    if (format === 'done_claims') {
      judged.push(request);
      timeLeft.push(callTimeLeftMs(request.runScope));
      if ('fails' in judgment || 'hangs' in judgment) return { ok: false as const, code: 'transient' as const, error: 'hangs' in judgment ? 'aborted at the call deadline' : 'down', retry: { allowed: false } };
      return answer(JSON.stringify({ claims: judgment.claims.map(effect => ({ effect })) }));
    }
    if (format) return answer('{}');
    replies.push(request);
    const next = calls.shift();
    return next ? answer('', next) : answer(REPLY);
  } };
  return { gateway, judged, replies, timeLeft };
};

// The handler's own outcome, past the argument check: ran counts the calls that reached it.
const sendTool = (send: Send, ran: { count: number }) => ({ ...sendMessageHandler({ proposeSendMessage: async () => 'p1' }), handle: async () => {
  ran.count += 1;
  return send === 'failed' ? { ok: false as const, code: 'rejected', error: 'The channel refused the message.' }
    : { ok: true as const, data: { proposal_id: 'p1', status: 'sent', sent: true }, source_taint: null };
} });
// The real approve_shown handler over a desk that reports a message card approved and carried out.
const approveTool = (ran: { count: number }, state = 'done') => approveShownHandler({ approveShown: async () => {
  ran.count += 1;
  return { outcome: 'decided', decision: { toast: 'Sent', message: 'Sent to Sam.' }, receipt_sent: false, kind: 'message_send', state };
} });
// remember as its handler answers a note it already holds.
const rememberHeld = (ran: { count: number }) => ({ name: 'remember' as const, description: 'Remember a fact.', schema: rememberArgsSchema, trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('remember')),
  handle: async () => { ran.count += 1; return { ok: true as const, data: { status: 'duplicate' }, source_taint: null }; } });

type Options = Readonly<{ calls?: readonly Call[]; tools?: readonly unknown[]; owner?: OwnerContextIntegration; scope?: RunEffectScope; machine?: true }>;
const turnOf = async (send: Send, judgment: Judgment, options: Options = {}) => {
  const { gateway, judged, replies, timeLeft } = scripted([...(send === 'none' ? [] : [SEND]), ...(options.calls ?? [])], judgment);
  const hops: TurnLogEntry[] = [];
  const ran = { count: 0 };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[3] = (entry) => hops.push(entry); args[5] = [sendTool(send, ran), ...(options.tools ?? [])] as never; args[10] = gateway;
  args[21] = options.owner ?? { claimCheck: true };
  const turn = (text: string) => ownerTyped({ traceId: `claim-${crypto.randomUUID()}`, conversationRef: 'owner', surface: 'whatsapp', text, ...(options.scope ? { runScope: options.scope } : {}) });
  const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
  const responder = createOwnerResponder(...args);
  const out = options.machine
    ? await responder.remind(`remind-${crypto.randomUUID()}`, 'owner', 'tell Sam I am running late', time, 'whatsapp')
    : await responder.respond(turn('tell Sam I am running late'), time);
  expect(ran.count).toBe(send === 'none' ? 0 : 1);
  // The next turn, for what the model reads back of this one.
  const next = async () => { await responder.respond(turn('did it go?'), time); return replies.at(-1)!.request.messages.map(message => String(message.content)); };
  return { out, judged, timeLeft, next, checks: hops.filter(entry => entry.hop === 'claim_check') };
};
// The same turn with the switch off: what the owner got before the check existed.
const unchecked = (send: Send, options: Options = {}) => turnOf(send, { claims: [] }, { ...options, owner: {} });
const SENT_CLAIM = ['message_send_proposed'];
const sendEvent = (ok: boolean) => ({ seq: 1, call: { name: 'send_message', args: JSON.parse(SEND.arguments) }, ok });
const runScope = (): RunEffectScope => ({ runId: `run-${crypto.randomUUID()}`, attempt: '1', deadline: Date.now() + 10 * 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() });

it('a reply that says a send went out when no send ran goes out marked as not confirmed', async () => {
  const { out, judged, next, checks } = await turnOf('none', { claims: SENT_CLAIM });
  // The judgment reads the reply the owner would get, on the auxiliary route.
  expect(String(judged[0]!.request.messages.at(-1)!.content)).toContain(REPLY);
  expect(MODELS.auxiliary).not.toBe(MODELS.chat);
  expect(judged.map(request => request.request.model)).toEqual([MODELS.auxiliary]);
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

it('a send the owner approved in chat backs the reply that says it went out', async () => {
  const ran = { count: 0 };
  const approved = { calls: [APPROVE], tools: [approveTool(ran)] };
  const { out, checks } = await turnOf('none', { claims: SENT_CLAIM }, approved);
  expect(ran.count).toBe(1);
  expect(checks).toMatchObject([{ ok: true }]);
  expect(out).toBe((await unchecked('none', approved)).out);
});

it('a card approved in chat whose send then failed does not back the reply that says it went out', async () => {
  const ran = { count: 0 };
  const { checks } = await turnOf('none', { claims: SENT_CLAIM }, { calls: [APPROVE], tools: [approveTool(ran, 'failed')] });
  expect(ran.count).toBe(1);
  expect(checks).toMatchObject([{ ok: false, code: 'message_send_proposed:no_matching_receipt' }]);
});

it('a note remember already held backs the reply that says it is saved', async () => {
  const ran = { count: 0 };
  const held = { calls: [REMEMBER], tools: [rememberHeld(ran)] };
  const { out, checks } = await turnOf('none', { claims: ['memory_stored'] }, held);
  expect(ran.count).toBe(1);
  expect(checks).toMatchObject([{ ok: true }]);
  expect(out).toBe((await unchecked('none', held)).out);
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

it('a turn run in its own scope is checked too', async () => {
  const { out, checks } = await turnOf('none', { claims: SENT_CLAIM }, { scope: runScope() });
  expect(checks).toMatchObject([{ ok: false, code: 'message_send_proposed:no_matching_receipt' }]);
  expect(out).not.toBe((await unchecked('none', { scope: runScope() })).out);
});

it('a machine turn is not checked', async () => {
  const { judged, checks } = await turnOf('none', { claims: SENT_CLAIM }, { machine: true });
  expect(judged).toEqual([]);
  expect(checks).toEqual([]);
});

it('a judgment that fails leaves the reply as it was and says in the trace that it went unchecked', async () => {
  const { out, checks } = await turnOf('none', { fails: true });
  expect(out).toBe((await unchecked('none')).out);
  expect(checks).toMatchObject([{ ok: false, code: 'unchecked' }]);
});

it('the judgment gets an auxiliary call\'s time, not the turn\'s; past it the reply goes unchanged and unchecked', async () => {
  const { out, timeLeft, checks } = await turnOf('none', { hangs: true }, { scope: runScope() });
  expect(timeLeft).toHaveLength(1);
  expect(timeLeft[0]).toBeGreaterThan(0);
  expect(timeLeft[0]).toBeLessThanOrEqual(THREAD_TITLE_BUDGET_MS);
  expect(out).toBe((await unchecked('none', { scope: runScope() })).out);
  expect(checks).toMatchObject([{ ok: false, code: 'unchecked' }]);
});
