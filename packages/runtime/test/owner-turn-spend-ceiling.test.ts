import { expect, it } from 'vitest';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_SONNET_5_5_MODEL,
  OPENAI_GPT_6_1_TERRA_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  TOOL_PERMISSIONS,
  browsePageArgsSchema,
  triggerTypeSchema,
  type ToolName,
} from '@waldo/contracts';
import { retryTurnText } from '../src/tasks/retry-turn';
import { createOwnerResponder, spendHold, type OwnerSpend } from '../src/channels/owner-turn';
import { MONTHLY_SPEND_CEILING_USD } from '../src/llm/cost-ledger';
import { modelCost } from '../src/llm/pricing';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { costRollup, costRollupDelta } from '../src/observability/cost-rollup';
import { gateTraceEntry } from '../src/observability/trace-privacy';
import { getContextHandler } from '../src/tools/live/get-context';
import { ownerTyped } from './helpers/owner-typed';

// Past the owner's monthly ceiling a turn degrades instead of stopping: the provider clamps every call of the turn to the
// auxiliary route (Luna, then Haiku), paid tools are refused before they run with spend_ceiling_reached, machine turns such as the Brief still go out,
// and a turn keeps the route it started on even when the ceiling is crossed mid-turn.

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-21T08:20:00Z') };
const NOW = Date.UTC(2026, 9, 21, 8, 20);

type Step = Readonly<{ tool: string; args: Record<string, unknown> }> | Readonly<{ text: string }> | 'fail';
const scripted = (steps: readonly Step[], options: Readonly<{ onCall?: () => void; inputTokens?: number }> = {}) => {
  const requests: LLMGatewayRequest[] = [];
  let index = 0;
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    options.onCall?.();
    const step = steps[Math.min(index++, steps.length - 1)]!;
    if (step === 'fail') return { ok: false, code: 'transient', error: 'down' };
    const base = { model: input.request.model, input_tokens: options.inputTokens ?? 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    if ('text' in step) return { ok: true, data: { ...base, text: step.text } };
    return { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: `call-${index}`, name: step.tool, arguments: JSON.stringify(step.args) }] } };
  } };
  return { gateway, requests, models: () => requests.map((request) => request.request.model) };
};

type Args = Parameters<typeof createOwnerResponder>;
const responder = (gateway: LLMGatewayAdapter, spend?: () => OwnerSpend, tools: Args[5] = [], log?: Args[3]) => {
  const args: Args = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', floorReply: true }];
  if (log) args[3] = log;
  args[5] = [getContextHandler(clock), ...tools]; args[10] = gateway; args[16] = ['example.com']; args[18] = ['👌'];
  if (spend) args[21] = { spend };
  return createOwnerResponder(...args);
};
const at = (spentUsd: number) => () => ({ spentUsd, ceilingUsd: MONTHLY_SPEND_CEILING_USD });
const turn = (traceId: string, text = 'what is on today') => ownerTyped({ traceId, conversationRef: 'telegram-1', surface: 'telegram', text, memoryWrites: false });
const memoryKv = () => {
  const rows = new Map<string, unknown>();
  return { get: <T>(key: string) => rows.get(key) as T | undefined, put: <T>(key: string, value: T) => { rows.set(key, structuredClone(value)); }, delete: (key: string) => rows.delete(key) };
};

it('the ceiling is a code value of 25 USD per owner per month', () => {
  expect(MONTHLY_SPEND_CEILING_USD).toBe(25);
});

it('under the ceiling an owner turn runs on the chat model, as before', async () => {
  const { gateway, models } = scripted([{ text: 'Your day is clear.' }]);
  expect(await responder(gateway, at(4)).respond(turn('cap-under'), time)).toBe('Your day is clear.');
  expect(models()).toEqual([OPENAI_GPT_6_1_TERRA_MODEL]);
});

it('a capped owner turn still answers, on the auxiliary model', async () => {
  const { gateway, models } = scripted([{ text: 'Your day is clear.' }]);
  expect(await responder(gateway, at(25)).respond(turn('cap-answers'), time)).toBe('Your day is clear.');
  expect(models()).toEqual([OPENAI_GPT_6_LUNA_MODEL]);
});

it('a capped owner turn whose auxiliary model is down falls back to Haiku, never Terra or Sonnet', async () => {
  const { gateway, models } = scripted(['fail']);
  await responder(gateway, at(30)).respond(turn('cap-over'), time);
  expect(models()[0]).toBe(OPENAI_GPT_6_LUNA_MODEL);
  expect(models()).toContain(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL);
  expect(models()).not.toContain(OPENAI_GPT_6_1_TERRA_MODEL);
  expect(models()).not.toContain(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL);
});

