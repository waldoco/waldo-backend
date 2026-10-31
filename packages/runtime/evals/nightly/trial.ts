// One nightly trial: a fresh synthetic owner, the production responder on the app surface, and
// the scenario's steps. Owner text goes through the reply path, a due reminder through the
// reminder path, as the owner object's alarm drives it.
import { OPENAI_PROVIDER, PROVIDER_OF, WALDO_AUXILIARY_MODEL, WALDO_CHAT_MODEL, type ModelName } from '@waldo/contracts';
import { createTelegramResponder } from '../../src/channels/telegram-turn';
import { isSkip } from '../../src/channels/day-cards';
import type { CardId } from '../../src/prompt/day-cards';
import { inboundTurn, ownerWords } from '../../src/channels/owner-inbound-turn';
import type { TurnLogEntry } from '../../src/channels/telegram-listener';
import type { ForgetBarrierMode } from '../../src/context-composer/forget-barrier';
import type { LLMGatewayAdapter } from '../../src/llm/provider';
import type { FloorTurn } from '../../src/llm/owner-routes';
import { modelCost } from '../../src/llm/pricing';
import { FIND_TOOLS, USE_TOOL } from '../../src/tools/loader';
import type { JobBook, RetryBrief } from '../../src/tasks/jobs';
import { promiseRetry, RETRY_FIRST_TRY_MS, retryTurnText } from '../../src/tasks/retry-turn';
import type { CallBudget } from './budget';
import type { JudgeInput } from './judge';
import { trialSkillBook } from './skills';
import { ownerTurnTrace } from '../../src/channels/owner-turn-envelope';
import { CHAT_REF, evalWorld, TIMEZONE, type Effect, type MemoryMode, type SeedMail, type WorldSeed } from './world';

export type Step =
  | Readonly<{ say: string }>
  | Readonly<{ advance_to: string }>
  | Readonly<{ fire_due: true }>
  // The owner says this while no model is reachable: they get the floor reply's promise, and the retry answers it later.
  | Readonly<{ late_answer: string }>
  | Readonly<{ health: 'shared' | 'withdrawn' }>
  // The owner's derived health moves zone and the health trigger runs, with one structured model call.
  | Readonly<{ health_change: true }>
  // One of the day's cards runs now, as the owner object writes it: the production prompt over the world's calendar.
  | Readonly<{ card: CardId }>
  | Readonly<{ mail_arrives: SeedMail }>
  // A background job reads outside words (a mail's text) and answers with its sourceTaint 'external', as a mail follow-up does.
  | Readonly<{ outside_job: string }>;
// What one trial cost and how the model got there, as counts: never text. rounds are the owner-reply calls (a structured side
// call, the memory writer's among them, is not one); fallback_calls the answers a second provider gave.
export type TrialMetrics = Readonly<{
  calls: number; rounds: number; failed_calls: number; fallback_calls: number;
  find_tools: number; use_tool: number; groups_loaded: number; peak_result_chars: number;
  input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number;
  usd: number; unpriced_calls: number;
}>;
export type TrialScenario = Readonly<{ id: string; start: string; steps: readonly Step[]; world: WorldSeed }>;
export type TrialRecord = Readonly<{
  status: 'ran' | 'harness_error' | 'budget_exhausted';
  // The class of the error that stopped a harness_error trial, never its message, so a failed night is diagnosable.
  error?: string;
  transcript: JudgeInput['transcript'];
  tools: JudgeInput['tools'];
  // Kept for a local look at one scenario; never written to the scorecard.
  toolOutputs: readonly Readonly<{ name: string; output: string }>[];
  // Every request the model was sent, by the owner message it served (0 before the first), for receipts that read what
  // the model was shown. Kept in memory for the trial; never written to the scorecard.
  model_inputs: readonly Readonly<{ turn: number; text: string }>[];
  effects: readonly Effect[];
  final_state: unknown;
  metrics: TrialMetrics;
}>;

const groupsOf = (call: Readonly<{ arguments: string }>): readonly string[] => {
  try {
    const { groups } = JSON.parse(call.arguments || '{}') as { groups?: unknown };
    return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === 'string') : [];
  } catch { return []; }
};

