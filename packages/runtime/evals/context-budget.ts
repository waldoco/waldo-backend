// What each kind of turn sends the model, measured on recorded trials: `pnpm --filter @waldo/runtime eval:context`.
// Every model call of a trial is captured as the provider would receive it, and split into the tool list, the system prompt,
// the conversation before the latest message, the latest message and the turn context it carries. Prefix share is the
// part of a call's leading bytes (tools, then system, then messages, the order Anthropic caches in) that the call before it
// in the same trial already sent: the most a provider cache could serve, not what one did. Recorded replies call no tools,
// so every turn is one round and the share measures the reuse from one turn, card or job to the next. Tokens are bytes / 4,
// the runtime's own estimate; no provider counted them.
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { TURN_CONTEXT_HEADER } from '../src/prompt/turn-prompt';
import { callBudget } from './nightly/budget';
import { NIGHTLY_SCENARIOS } from './nightly/catalogue';
import { runTrial } from './nightly/trial';

// One scenario per kind of turn the owner's model sees.
export const TURN_TYPES: Readonly<Record<string, string>> = {
  chat: 'v03-week-one-preference',
  task: 't01-calendar-free-hour',
  health_chat: 'h01-low-day-with-wearable',
  long_chat: 'r1-recall-across-day',
  reminder: 't03-reminder',
  day_card: 'h23-brief-heavy-day-low-form',
  health_trigger: 'h1-health-change-card',
  outside_job: 'm13-outside-job-no-health',
};

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export type CallSize = Readonly<{ tools: number; system: number; history: number; message: number; turn_context: number; total: number; prefix_shared: number }>;

export const callSize = (request: LLMGatewayRequest['request'], previous: string | undefined): Readonly<{ size: CallSize; wire: string }> => {
  const tools = request.tools ? JSON.stringify(request.tools) : '';
  const system = request.system ?? '';
  const last = String(request.messages.at(-1)?.content ?? '');
  const at = last.indexOf(TURN_CONTEXT_HEADER);
  const wire = tools + system + JSON.stringify(request.messages);
  let shared = 0;
  if (previous !== undefined) while (shared < wire.length && shared < previous.length && wire.charCodeAt(shared) === previous.charCodeAt(shared)) shared += 1;
  return {
    wire,
    size: {
      tools: bytes(tools), system: bytes(system), history: bytes(JSON.stringify(request.messages.slice(0, -1))), message: bytes(last),
      turn_context: at < 0 ? 0 : bytes(last.slice(at)), total: bytes(wire), prefix_shared: bytes(wire.slice(0, shared)),
    },
  };
};

export type TurnTypeSize = Readonly<{ scenario: string; calls: number; mean: CallSize; est_tokens_per_call: number; prefix_share: number | null }>;

const mean = (sizes: readonly CallSize[]): CallSize => {
  const avg = (key: keyof CallSize) => Math.round(sizes.reduce((sum, size) => sum + size[key], 0) / Math.max(sizes.length, 1));
  return { tools: avg('tools'), system: avg('system'), history: avg('history'), message: avg('message'), turn_context: avg('turn_context'), total: avg('total'), prefix_shared: avg('prefix_shared') };
};

export const measure = async (menu: Readonly<{ toolLoader?: 'harness'; promptV2?: boolean }>): Promise<Readonly<Record<string, TurnTypeSize>>> => {
  const out: Record<string, TurnTypeSize> = {};
  for (const [type, id] of Object.entries(TURN_TYPES)) {
    const scenario = NIGHTLY_SCENARIOS.find((entry) => entry.id === id);
    if (!scenario) throw new Error(`no scenario ${id}`);
    const sizes: CallSize[] = [];
    let previous: string | undefined;
    const inner = scriptedGateway({ rules: [], unmatchedText: 'Recorded reply.' });
    const gateway: LLMGatewayAdapter = { complete: (input) => {
      // The memory writer's structured calls are not the owner's model; they are measured with the nightly memory pass.
      if (input.request.response_format?.name !== 'claim_ops') {
        const { size, wire } = callSize(input.request, previous);
        sizes.push(size);
        previous = wire;
      }
      return inner.complete(input);
    } };
    await runTrial(scenario, { gateway, budget: callBudget(10_000), model: WALDO_CHAT_MODEL, ...menu });
    const later = sizes.slice(1);
    const shared = later.reduce((sum, size) => sum + size.prefix_shared, 0);
    const total = later.reduce((sum, size) => sum + size.total, 0);
    const avg = mean(sizes);
    out[type] = { scenario: id, calls: sizes.length, mean: avg, est_tokens_per_call: Math.round(avg.total / 4), prefix_share: total ? Number((shared / total).toFixed(3)) : null };
  }
  return out;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const runs = {
    'production menu, v1': await measure({}),
    'production menu, v2': await measure({ promptV2: true }),
    'staging harness, v1': await measure({ toolLoader: 'harness' }),
    'staging harness, v2': await measure({ toolLoader: 'harness', promptV2: true }),
  };
  console.log(JSON.stringify(runs, null, 2));
}
