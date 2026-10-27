import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_PROVIDER, OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_PROVIDER } from '@waldo/contracts';
import { observeModelAuth } from '../src/llm/auth-incident';
import type { LLMAttempt } from '../src/llm/provider';
import { dueFailureNotices, failurePauseHolds, markFailureNoticed, MODEL_AUTH_NOTICE } from '../src/scheduler/failure-notice';
import { ensureSchema } from '../src/tracer/schema';
import { dayPlanBook } from '../src/channels/day-cards';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';

let seq = 0;
const inObject = (work: (state: DurableObjectState) => void) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`model-auth-${seq++}`)), async (_instance, state) => { ensureSchema(state.storage); work(state); });

type Refusable = typeof OPENAI_PROVIDER | typeof ANTHROPIC_PROVIDER;
const step = { context: 'full_context' as const, fallback_step: 'gateway_chain' as const };
const modelOf = (provider: Refusable) => (provider === OPENAI_PROVIDER ? OPENAI_GPT_6_1_TERRA_MODEL : ANTHROPIC_CLAUDE_SONNET_5_5_MODEL);
const refused = (provider: Refusable): LLMAttempt => ({ ...step, outcome: 'failure', provider, model: modelOf(provider), code: 'auth_failed' });
const down: LLMAttempt = { ...step, outcome: 'failure', provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_1_TERRA_MODEL, code: 'transient' };
const answered = (provider: Refusable): LLMAttempt =>
  ({ ...step, outcome: 'success', provider, model: modelOf(provider), usage: { model: modelOf(provider), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } } as LLMAttempt);

describe('a refused model key is one incident per provider', () => {
  it('opens on the first refusal, logs it once for ops, stays quiet through the outage, and opens again after the provider answered', async () => {
    await inObject((state) => {
      const sql = state.storage.sql, logged: TurnLogEntry[] = [], log = (entry: TurnLogEntry) => { logged.push(entry); };
      expect(observeModelAuth(sql, [refused(OPENAI_PROVIDER)], 1_000, log)).toEqual([{ provider: OPENAI_PROVIDER, since: 1_000 }]);
      for (let at = 2_000; at < 50_000; at += 1_000) expect(observeModelAuth(sql, [refused(OPENAI_PROVIDER)], at, log)).toEqual([]);
      expect(observeModelAuth(sql, [answered(OPENAI_PROVIDER)], 60_000, log)).toEqual([]);
      expect(observeModelAuth(sql, [refused(OPENAI_PROVIDER)], 70_000, log)).toEqual([{ provider: OPENAI_PROVIDER, since: 70_000 }]);
      expect(logged).toEqual([
        { trace: 'model-auth:openai:1000', hop: 'model_auth_failed', ms: 0, ok: false, code: 'auth_failed', provider: OPENAI_PROVIDER },
        { trace: 'model-auth:openai:70000', hop: 'model_auth_failed', ms: 0, ok: false, code: 'auth_failed', provider: OPENAI_PROVIDER },
      ]);
    });
  });

  it('counts a refusal the fallback provider covered, so a dead primary key is told even when the turn succeeded', async () => {
    await inObject((state) => {
      const sql = state.storage.sql, log = () => {};
      expect(observeModelAuth(sql, [refused(OPENAI_PROVIDER), answered(ANTHROPIC_PROVIDER)], 1_000, log)).toEqual([{ provider: OPENAI_PROVIDER, since: 1_000 }]);
      expect(observeModelAuth(sql, [refused(OPENAI_PROVIDER), refused(ANTHROPIC_PROVIDER)], 2_000, log)).toEqual([{ provider: ANTHROPIC_PROVIDER, since: 2_000 }]);
    });
  });

  it('ignores failures that are not a refused key', async () => {
    await inObject((state) => {
      expect(observeModelAuth(state.storage.sql, [down, down], 1_000, () => {})).toEqual([]);
      expect(observeModelAuth(state.storage.sql, [], 2_000, () => {})).toEqual([]);
    });
  });
});

// The owner hears of a refused key only when it costs them something they can see: a day card waiting for the model. A refusal
// the fallback provider covered changes nothing for them, so only ops hear of it.
const DAY_MS = 24 * 60 * 60_000;
describe('the owner hears about a refused key only while a day card waits for the model, at most once a local day', () => {
  it('says nothing when the fallback provider covered the refusal and no card is waiting', async () => {
    await inObject((state) => {
      const { sql, kv } = state.storage;
      expect(observeModelAuth(sql, [refused(OPENAI_PROVIDER), answered(ANTHROPIC_PROVIDER)], 1_000, () => {})).toHaveLength(1);
      expect(dueFailureNotices(sql, kv, 2_000, 'UTC')).toEqual([]);
    });
  });

  it('says nothing for a card waiting on a model that is merely down, with no refused key', async () => {
    await inObject((state) => {
      const { sql, kv } = state.storage;
      dayPlanBook(sql).waitingOnModel('1970-01-01', 'card:brief');
      expect(dueFailureNotices(sql, kv, 2_000, 'UTC')).toEqual([]);
    });
  });

  it('gives one fixed line about the day cards while one waits, holds it only while that stays true, and tells a new day again', async () => {
    await inObject((state) => {
      const { sql, kv } = state.storage;
      const tz = 'UTC';
      observeModelAuth(sql, [refused(OPENAI_PROVIDER)], 1_000, () => {});
      dayPlanBook(sql).waitingOnModel('1970-01-01', 'card:brief');
      const [notice, ...rest] = dueFailureNotices(sql, kv, 2_000, tz);
      expect(rest).toEqual([]);
      expect(notice).toMatchObject({ id: 'model-auth:1970-01-01', scheduleId: 'model-auth:1970-01-01', kind: 'model_auth', until: DAY_MS, text: MODEL_AUTH_NOTICE });
      expect(MODEL_AUTH_NOTICE).toMatch(/day cards/);
      expect(MODEL_AUTH_NOTICE).not.toMatch(/401|auth_failed|openai|key|on my own/i);
      expect(failurePauseHolds(sql, notice!)).toBe(true);
      markFailureNoticed(kv, notice!, 2_000);
      // A provider that answers and then refuses again the same day opens a new incident, and is not told again that day.
      observeModelAuth(sql, [answered(OPENAI_PROVIDER)], 3_000, () => {});
      expect(failurePauseHolds(sql, notice!)).toBe(false);
      observeModelAuth(sql, [refused(OPENAI_PROVIDER)], 4_000, () => {});
      expect(dueFailureNotices(sql, kv, 5_000, tz)).toEqual([]);
      // Once no card waits, the line would no longer be true.
      dayPlanBook(sql).sent('1970-01-01', 'card:brief');
      expect(failurePauseHolds(sql, notice!)).toBe(false);
      // The next local day, with a card waiting again, is told again.
      dayPlanBook(sql).waitingOnModel('1970-01-02', 'card:brief');
      expect(dueFailureNotices(sql, kv, DAY_MS + 1_000, tz).map((due) => due.id)).toEqual(['model-auth:1970-01-02']);
    });
  });
});