it('crossing the ceiling mid-month: the recorded spend crosses it during a turn, that turn finishes on Terra, the next degrades', async () => {
  // Each call costs a bit over half the ceiling, so the second turn starts under it and ends past it.
  const perMillion = modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: 1_000_000, output: 0, cached: 0 })!.total;
  const inputTokens = Math.ceil(((MONTHLY_SPEND_CEILING_USD * 0.6) / perMillion) * 1_000_000);
  const costs = costRollup({ kv: memoryKv(), call: null, doName: null, newId: () => 'batch' });
  let reads = 0;
  const spend = () => { reads += 1; return { spentUsd: costs.monthSpendUsd(NOW), ceilingUsd: MONTHLY_SPEND_CEILING_USD }; };
  const { gateway, models } = scripted([{ tool: 'get_context', args: {} }, { text: 'Done.' }, { text: 'Second.' }, { text: 'Third.' }], { inputTokens });
  const owner = responder(gateway, spend, [], (entry) => { costs.record(entry, NOW); });

  expect(await owner.respond(turn('mid-1'), time)).toBe('Done.');
  expect(costs.monthSpendUsd(NOW)).toBeGreaterThan(MONTHLY_SPEND_CEILING_USD);
  expect(models()).toEqual([OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_1_TERRA_MODEL]);
  expect(reads).toBe(1);

  expect(await owner.respond(turn('mid-2'), time)).toBe('Second.');
  expect(models().at(-1)).toBe(OPENAI_GPT_6_LUNA_MODEL);
});

it('a Brief still goes out past the ceiling, on the auxiliary model', async () => {
  const { gateway, models } = scripted([{ text: 'Morning: two meetings, one open loop.' }]);
  const reply = await responder(gateway, at(40)).prompt('brief-1', 'telegram-1', 'Write the morning brief.', time);
  expect(reply).toContain('two meetings');
  expect(models()).toEqual([OPENAI_GPT_6_LUNA_MODEL]);
});

it('a retried owner turn (R-4) runs on the owner turn\'s model, and past the ceiling on the auxiliary route', async () => {
  const text = retryTurnText({ message_ref: 'tg-1', text: 'What should I pack for Goa?', conversation_ref: 'telegram-1', said_at: NOW - 600_000, promised_by: NOW + 1_200_000 }, 'Asia/Kolkata');
  const under = scripted([{ text: 'Late answer: light cottons.' }]);
  await responder(under.gateway, at(3)).prompt('retry:job_1', 'telegram-1', text, time, undefined, undefined, undefined, undefined, undefined, undefined, true);
  const capped = scripted([{ text: 'Late answer: light cottons.' }]);
  await responder(capped.gateway, at(40)).prompt('retry:job_1', 'telegram-1', text, time, undefined, undefined, undefined, undefined, undefined, undefined, true);
  // Under the ceiling the late answer gets the model the owner's own turn would have; past it, the cheap route.
  expect(under.models()).toEqual([OPENAI_GPT_6_1_TERRA_MODEL]);
  expect(capped.models()).toEqual([OPENAI_GPT_6_LUNA_MODEL]);
  // A job Waldo starts itself stays on the auxiliary model either way.
  const own = scripted([{ text: 'Brief.' }]);
  await responder(own.gateway, at(3)).prompt('brief-2', 'telegram-1', 'Write the morning brief.', time);
  expect(own.models()).toEqual([OPENAI_GPT_6_LUNA_MODEL]);
});

