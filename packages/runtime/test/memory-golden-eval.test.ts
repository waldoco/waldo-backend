import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';

// Synthetic, separate-owner DOs. This is a repeatable development eval, not a private
// held-out set, LLM answer judge, or a live latency measurement. The expected ID is
// never supplied to recall. Write sessions and query sessions are deliberately split.
// The small always-visible owner profile can mask recall misses; both are scored.
type Fact = Readonly<{ key: string; kind: string; text: string; source?: string; origin?: string }>;
type Probe = Readonly<{ id: string; question: string; expected: string | null; forbidden?: readonly string[] }>;
const sessions: readonly (readonly Fact[])[] = [
  [
    { key: 'coffee', kind: 'preference', text: 'Black coffee on weekdays, cappuccino on weekends' },
    { key: 'city-old', kind: 'fact', text: 'Lives in Pune' },
    { key: 'runs', kind: 'routine', text: 'Sunday long run is 14 to 18 kilometres' },
    { key: 'late-work', kind: 'routine', text: 'Focused coding usually happens after dinner' },
  ],
  [
    { key: 'city-new', kind: 'fact', text: 'Lives in Mumbai' },
    { key: 'brief', kind: 'preference', text: 'Morning brief arrives before eight' },
    { key: 'metric', kind: 'preference', text: 'Uses kilometres and grams, metric units' },
    { key: 'forwarded', kind: 'health', text: 'Keto diet avoids carbohydrates', source: 'inferred', origin: 'untrusted' },
  ],
  [
    { key: 'trip', kind: 'event', text: 'Berlin trip in October' },
    { key: 'gym', kind: 'routine', text: 'Gym usually starts at eleven' },
    { key: 'quiet', kind: 'preference', text: 'No notifications after eleven at night' },
    { key: 'newsletter', kind: 'preference', text: 'Likes the Friday product newsletter' },
  ],
];
const probes: readonly Probe[] = [
  { id: 'exact-conditional', question: 'Coffee on weekends?', expected: 'coffee' },
  { id: 'semantic-conditional', question: 'What drink do I choose on Saturdays?', expected: 'coffee' },
  { id: 'corrected-city', question: 'Where do I live?', expected: 'city-new', forbidden: ['city-old'] },
  { id: 'exact-routine', question: 'Sunday long run?', expected: 'runs' },
  { id: 'semantic-routine', question: 'How far do I jog on the weekend?', expected: 'runs' },
  { id: 'time-routine', question: 'What time is gym usually?', expected: 'gym' },
  { id: 'exact-brief', question: 'Morning brief time?', expected: 'brief' },
  { id: 'semantic-metric', question: 'Do I prefer imperial measurements?', expected: 'metric' },
  { id: 'late-work', question: 'When do I do focused coding?', expected: 'late-work' },
  { id: 'no-match', question: 'What is the dog named?', expected: null },
  { id: 'shared-taint', question: 'Do I follow a keto diet?', expected: null, forbidden: ['forwarded'] },
  { id: 'forgotten', question: 'Berlin trip?', expected: null, forbidden: ['trip'] },
];
const wordCost = (text: string) => Math.ceil(new TextEncoder().encode(text).byteLength / 4);

describe('memory golden development evaluation', () => {
  it('scores cross-session recall and reports misses instead of silently adding semantic backends', async () => {
    const results = await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('memory-eval-owner-a')), (_instance, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      const ids = new Map<string, number>();
      for (const [session, facts] of sessions.entries()) {
        const at = `2026-09-${24 + session}T04:00:00Z`;
        for (const fact of facts) {
          store.add({ kind: fact.kind, text: fact.text, source: fact.source ?? 'stated', evidence: 'synthetic owner turn', origin: fact.origin ?? 'owner', source_ref: fact.origin === 'untrusted' ? undefined : `owner, tg-fixture-${session}` }, at);
          ids.set(fact.key, store.claims()[0]!.id);
        }
        if (session === 1) {
          // Simulate a later correction: one winner, stale claim retired.
          const old = ids.get('city-old')!;
          store.setStatus(old, 'superseded');
        }
      }
      const trip = ids.get('trip')!;
      const purge = store.purge([trip], '2026-09-28T04:00:00Z');
      expect(purge.ready).toBe(true);
      store.settle([trip]);
      return probes.map((probe) => {
        const hitIds = store.recall(probe.question, 8).map((claim) => claim.id);
        const expectedId = probe.expected === null ? null : ids.get(probe.expected)!;
        const forbiddenIds = (probe.forbidden ?? []).map((key) => ids.get(key)!);
        const prompt = turnMemoryPrompt(store, probe.question);
        const hit = expectedId === null ? hitIds.length === 0 : hitIds.includes(expectedId);
        const expectedText = probe.expected === null ? null : sessions.flat().find((f) => f.key === probe.expected)!.text;
        const promptVisible = expectedText === null ? hitIds.length === 0 : prompt.includes(expectedText);
        const noise = hitIds.filter((id) => id !== expectedId).length;
        return { id: probe.id, hit, promptVisible, noise, unexpected: hitIds.filter((id) => forbiddenIds.includes(id)).length, tokens: wordCost(prompt), profileLeak: ['forwarded', 'trip', 'city-old'].some((key) => prompt.includes(sessions.flat().find((f) => f.key === key)!.text)) };
      });
    });
    const other = await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('memory-eval-owner-b')), (_instance, state) => claimStore(state.storage.sql).recall('coffee'));
    const correct = results.filter((row) => row.hit).length;
    const promptCorrect = results.filter((row) => row.promptVisible).length;
    console.log('MEMORY_GOLDEN_EVAL ' + JSON.stringify({ correct, total: results.length, accuracy: `${correct}/${results.length}`, promptVisible: `${promptCorrect}/${results.length}`, unexpected: results.reduce((n, row) => n + row.unexpected, 0), noise: results.reduce((n, row) => n + row.noise, 0), meanPromptTokens: Math.round(results.reduce((n, row) => n + row.tokens, 0) / results.length), results }));
    expect(other).toEqual([]);
    expect(results.every((row) => row.unexpected === 0 && !row.profileLeak)).toBe(true);
    // Accuracy is measured, not declared acceptable by a convenient threshold.
    expect(results).toHaveLength(probes.length);
  });
});