// Every model call the responder makes, the memory writer's included, counts against the run's budget, and the meter keeps
// what each cost. While `outage.down`, no model answers; the provider runtime then gives the owner's own reply its floor line.
const metered = (inner: LLMGatewayAdapter, budget: CallBudget, outage: { down: boolean }, meter: Meter): LLMGatewayAdapter => ({
  async complete(request) {
    if (outage.down) return { ok: false, code: 'transient', error: 'no model is reachable' };
    if (!budget.take('candidate')) return { ok: false, code: 'rate_limited', error: 'the eval call budget is spent' };
    meter.calls += 1;
    if (request.request.response_format === undefined) meter.rounds += 1;
    for (const turn of request.request.tool_turns ?? []) meter.peak_result_chars = Math.max(meter.peak_result_chars, turn.output.length);
    const result = await inner.complete(request);
    if (!result.ok) { meter.failed_calls += 1; return result; }
    const { data } = result;
    budget.spent('candidate', data.input_tokens + data.output_tokens);
    const cacheWrite = data.cache_write_input_tokens ?? 0;
    meter.input_tokens += data.input_tokens; meter.cached_tokens += data.cache_read_input_tokens; meter.cache_write_tokens += cacheWrite; meter.output_tokens += data.output_tokens;
    const cost = modelCost({ model: data.model, input: data.input_tokens, output: data.output_tokens, cached: data.cache_read_input_tokens, cache_write: cacheWrite });
    if (cost) meter.usd += cost.total; else meter.unpriced_calls += 1;
    if (PROVIDER_OF[data.model] !== OPENAI_PROVIDER) meter.fallback_calls += 1;
    for (const call of data.tool_calls ?? []) {
      if (call.name === FIND_TOOLS) { meter.find_tools += 1; for (const group of groupsOf(call)) meter.groups.add(group); }
      else if (call.name === USE_TOOL) meter.use_tool += 1;
    }
    return result;
  },
});

type Meter = { calls: number; rounds: number; failed_calls: number; fallback_calls: number; find_tools: number; use_tool: number; groups: Set<string>; peak_result_chars: number;
  input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number; usd: number; unpriced_calls: number };
const newMeter = (): Meter => ({ calls: 0, rounds: 0, failed_calls: 0, fallback_calls: 0, find_tools: 0, use_tool: 0, groups: new Set(), peak_result_chars: 0,
  input_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0, usd: 0, unpriced_calls: 0 });
const metricsOf = ({ groups, ...meter }: Meter): TrialMetrics => ({ ...meter, groups_loaded: groups.size });