it('past the ceiling a paid tool is refused before it runs, in the one refusal shape, and the ledger counts the hold', async () => {
  let browsed = 0;
  const browse = { name: 'browse_page', description: 'fixture browser', schema: browsePageArgsSchema, autonomy_gated: false, trigger_allowlist: allowlist('browse_page'),
    handle: async () => { browsed += 1; return { ok: true, data: { text: 'page' }, source_taint: 'external' as const }; } };
  const steps: Step[] = [{ tool: 'browse_page', args: { url: 'https://example.com/hotels', instruction: 'list hotels' } }, { text: 'Searched instead.' }];
  const over = scripted(steps);
  const costs = costRollup({ kv: memoryKv(), call: null, doName: null, newId: () => 'batch' });
  const holds: unknown[] = [];
  const rows: unknown[] = [];
  const log = (entry: Parameters<NonNullable<Args[3]>>[0]) => {
    if (entry.hop === 'spend_hold') { holds.push(entry); rows.push(costRollupDelta(gateTraceEntry(entry, false), NOW)); }
    costs.record(entry, NOW);
  };
  const reply = await responder(over.gateway, at(25), [browse] as never, log).respond(turn('cap-paid', 'find me a hotel'), time);
  expect(browsed).toBe(0);
  expect(reply).toContain('Searched instead.');
  const shown = over.requests.at(-1)!.request.tool_turns!.at(-1)!.output;
  const output = JSON.parse(shown.slice(shown.indexOf('{')).split('\n[')[0]!) as Record<string, unknown>;
  const refusal = spendHold(clock.now());
  expect(output).toMatchObject({ ok: false, error_code: 'spend_ceiling_reached', error: refusal.cause, fix: refusal.fix, retryable: false, reason: 'held' });
  expect(refusal.fix).toContain('web_search and the other read tools still work');
  expect(refusal.fix).toContain('The ceiling resets on 2026-11-01 (UTC).');
  // the hold reached nothing external, so the turn stays untainted
  expect(over.requests.at(-1)!.request.tools?.map((tool) => tool.name)).not.toContain('propose_action');
  expect(holds).toEqual([expect.objectContaining({ code: 'spend_ceiling_reached:browse_page', error_code: 'spend_ceiling_reached', ok: false })]);
  // the row survives the privacy gate with capture off
  expect(rows).toEqual([expect.objectContaining({ kind: 'turn', model: 'held:browse_page', calls: 1, usd: 0 })]);
  // the same call under the ceiling reaches the handler: the hold is the ceiling, not the fixture
  const under = scripted(steps);
  await responder(under.gateway, at(1), [browse] as never).respond(turn('cap-paid-under', 'find me a hotel'), time);
  expect(browsed).toBe(1);
});

it('past the ceiling a delegated child runs on the auxiliary model too', async () => {
  const { gateway, requests } = scripted([{ tool: 'delegate_task', args: { task: 'find what is on my calendar today and report it' } }, { text: 'Child report.' }, { text: 'Here is your day.' }]);
  await responder(gateway, at(25)).respond(turn('cap-child', 'look into my day'), time);
  const tools = (request: LLMGatewayRequest) => (request.request.tools ?? []).map((tool) => tool.name);
  expect(requests.find((request) => !tools(request).includes('delegate_task')), 'the child call ran').toBeDefined();
  expect(requests.map((request) => request.request.model)).toEqual(requests.map(() => OPENAI_GPT_6_LUNA_MODEL));
});

it('without a spend reader nothing changes', async () => {
  const { gateway, models } = scripted([{ text: 'ok' }]);
  await responder(gateway).respond(turn('cap-none'), time);
  expect(models()).toEqual([OPENAI_GPT_6_1_TERRA_MODEL]);
});

// The ceiling sums each call's logged usage through modelCost, so a call's cache writes must reach the log line it sums.
it('a reply call\'s cache writes reach its logged usage, and its cost counts them at the write rate', async () => {
  const entries: Parameters<NonNullable<Args[3]>>[0][] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input) => ({ ok: true, data: { model: input.request.model, text: 'Your day is clear.', input_tokens: 10_000, output_tokens: 5, cache_read_input_tokens: 2_000, cache_write_input_tokens: 7_000, latency_ms: 1 } }) };
  await responder(gateway, at(4), [], (entry) => { entries.push(entry); }).respond(turn('cap-writes'), time);
  const reply = entries.find((entry) => entry.hop === 'llm_reply' && entry.usage);
  expect(reply?.usage).toMatchObject({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: 10_000, cached: 2_000, cache_write: 7_000 });
  expect(modelCost(reply!.usage!)!.total).toBeCloseTo((1_000 * 1 + 2_000 * 0.05 + 7_000 * 1.25 + 5 * 5) / 1e6, 12);
});

const billed = { input_tokens: 4_000, output_tokens: 40, cache_read_input_tokens: 1_000, cache_write_input_tokens: 2_000 };
const attemptEntries = (entries: readonly Parameters<NonNullable<Args[3]>>[0][]) => entries.filter((entry) => entry.hop === 'llm_reply_attempt');

