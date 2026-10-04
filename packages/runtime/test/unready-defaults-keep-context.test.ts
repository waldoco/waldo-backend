import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { durableConversationStore } from '../src/channels/conversation-store';
import { claimStore } from '../src/memory/claims';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { createTaskSourceScope } from '../src/channels/task-source-scope';

// F-series first pass on staging (reply-only): "My standup is 09:10." then "What time is the standup?" answered
// "I can't see ... the standup time". A classifier miss leaves the task unready. Tool gating already keeps the owner's
// default read sources on for an unready task (taskSourceAllowed), but the prompt context (earlier turns, memory,
// standing orders, workspace context) used a stricter test that ignored the defaults and withheld them.
const run = (name: string) => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
  const memory = claimStore(state.storage.sql);
  const standingOrders = () => 'DEFAULT_ORDER_SENTINEL';
  const inputs: string[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    if (request.response_format?.name === 'task_source_scope') return { ok: true, data: { text: 'not json', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
    inputs.push(JSON.stringify({ system: request.system, messages: request.messages }));
    return { ok: true, data: { text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
  } };
  const scope = { runId: name, attempt: 'a', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit: () => {}, commit: <T>(work: () => T) => work() };
  const args: Parameters<typeof createOwnerResponder> = ['owner', durableConversationStore(state.storage), memory];
  args[5] = []; args[10] = gateway; args[13] = standingOrders;
  args[8] = { ...toolOutputLedger(state.storage), recent: async () => [] };
  args[17] = async () => null; args[19] = scope;
  args[21] = { sourceScope: createTaskSourceScope(state.storage.sql, name, scope, async () => {}, undefined, ['local', 'workspace', 'web']), requireTaskScope: true };
  const responder = createOwnerResponder(...args);
  for (const [i, text] of ['My standup is 09:10.', 'What time is the standup?'].entries()) {
    await responder.respond({ traceId: `${name}-${i}`, conversationRef: 'owner', surface: 'telegram', text, memoryWrites: false }, (_label, work) => work());
  }
  return inputs;
});

it('an unready task keeps the owner default read context: the earlier turn and standing orders reach the model', async () => {
  const inputs = await run('unready-defaults');
  const last = inputs[inputs.length - 1]!;
  expect(last).toContain('My standup is 09:10.');
  expect(last).toContain('DEFAULT_ORDER_SENTINEL');
});
