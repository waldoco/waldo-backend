import {
  acceptTrustedInvocation,
  OPENAI_GPT_5_NANO_MODEL,
  OPENAI_PROVIDER,
  routingPolicySchema,
} from '@waldo/contracts';
import {
  localTrustedBriefScheduleInput,
  resolveRunLoopAdapters,
} from '../run-loop/adapters';
import { OpenAIGpt5NanoAdapter, type OpenAIResponseMetadata } from '../llm/openai';
import { RuntimeLLMProvider } from '../llm/provider';
import type { ContextLayer } from '../context-composer/types';

export const LOCAL_CLI_PROVIDER = 'local-fake';
export const LOCAL_CLI_MODEL = 'local-fake-v1';
export const S2_LIVE_PROVIDER = OPENAI_PROVIDER;
export const S2_LIVE_MODEL = OPENAI_GPT_5_NANO_MODEL;

export type LocalChatRequest = Readonly<{
  message: string;
  provider?: string;
  model?: string;
}>;

export type LocalChatTrace = Readonly<{
  provider: string;
  model: string;
  authority: 'fixed-local-trusted-brief';
  context: 'canonical-context-composer';
  memory: 'owner-bound-local-temporal-snapshot';
  tools: readonly string[];
  context_layers: readonly ContextLayer[];
  correction: 'trace-only';
  forget: 'trace-only';
  scheduling: 'trace-only';
  response?: OpenAIResponseMetadata;
}>;

export type LocalChatResult =
  | Readonly<{
      ok: true;
      text: string;
      trace: LocalChatTrace;
    }>
  | Readonly<{
      ok: false;
      error: string;
      trace: LocalChatTrace;
    }>;

const BASE_TRACE: Omit<LocalChatTrace, 'provider' | 'model'> = {
  authority: 'fixed-local-trusted-brief',
  context: 'canonical-context-composer',
  memory: 'owner-bound-local-temporal-snapshot',
  tools: [],
  context_layers: [],
  correction: 'trace-only',
  forget: 'trace-only',
  scheduling: 'trace-only',
};

export async function runLocalChat(request: LocalChatRequest): Promise<LocalChatResult> {
  const provider = request.provider ?? LOCAL_CLI_PROVIDER;
  const model = request.model ?? LOCAL_CLI_MODEL;
  const trace = Object.freeze({ ...BASE_TRACE, provider, model });

  if (provider === S2_LIVE_PROVIDER && model === S2_LIVE_MODEL) {
    return runOpenAIChat(request, trace);
  }
  if (provider !== LOCAL_CLI_PROVIDER || model !== LOCAL_CLI_MODEL) {
    return Object.freeze({
      ok: false as const,
      error: `unsupported local provider/model: ${provider}/${model}`,
      trace,
    });
  }
  if (request.message.trim().length === 0) {
    return Object.freeze({ ok: false as const, error: 'message must not be empty', trace });
  }

  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
  const composer = adapters.contextComposer;
  if (composer === undefined) {
    return Object.freeze({ ok: false as const, error: 'local context composer unavailable', trace });
  }

  const fixture = localTrustedBriefScheduleInput();
  const accepted = acceptTrustedInvocation(fixture.admission);
  if (!accepted.ok) {
    return Object.freeze({ ok: false as const, error: 'fixed local authority rejected', trace });
  }
  const composition = await composer.compose(accepted.value, {
    snapshot_ref: fixture.snapshot_ref,
    snapshot_at: fixture.snapshot_at,
    canary_tokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'],
    replay_context_ref: null,
  });
  if (!composition.ok) {
    return Object.freeze({
      ok: false as const,
      error: `context composition failed: ${composition.failure.code}`,
      trace,
    });
  }

  const completedTrace = Object.freeze({
    ...trace,
    context_layers: Object.freeze([...composition.evidence.layers]),
    tools: Object.freeze([...composition.evidence.tool_acl]),
  });

  return Object.freeze({
    ok: true as const,
    text: `Local context composed. Local reply: ${request.message.trim()}`,
    trace: completedTrace,
  });
}

async function runOpenAIChat(
  request: LocalChatRequest,
  trace: LocalChatTrace,
): Promise<LocalChatResult> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return Object.freeze({
      ok: false as const,
      error: 'OpenAI request failed: auth_failed',
      trace,
    });
  }
  let responseMetadata: OpenAIResponseMetadata | undefined;
  const safety = resolveRunLoopAdapters({ WALDO_ENV: 'local' }).safety;
  const gateway = new OpenAIGpt5NanoAdapter({
    apiKey: process.env.OPENAI_API_KEY,
    onResponseMetadata: (metadata) => { responseMetadata = metadata; },
  });
  const runtime = new RuntimeLLMProvider({ gateway });
  const route = {
    trigger: 'user_message' as const,
    primary: {
      provider: OPENAI_PROVIDER,
      model: OPENAI_GPT_5_NANO_MODEL,
      cache: 'none' as const,
      max_tokens: 4096,
    },
    fallback: [],
    floor: 'template' as const,
  };
  const result = await runtime.complete({
    trigger: 'user_message',
    policy: routingPolicySchema.parse({ routes: [route], escalation: [], template_fallback: false }),
    renderRequest: () => ({
      system: 'Respond concisely and directly. Do not reveal private source content or credentials.',
      messages: [{ role: 'user' as const, content: request.message.trim() }],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  }, {
    authenticatedUserId: 'local-cli',
    trigger: 'user_message',
    canaryTokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'],
    sourceTaint: null,
    toolArgSourceTaint: null,
    sanitise: safety.sanitise,
    medicalGate: safety.medicalGate,
  });
  if (!result.ok) {
    return Object.freeze({
      ok: false as const,
      error: `OpenAI request failed: ${result.code}`,
      trace,
    });
  }
  return Object.freeze({
    ok: true as const,
    text: result.response.text,
    trace: Object.freeze({ ...trace, response: responseMetadata }),
  });
}

export function formatLocalChatResult(result: LocalChatResult): string {
  return JSON.stringify(result);
}
