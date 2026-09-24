// L1 scenario harness: a scripted LLMGatewayAdapter. The scenario declares the exact tool-call
// rounds and final texts the "model" produces; everything downstream (dispatcher, tools, memory,
// scribe, hop logging) is the production code path. No API key, no judge, no flake.
import type { AdapterResult, LLMResponse, ModelName } from '@waldo/contracts';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../llm/provider';

export type ScriptedRound =
  | Readonly<{ toolCalls: readonly Readonly<{ name: string; arguments?: Record<string, unknown> }>[] }>
  | Readonly<{ text: string }>;

// A rule matches a user turn by its content; its rounds are consumed in order across the tool
// loop. The last round of a rule is normally a text round, which ends the loop.
export type ScriptRule = Readonly<{
  match: RegExp;
  rounds: readonly ScriptedRound[];
}>;

type ScriptedGatewayOptions = Readonly<{
  rules: readonly ScriptRule[];
  // claim_ops replies for the post-turn memory writer. Defaults to a no-op so scenarios that do
  // not care about memory admission stay quiet.
  claimOps?: string;
  // Reply text when no rule matches a reply request. Loud by default so a missing rule fails the
  // scenario instead of silently passing.
  unmatchedText?: string;
  model?: ModelName;
}>;

const response = (model: ModelName, text: string, toolCalls?: LLMResponse['tool_calls']): AdapterResult<LLMResponse> => ({
  ok: true,
  data: {
    model,
    text,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    input_tokens: 10,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    latency_ms: 1,
  },
});

export const scriptedGateway = (options: ScriptedGatewayOptions): LLMGatewayAdapter => {
  const model = options.model ?? WALDO_CHAT_MODEL;
  const queues = new Map<ScriptRule, ScriptedRound[]>();
  let round = 0;
  return {
    async complete(input: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
      const request = input.request;
      if (request.response_format?.name === 'claim_ops') {
        return response(model, options.claimOps ?? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
      }
      const said = request.messages[request.messages.length - 1]?.content ?? '';
      const rule = options.rules.find((candidate) => candidate.match.test(said));
      if (!rule) return response(model, options.unmatchedText ?? `[scripted-gateway: no rule matched "${said.slice(0, 80)}"]`);
      if (!queues.has(rule)) queues.set(rule, [...rule.rounds]);
      const queue = queues.get(rule)!;
      if (queue.length === 0) return response(model, options.unmatchedText ?? `[scripted-gateway: rule ${rule.match} exhausted]`);
      const step = queue.shift()!;
      if ('text' in step) return response(model, step.text);
      return response(model, '', step.toolCalls.map((call, index) => ({
        call_id: `script-${round++}-${index}`,
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      })));
    },
  };
};
