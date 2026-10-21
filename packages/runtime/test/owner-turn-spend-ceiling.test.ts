import { expect, it } from 'vitest';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_OPUS_5_5_MODEL,
  OPENAI_GPT_6_1_SOL_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  TOOL_PERMISSIONS,
  browsePageArgsSchema,
  triggerTypeSchema,
  type ToolName,
} from '@waldo/contracts';
import { createOwnerResponder, SPEND_CEILING_HELD } from '../src/channels/owner-turn';
import { spendPosture } from '../src/llm/cost-ledger';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { getContextHandler } from '../src/tools/live/get-context';
import { ownerTyped } from './helpers/owner-typed';

// Past the owner's monthly ceiling a turn degrades instead of stopping: the owner's own turn runs on the auxiliary
// model with its own fallback, paid tools answer with a refusal the model can pass on, and a turn keeps the model it
// started on even when the ceiling is crossed mid-turn.

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-21T08:20:00Z') };

type Step = Readonly<{ tool: string; args: Record<string, unknown> }> | Readonly<{ text: string }> | 'fail';
const scripted = (steps: readonly Step[], onCall: () => void = () => undefined) => {
  const requests: LLMGatewayRequest[] = [];
  let index = 0;
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    onCall();
    const step = steps[Math.min(index++, steps.length - 1)]!;
    if (step === 'fail') return { ok: false, code: 'transient', error: 'down' };
    const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    if ('text' in step) return { ok: true, data: { ...base, text: step.text } };
    return { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: `call-${index}`, name: step.tool, arguments: JSON.stringify(step.args) }] } };
  } };
  return { gateway, requests, models: () => requests.map((request) => request.request.model) };
};

const responder = (gateway: LLMGatewayAdapter, spend?: () => ReturnType<typeof spendPosture>, tools: Parameters<typeof createOwnerResponder>[5] = []) => {
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', floorReply: true }];
  args[5] = [getContextHandler(clock), ...tools]; args[10] = gateway; args[16] = ['example.com']; args[18] = ['👌'];
  if (spend) args[21] = { spend };
  return createOwnerResponder(...args);
};
const turn = (traceId: string, text = 'what is on today') => ownerTyped({ traceId, conversationRef: 'telegram-1', surface: 'telegram', text, memoryWrites: false });

it('under the ceiling an owner turn runs on the chat model, as before', async () => {
  const { gateway, models } = scripted([{ text: 'Your day is clear.' }]);
  const reply = await responder(gateway, () => spendPosture(4, 10)).respond(turn('cap-under'), time);
  expect(reply).toBe('Your day is clear.');
  expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL]);
});

it('past the ceiling an owner turn runs on the auxiliary model, and its fallback is the auxiliary fallback, not Opus', async () => {
  const { gateway, models } = scripted(['fail']);
  await responder(gateway, () => spendPosture(10, 10)).respond(turn('cap-over'), time);
  expect(models()[0]).toBe(OPENAI_GPT_6_LUNA_MODEL);
  expect(models()).toContain(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL);
  expect(models()).not.toContain(OPENAI_GPT_6_1_SOL_MODEL);
  expect(models()).not.toContain(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL);
});

it('past the ceiling the turn still answers: degraded, not failed', async () => {
  const { gateway } = scripted([{ text: 'Your day is clear.' }]);
  expect(await responder(gateway, () => spendPosture(25, 10)).respond(turn('cap-answers'), time)).toBe('Your day is clear.');
});

it('reads the ceiling once per turn: a turn that crosses it mid-flight finishes on the model it began with', async () => {
  let spent = 9.5, reads = 0;
  const { gateway, models } = scripted([{ tool: 'get_context', args: {} }, { tool: 'get_context', args: {} }, { text: 'Done.' }], () => { spent += 1; });
  const owner = responder(gateway, () => { reads += 1; return spendPosture(spent, 10); });
  await owner.respond(turn('cap-midturn'), time);
  expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL]);
  expect(reads).toBe(1);
  // the next turn starts past the ceiling and degrades
  await owner.respond(turn('cap-next'), time);
  expect(models().at(-1)).toBe(OPENAI_GPT_6_LUNA_MODEL);
});

it('past the ceiling a paid tool is held with a refusal the model reads, and the handler never runs', async () => {
  let browsed = 0;
  const browse = { name: 'browse_page', description: 'fixture browser', schema: browsePageArgsSchema, autonomy_gated: false, trigger_allowlist: allowlist('browse_page'),
    handle: async () => { browsed += 1; return { ok: true, data: { text: 'page' }, source_taint: 'external' as const }; } };
  const steps: Step[] = [{ tool: 'browse_page', args: { url: 'https://example.com/hotels', instruction: 'list hotels' } }, { text: 'Browsing is held this month.' }];
  const over = scripted(steps);
  const reply = await responder(over.gateway, () => spendPosture(10, 10), [browse] as never).respond(turn('cap-paid', 'find me a hotel'), time);
  expect(browsed).toBe(0);
  expect(reply).toContain('Browsing is held this month.');
  const output = over.requests.at(-1)!.request.tool_turns?.at(-1)?.output ?? '';
  expect(output).toContain(SPEND_CEILING_HELD);
  // the same call under the ceiling reaches the handler: the hold is the ceiling, not the fixture
  const under = scripted(steps);
  await responder(under.gateway, () => spendPosture(1, 10), [browse] as never).respond(turn('cap-paid-under', 'find me a hotel'), time);
  expect(browsed).toBe(1);
});

it('without a spend reader nothing changes', async () => {
  const { gateway, models } = scripted([{ text: 'ok' }]);
  await responder(gateway).respond(turn('cap-none'), time);
  expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL]);
});

it('past the ceiling a delegated child runs on the auxiliary model too', async () => {
  const { gateway, requests } = scripted([{ tool: 'delegate_task', args: { task: 'find what is on my calendar today and report it' } }, { text: 'Child report.' }, { text: 'Here is your day.' }]);
  await responder(gateway, () => spendPosture(10, 10)).respond(turn('cap-child', 'look into my day'), time);
  const tools = (request: LLMGatewayRequest) => (request.request.tools ?? []).map((tool) => tool.name);
  const child = requests.find((request) => !tools(request).includes('delegate_task'));
  expect(child, 'the child call ran').toBeDefined();
  expect(requests.map((request) => request.request.model)).toEqual(requests.map(() => OPENAI_GPT_6_LUNA_MODEL));
});
