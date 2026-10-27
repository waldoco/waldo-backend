import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_PROVIDER, OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_PROVIDER, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL } from '@waldo/contracts';
import { observeModelAuth } from '../src/llm/auth-incident';
import type { LLMAttempt } from '../src/llm/provider';

let seq = 0;
const inKv = (work: (kv: DurableObjectStorage['kv']) => void) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`model-auth-${seq++}`)), async (_instance, state) => work(state.storage.kv));

const step = { context: 'full_context' as const, fallback_step: 'gateway_chain' as const };
const refused = (provider: typeof OPENAI_PROVIDER | typeof ANTHROPIC_PROVIDER): LLMAttempt =>
  ({ ...step, outcome: 'failure', provider, model: provider === OPENAI_PROVIDER ? OPENAI_GPT_6_1_TERRA_MODEL : ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, code: 'auth_failed' });
const down: LLMAttempt = { ...step, outcome: 'failure', provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_1_TERRA_MODEL, code: 'transient' };
const answered = (provider: typeof OPENAI_PROVIDER | typeof ANTHROPIC_PROVIDER): LLMAttempt =>
  ({ ...step, outcome: 'success', provider, model: provider === OPENAI_PROVIDER ? OPENAI_GPT_6_1_TERRA_MODEL : ANTHROPIC_CLAUDE_SONNET_5_5_MODEL,
    usage: { model: OPENAI_GPT_6_1_TERRA_MODEL, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } } as LLMAttempt);

describe('a refused model key is one incident per provider', () => {
  it('opens on the first refusal, stays quiet through the rest of the outage, and opens again after the provider answered', async () => {
    await inKv((kv) => {
      expect(observeModelAuth(kv, [refused(OPENAI_PROVIDER)], 1_000)).toEqual([{ provider: OPENAI_PROVIDER, since: 1_000 }]);
      for (let at = 2_000; at < 50_000; at += 1_000) expect(observeModelAuth(kv, [refused(OPENAI_PROVIDER)], at)).toEqual([]);
      expect(observeModelAuth(kv, [answered(OPENAI_PROVIDER)], 60_000)).toEqual([]);
      expect(observeModelAuth(kv, [refused(OPENAI_PROVIDER)], 70_000)).toEqual([{ provider: OPENAI_PROVIDER, since: 70_000 }]);
    });
  });

  it('counts a refusal the fallback provider covered, so a dead primary key is told even when the turn succeeded', async () => {
    await inKv((kv) => {
      expect(observeModelAuth(kv, [refused(OPENAI_PROVIDER), answered(ANTHROPIC_PROVIDER)], 1_000)).toEqual([{ provider: OPENAI_PROVIDER, since: 1_000 }]);
      expect(observeModelAuth(kv, [refused(OPENAI_PROVIDER), refused(ANTHROPIC_PROVIDER)], 2_000)).toEqual([{ provider: ANTHROPIC_PROVIDER, since: 2_000 }]);
    });
  });

  it('ignores failures that are not a refused key', async () => {
    await inKv((kv) => {
      expect(observeModelAuth(kv, [down, down], 1_000)).toEqual([]);
      expect(observeModelAuth(kv, [], 2_000)).toEqual([]);
    });
  });
});
