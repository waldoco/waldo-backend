// One nightly trial: a fresh synthetic owner, the production responder on the app surface, and
// the scenario's steps. Owner text goes through the reply path, a due reminder through the
// reminder path, as the owner object's alarm drives it.
import { WALDO_CHAT_MODEL, type ModelName } from '@waldo/contracts';
import { createTelegramResponder } from '../../src/channels/telegram-turn';
import { inboundTurn, ownerWords } from '../../src/channels/owner-inbound-turn';
import type { TurnLogEntry } from '../../src/channels/telegram-listener';
import type { LLMGatewayAdapter } from '../../src/llm/provider';
import type { CallBudget } from './budget';
import type { JudgeInput } from './judge';
import { evalWorld, TIMEZONE, type Effect, type WorldSeed } from './world';

export type Step =
  | Readonly<{ say: string }>
  | Readonly<{ advance_to: string }>
  | Readonly<{ fire_due: true }>
  | Readonly<{ health: 'shared' | 'withdrawn' }>;
export type TrialScenario = Readonly<{ id: string; start: string; steps: readonly Step[]; world: WorldSeed }>;
export type TrialRecord = Readonly<{
  status: 'ran' | 'harness_error' | 'budget_exhausted';
  // The class of the error that stopped a harness_error trial, never its message, so a failed night is diagnosable.
  error?: string;
  transcript: JudgeInput['transcript'];
  tools: JudgeInput['tools'];
  // Kept for a local look at one scenario; never written to the scorecard.
  toolOutputs: readonly Readonly<{ name: string; output: string }>[];
  effects: readonly Effect[];
  final_state: unknown;
}>;

// Every model call the responder makes, the memory writer's included, counts against the run's budget.
const metered = (inner: LLMGatewayAdapter, budget: CallBudget): LLMGatewayAdapter => ({
  async complete(request) {
    if (!budget.take('candidate')) return { ok: false, code: 'rate_limited', error: 'the eval call budget is spent' };
    const result = await inner.complete(request);
    if (result.ok) budget.spent('candidate', result.data.input_tokens + result.data.output_tokens);
    return result;
  },
});

export const runTrial = async (scenario: TrialScenario, deps: Readonly<{ gateway: LLMGatewayAdapter; budget: CallBudget; model?: ModelName }>): Promise<TrialRecord> => {
  const world = evalWorld(scenario.world, scenario.start);
  const entries: TurnLogEntry[] = [];
  const model = deps.model ?? WALDO_CHAT_MODEL;
  const responder = createTelegramResponder('eval-key', world.conversation, world.memory, (entry) => entries.push(entry), {}, world.clock,
    world.handlers, model, false, undefined, async () => true, metered(deps.gateway, deps.budget), undefined, undefined, undefined, undefined,
    model, undefined, world.health, undefined, 'app');
  const time = async <T>(_hop: string, work: () => Promise<T>) => work();
  const transcript: { role: 'owner' | 'waldo' | 'world'; text: string }[] = [];
  let status: TrialRecord['status'] = 'ran';
  let error: string | undefined;
  let turn = 0;
  try {
    for (const step of scenario.steps) {
      if ('say' in step) {
        turn += 1;
        transcript.push({ role: 'owner', text: step.say });
        transcript.push({ role: 'waldo', text: await responder.respond(inboundTurn({ updateId: turn, messageId: null, senderId: 1, chatId: 1, sentAt: null, parts: ownerWords(step.say) }), time) });
      } else if ('advance_to' in step) {
        world.advance(step.advance_to);
        transcript.push({ role: 'world', text: `The time is now ${world.localNow()} (${TIMEZONE}).` });
      } else if ('fire_due' in step) {
        for (const reminder of world.due()) {
          world.markFired(reminder.id);
          transcript.push({ role: 'world', text: `The reminder "${reminder.note}" fires.` });
          transcript.push({ role: 'waldo', text: await responder.remind(`${scenario.id}-${reminder.id}`, 1, reminder.note, time) });
        }
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
  const names = new Set(world.handlers.map((handler) => `tool_${handler.name}`));
  const tools = entries.filter((entry) => names.has(entry.hop));
  return {
    status, ...(error ? { error } : {}), transcript,
    tools: tools.map((entry) => ({ name: entry.hop.slice(5), ok: entry.ok })),
    toolOutputs: tools.map((entry) => ({ name: entry.hop.slice(5), output: entry.text?.output ?? '' })),
    effects: world.effects(),
    final_state: world.finalState(),
  };
};
