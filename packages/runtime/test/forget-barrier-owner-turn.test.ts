import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { TOOL_PERMISSIONS, browsePageArgsSchema, triggerTypeSchema, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { FORGET_MARKER, WITHHELD_OUTPUT, type ForgetBarrierMode } from '../src/context-composer/forget-barrier';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { memoryHandlers } from '../src/tools/live/memory';
import { ownerTyped } from './helpers/owner-typed';
import { holdTopic } from './helpers/pending-topic';

// While a forget of "coffee" is still being purged, what reaches the model from the tools around it: with the barrier on,
// only the forgotten words and memory items go; with it off, the earlier rule withholds whole reads.

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
const PAGE = 'Cafe guide. The coffee here is strong. Opening hours are 8 to 6. Ask for the window seat.';
const browse = { name: 'browse_page', description: 'fixture browser', schema: browsePageArgsSchema, autonomy_gated: false, trigger_allowlist: allowlist('browse_page'),
  handle: async () => ({ ok: true, data: { text: PAGE }, source_taint: 'external' as const }) };

const scripted = (calls: readonly Readonly<{ name: string; args: Record<string, unknown> }>[]) => {
  const requests: LLMGatewayRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    const call = calls[requests.length - 1];
    if (!call) return { ok: true, data: { ...base, text: 'Done.' } };
    return { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: `call-${requests.length}`, name: call.name, arguments: JSON.stringify(call.args) }] } };
  } };
  return { gateway, lastTurns: () => (requests.at(-1)!.request.tool_turns ?? []).map((turn) => turn.output) };
};

const run = async (name: string, mode: ForgetBarrierMode | undefined, calls: readonly Readonly<{ name: string; args: Record<string, unknown> }>[], text: string) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const memory = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
    memory.add({ kind: 'fact', text: 'Drinks coffee black', evidence: 'coffee', source: 'stated', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-21T08:00:00Z');
    memory.add({ kind: 'fact', text: 'Climbs on Thursdays', evidence: 'climbs', source: 'stated', origin: 'owner', source_ref: 'owner, tg-2' }, '2026-10-21T08:00:00Z');
    holdTopic(state.storage.sql, 'coffee', '2026-10-21T08:00:00Z');
    const { gateway, lastTurns } = scripted(calls);
    const tools = [browse, ...memoryHandlers({ sql: state.storage.sql, store: memory, conversationRef: 'telegram-1', hideHistory: async () => undefined })];
    type Args = Parameters<typeof createOwnerResponder>;
    const args: Args = [{ openaiApiKey: 'fixture-openai', floorReply: true }];
    // The conversation window still carries the topic, so the forget stays pending across the turn.
    args[2] = memory; args[5] = tools as never; args[10] = gateway; args[11] = async () => ({ rewritten: 0, remaining: 1 }); args[16] = ['*'];
    if (mode) args[21] = { forgetBarrier: mode };
    await createOwnerResponder(...args).respond(ownerTyped({ traceId: `${name}-turn`, conversationRef: 'telegram-1', surface: 'telegram', text, memoryWrites: false }), time);
    return lastTurns();
  });

const browseCall = [{ name: 'browse_page', args: { url: 'https://example.com/cafe', instruction: 'read' } }];

it('with the barrier on, a page that mentions the held topic reaches the model with only that word removed', async () => {
  const [output] = await run('barrier-items-page', 'items', browseCall, 'read the cafe page');
  expect(output).toContain(`The ${FORGET_MARKER} here is strong`);
  expect(output).toContain('Opening hours are 8 to 6');
  expect(output).toContain('was removed; the rest is shown');
  expect(output).not.toMatch(/coffee/i);
  expect(output).not.toContain(WITHHELD_OUTPUT);
});

it('with the barrier off (the default), the same page is withheld whole, as before', async () => {
  for (const [name, mode] of [['barrier-default-page', undefined], ['barrier-reads-page', 'reads']] as const) {
    const [output] = await run(name, mode, browseCall, 'read the cafe page');
    expect(output).toContain(WITHHELD_OUTPUT);
    expect(output).not.toContain('Opening hours');
  }
});

it('with the barrier on, a memory read drops the held item and keeps the rest', async () => {
  const [output] = await run('barrier-items-memory', 'items', [{ name: 'read_memory', args: { limit: 10 } }], 'what do you remember?');
  expect(output).toContain('Climbs on Thursdays');
  expect(output).not.toMatch(/coffee/i);
});
