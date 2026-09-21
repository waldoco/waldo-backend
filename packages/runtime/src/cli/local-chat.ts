import { acceptTrustedInvocation } from '@waldo/contracts';
import {
  localTrustedBriefScheduleInput,
  resolveRunLoopAdapters,
} from '../run-loop/adapters';

export const LOCAL_CLI_PROVIDER = 'local-fake';
export const LOCAL_CLI_MODEL = 'local-fake-v1';
export const S2_LIVE_PROVIDER = 'cloudflare-ai';
export const S2_LIVE_MODEL = ['gpt', '5', 'nano'].join('-');

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
  correction: 'trace-only';
  forget: 'trace-only';
  scheduling: 'trace-only';
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
  correction: 'trace-only',
  forget: 'trace-only',
  scheduling: 'trace-only',
};

export async function runLocalChat(request: LocalChatRequest): Promise<LocalChatResult> {
  const provider = request.provider ?? LOCAL_CLI_PROVIDER;
  const model = request.model ?? LOCAL_CLI_MODEL;
  const trace = Object.freeze({ ...BASE_TRACE, provider, model });

  if (provider === S2_LIVE_PROVIDER || model === S2_LIVE_MODEL) {
    return Object.freeze({
      ok: false as const,
      error: `live provider route is deferred to S2: ${provider}/${model}`,
      trace,
    });
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
    tools: Object.freeze([...composition.evidence.tool_acl]),
  });

  return Object.freeze({
    ok: true as const,
    text: `Local context composed. Local reply: ${request.message.trim()}`,
    trace: completedTrace,
  });
}

export function formatLocalChatResult(result: LocalChatResult): string {
  return JSON.stringify(result);
}