// The forget barrier runs as staging runs it ('items') unless a trial asks for the earlier rule. toolLoader 'harness' is the
// staging loader; fallbackKey opens the route's second-provider step, which the gateway must then be able to serve.
export const runTrial = async (scenario: TrialScenario, deps: Readonly<{ gateway: LLMGatewayAdapter; budget: CallBudget; model?: ModelName; toolSearch?: boolean; toolLoader?: 'harness'; fallbackKey?: string; memory?: MemoryMode; forgetBarrier?: ForgetBarrierMode; memorySelection?: boolean }>): Promise<TrialRecord> => {
  const world = evalWorld(scenario.world, scenario.start, deps.memory);
  await world.ready;
  const entries: TurnLogEntry[] = [];
  const model = deps.model ?? WALDO_CHAT_MODEL;
  let turn = 0;
  const modelInputs: { turn: number; text: string }[] = [];
  const shown: LLMGatewayAdapter = { complete: (request) => { modelInputs.push({ turn, text: JSON.stringify(request.request) }); return deps.gateway.complete(request); } };
  // The floor promise goes through the production promiseRetry, over a book that only keeps the retry brief it writes.
  const outage = { down: false };
  const meter = newMeter();
  let retry: RetryBrief | undefined;
  const retryBook = { create: (input: Readonly<{ brief: RetryBrief }>) => { retry = input.brief; return { job: { brief_json: JSON.stringify(input.brief) } }; } } as unknown as JobBook;
  const floorReply = { promise: (turn: FloorTurn) => promiseRetry(retryBook, turn, TIMEZONE, world.clock.now().getTime()) };
  const skills = trialSkillBook(world.sql);
  // The seeded memory is what the owner had before the trial, which a nightly has reviewed; what the trial writes is new.
  const seeded = new Set((scenario.world.memory ?? []).map((claim) => claim.id));
  const seededReviewed = (claim: Readonly<{ id: number }>) => seeded.has(claim.id);
  const responder = createTelegramResponder({ openaiApiKey: 'eval-key', floorReply, ...(deps.fallbackKey ? { anthropicApiKey: deps.fallbackKey } : {}), ...(deps.toolLoader ? { toolLoader: deps.toolLoader } : deps.toolSearch ? { toolSearch: true } : {}) }, world.conversation, world.memory, (entry) => entries.push(entry), {}, world.clock,
    world.handlers, model, false, undefined, async () => true, metered(shown, deps.budget, outage, meter), undefined, undefined, undefined, undefined,
    WALDO_AUXILIARY_MODEL, undefined, world.health, undefined, 'app', undefined, { forgetBarrier: deps.forgetBarrier ?? 'items', skills: skills.capability, ...(deps.memorySelection ? { memorySelection: { reviewed: () => seededReviewed } } : {}) });
  const time = async <T>(_hop: string, work: () => Promise<T>) => work();
  const transcript: JudgeInput['transcript'][number][] = [];
  let status: TrialRecord['status'] = 'ran';
  let error: string | undefined;
  try {
    for (const step of scenario.steps) {
      if ('say' in step) {
        turn += 1;
        skills.turn(ownerTurnTrace('app', turn));
        transcript.push({ role: 'owner', text: step.say });
        transcript.push({ role: 'waldo', surface: 'chat', text: await responder.respond(inboundTurn({ updateId: turn, messageId: null, senderId: 1, chatId: 1, sentAt: null, parts: ownerWords(step.say) }), time) });
        // The post-reply compaction hook; a store built with compaction off makes it a no-op.
        await responder.compactIfDue?.(CHAT_REF);
      } else if ('advance_to' in step) {
        world.advance(step.advance_to);
        transcript.push({ role: 'world', text: `The time is now ${world.localNow()} (${TIMEZONE}).` });
      } else if ('late_answer' in step) {
        // The owner's turn runs while no model answers, so its floor reply promises a time and writes the retry; the
        // retry then runs as the owner object runs it once a model is back, with the tools an apply turn gets.
        turn += 1;
        skills.turn(ownerTurnTrace('app', turn));
        transcript.push({ role: 'owner', text: step.late_answer });
        outage.down = true;
        retry = undefined;
        try {
          transcript.push({ role: 'waldo', surface: 'chat', text: await responder.respond(inboundTurn({ updateId: turn, messageId: null, senderId: 1, chatId: 1, sentAt: null, parts: ownerWords(step.late_answer) }), time) });
        } finally { outage.down = false; }
        if (!retry) throw new Error('the floor reply wrote no retry');
        world.advance(new Date(world.clock.now().getTime() + RETRY_FIRST_TRY_MS).toISOString());
        transcript.push({ role: 'world', text: `No model answered at the time. The time is now ${world.localNow()} (${TIMEZONE}) and models answer again.` });
        const tools = world.handlers.map((handler) => handler.name).filter((name) => name !== 'start_task' && name !== 'cancel_task');
        skills.turn(`${scenario.id}-retry-${turn}`);
        transcript.push({ role: 'waldo', surface: 'chat', text: await responder.prompt(`${scenario.id}-retry-${turn}`, 1, retryTurnText(retry, TIMEZONE), time, tools as never, undefined, undefined, undefined, undefined, true) });
      } else if ('fire_due' in step) {
        for (const reminder of world.due()) {
          world.markFired(reminder.id);
          skills.turn(`${scenario.id}-${reminder.id}`);
          transcript.push({ role: 'world', text: `The reminder "${reminder.note}" fires.` });
          transcript.push({ role: 'waldo', surface: 'notification', text: await responder.remind(`${scenario.id}-${reminder.id}`, 1, reminder.note, time) });
        }
      } else if ('outside_job' in step) {
        turn += 1;
        transcript.push({ role: 'world', text: `A background job reads this outside text: ${step.outside_job}` });
        const said = await responder.prompt(`${scenario.id}-outside-${turn}`, 1, step.outside_job, time, undefined, undefined, undefined, undefined, 'external');
        transcript.push({ role: 'waldo', surface: 'notification', text: said });
      } else if ('mail_arrives' in step) {
        world.deliver(step.mail_arrives);
        transcript.push({ role: 'world', text: `New mail arrives from ${step.mail_arrives.from}: "${step.mail_arrives.subject}".` });
      } else if ('health_change' in step) {
        const { outcome, proposal, notice } = await world.healthChange((id, prompt, format) => responder.prompt(id, 1, prompt, time, [], async () => undefined, format));
        transcript.push({ role: 'world', text: `The owner's health moves zone and the health trigger runs (${outcome}).` });
        if (proposal) transcript.push({ role: 'waldo', surface: 'notification', text: proposal.reason });
        if (notice) transcript.push({ role: 'waldo', surface: 'notification', text: notice });
      } else if ('card' in step) {
        transcript.push({ role: 'world', text: `The time is ${world.localNow()} (${TIMEZONE}) and the scheduled card ${step.card} runs.` });
        skills.turn(`${scenario.id}-${step.card}`);
        const said = await responder.prompt(`${scenario.id}-${step.card}`, 1, await world.dayCard(step.card), time, undefined, undefined, undefined, undefined, 'external');
        if (!isSkip(said)) transcript.push({ role: 'waldo', surface: 'notification', text: said });
      } else {
        world.shareHealth(step.health === 'shared');
        transcript.push({ role: 'world', text: step.health === 'shared' ? 'The owner shares health data.' : 'The owner withdraws health sharing.' });
      }
      if (deps.budget.exhausted()) { status = 'budget_exhausted'; break; }
    }
  } catch (failure) {
    status = deps.budget.exhausted() ? 'budget_exhausted' : 'harness_error';
    if (status === 'harness_error') error = failure instanceof Error ? failure.constructor.name : typeof failure;
  }
  const names = new Set([...world.handlers, ...skills.capability.handlers].map((handler) => `tool_${handler.name}`));
  const tools = entries.filter((entry) => names.has(entry.hop));
  return {
    status, ...(error ? { error } : {}), transcript,
    tools: tools.map((entry) => ({ name: entry.hop.slice(5), ok: entry.ok })),
    toolOutputs: tools.map((entry) => ({ name: entry.hop.slice(5), output: entry.text?.output ?? '' })),
    model_inputs: modelInputs,
    effects: world.effects(),
    final_state: world.finalState(),
    metrics: metricsOf(meter),
  };
};
