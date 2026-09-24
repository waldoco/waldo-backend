import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, memoryPrompt } from '../src/memory/claims';

const withSql = <T>(fn: (sql: SqlStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('memory-size')), (_instance, state) => fn(state.storage.sql));

const tokens = (text: string) => Math.ceil(new TextEncoder().encode(text).byteLength / 4);
const AT = '2026-09-24T04:00:00Z';
const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });

const REALISTIC_CLAIMS = [
  ['routine', 'Gym usually 11am; 7:30-8pm when mornings fail', 'stated', '"gym at 11, or 7:30 if the morning goes"'],
  ['routine', 'Up around 6:45 on weekdays, later on weekends', 'stated', '"up by quarter to seven most days"'],
  ['routine', 'Codes after dinner, roughly 9 to midnight', 'stated', '"I get my real work done after dinner"'],
  ['health', 'Sleep has been short this week, around 5-6 hours', 'stated', '"barely sleeping, maybe 5 hours"'],
  ['health', 'Knee niggles on long runs since March', 'stated', '"my knee acts up past 10k"'],
  ['health', 'Cut caffeine after 2pm to help sleep', 'confirmed', 'agreed with Waldo read: afternoon coffee correlation'],
  ['preference', 'Prefers concise replies, no fluff', 'stated', '"keep it short"'],
  ['preference', 'Wants morning brief before 8am', 'stated', '"brief me before 8"'],
  ['preference', 'Dislikes back-to-back meetings', 'stated', '"never stack calls"'],
  ['pattern', 'Skips lunch on meeting-heavy days', 'inferred', 'two busy days, no lunch mentioned'],
  ['pattern', 'More active on Telegram late at night', 'inferred', 'most messages 10pm-12am'],
  ['pattern', 'Training volume drops when travel weeks start', 'inferred', 'three travel weeks, runs dropped'],
  ['event', 'Ran a half marathon in April', 'stated', '"did the half in 1:52"'],
  ['event', 'Product launch planned for October', 'stated', '"we ship in October"'],
  ['goal', 'Wants a sub-1:50 half by year end', 'stated', '"I want 1:49 this year"'],
  ['goal', 'Reading more papers on agent infrastructure', 'stated', '"been reading agent infra papers"'],
  ['person', 'Works closely with Piyush on infra', 'stated', '"Piyush owns the deploy pipeline"'],
  ['person', 'Mom calls every Sunday evening', 'stated', '"mom calls on Sundays"'],
  ['place', 'Lives in Indiranagar, Bengaluru', 'stated', '"here in indiranagar"'],
  ['place', 'Office is near Domlur', 'stated', '"office is in domlur"'],
  ['routine', 'Reviews metrics dashboard first thing Monday', 'stated', '"monday is dashboard day"'],
  ['health', 'Resting heart rate usually 52-56', 'stated', '"my resting is around 54"'],
  ['preference', 'Uses grams and kilometres, metric only', 'stated', '"metric please"'],
  ['pattern', 'Grocery run on Saturday mornings', 'inferred', 'three Saturdays, grocery mentions'],
  ['event', 'Dentist appointment rescheduled twice this month', 'stated', '"had to push the dentist again"'],
  ['goal', 'Cutting screen time after 11pm', 'stated', '"no screens after 11, trying"'],
  ['routine', 'Sunday long run, 14-18k', 'stated', '"sundays are long run days"'],
  ['preference', 'Wants costs surfaced per feature, not per request', 'stated', '"show me cost per task"'],
  ['person', 'Investor check-ins every two weeks with Arjun', 'stated', '"arjun gets the fortnightly update"'],
  ['health', 'Vitamin D was low in the June panel', 'stated', '"vit d came back low"'],
] as const;

describe('memory prompt size (phase 1 measurement)', () => {
  it('measures a realistic seeded owner memory (30 claims)', async () => {
    const size = await withSql((sql) => {
      const store = claimStore(sql);
      applyClaimOps(store, ops({ add: REALISTIC_CLAIMS.map(([kind, text, source, evidence]) => ({ kind, text, source, evidence, touches_forgotten: false })) }), AT);
      return tokens(memoryPrompt(store));
    });
    console.log('MEMORY_PROMPT_TOKENS_30_CLAIMS ' + size);
    expect(size).toBeGreaterThan(100);
    expect(size).toBeLessThan(4000);
  });
});