// A failed attempt the provider still billed is spend: the month counts it at the rates of the model that billed it.
it('a fallback turn counts the failed model\'s billed tokens at its own rates, apart from the model that answered', async () => {
  const entries: Parameters<NonNullable<Args[3]>>[0][] = [];
  const costs = costRollup({ kv: memoryKv(), call: null, doName: null, newId: () => 'batch' });
  const gateway: LLMGatewayAdapter = { complete: async (input) => input.request.model === OPENAI_GPT_6_1_TERRA_MODEL
    ? { ok: false, code: 'transient', error: 'down', spent: billed }
    : { ok: true, data: { model: input.request.model, text: 'Your day is clear.', input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 } } };
  const owner = responder(gateway, at(1), [], (entry) => { entries.push(entry); costs.record(entry, NOW); });
  expect(await owner.respond(turn('fallback-billed'), time)).toBe('Your day is clear.');

  const answered = entries.find((entry) => entry.hop === 'llm_reply' && entry.usage);
  expect(answered?.usage).toEqual({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, input: 100, output: 5, cached: 0, web_searches: 0 });
  const failed = attemptEntries(entries);
  expect(failed.length).toBeGreaterThan(0);
  for (const entry of failed) expect(entry).toMatchObject({ ok: false, error_code: 'transient', usage: { model: OPENAI_GPT_6_1_TERRA_MODEL, input: 4_000, output: 40, cached: 1_000, cache_write: 2_000 } });
  const terra = modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: 4_000, output: 40, cached: 1_000, cache_write: 2_000 })!.total;
  const sonnet = modelCost({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, input: 100, output: 5, cached: 0 })!.total;
  expect(costs.monthSpendUsd(NOW)).toBeCloseTo(failed.length * terra + sonnet, 12);
});

it('a turn every provider failed still counts what its attempts billed, though the floor line carries no usage', async () => {
  const entries: Parameters<NonNullable<Args[3]>>[0][] = [];
  const costs = costRollup({ kv: memoryKv(), call: null, doName: null, newId: () => 'batch' });
  const gateway: LLMGatewayAdapter = { complete: async () => ({ ok: false, code: 'transient', error: 'down', spent: billed }) };
  await responder(gateway, at(1), [], (entry) => { entries.push(entry); costs.record(entry, NOW); }).respond(turn('floor-billed'), time);

  expect(entries.find((entry) => entry.hop === 'llm_reply')?.usage).toBeUndefined();
  expect(attemptEntries(entries).length).toBeGreaterThan(1);
  const perAttempt = (model: Parameters<typeof modelCost>[0]['model']) => modelCost({ model, input: 4_000, output: 40, cached: 1_000, cache_write: 2_000 })!.total;
  expect(costs.monthSpendUsd(NOW)).toBeCloseTo(attemptEntries(entries).reduce((sum, entry) => sum + perAttempt(entry.usage!.model), 0), 12);
  expect(costs.monthSpendUsd(NOW)).toBeGreaterThan(0);
});

it('a failed attempt that billed nothing logs no attempt row', async () => {
  const entries: Parameters<NonNullable<Args[3]>>[0][] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input) => input.request.model === OPENAI_GPT_6_1_TERRA_MODEL
    ? { ok: false, code: 'transient', error: 'down' }
    : { ok: true, data: { model: input.request.model, text: 'ok', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 } } };
  await responder(gateway, at(1), [], (entry) => { entries.push(entry); }).respond(turn('fallback-unbilled'), time);
  expect(attemptEntries(entries)).toEqual([]);
});

it('a provider that reports more cache reads and writes than the whole prompt is clamped and flagged once, without its numbers', async () => {
  const entries: Parameters<NonNullable<Args[3]>>[0][] = [];
  const costs = costRollup({ kv: memoryKv(), call: null, doName: null, newId: () => 'batch' });
  const gateway: LLMGatewayAdapter = { complete: async (input) => ({ ok: true, data: { model: input.request.model, text: 'ok', input_tokens: 1_000, output_tokens: 5, cache_read_input_tokens: 600, cache_write_input_tokens: 700, latency_ms: 1 } }) };
  await responder(gateway, at(1), [], (entry) => { entries.push(entry); costs.record(entry, NOW); }).respond(turn('anomaly'), time);
  const anomalies = entries.filter((entry) => entry.hop === 'usage_anomaly');
  expect(anomalies).toHaveLength(1);
  expect(anomalies[0]).toMatchObject({ ok: false, code: 'cache_exceeds_input', provider: 'openai' });
  expect(JSON.stringify(anomalies[0])).not.toMatch(/600|700|1000/);
  expect(costs.monthSpendUsd(NOW)).toBeGreaterThan(0);
});
