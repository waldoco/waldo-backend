import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyPromotion, claimStore, type Claim, type ClaimStore, type ConstellationNode } from '../src/memory/claims';
import { NODE_STATEMENT, refPointers, supportIds } from '../src/memory/node-sources';
import { runWelcome, welcomeBuild, type WelcomeDeps, type WelcomeStage } from '../src/onboarding/welcome';

// Six setup answers, a month of health zone words and a calendar, through the first build. Every value is synthetic, and the
// health source is zone words only.
const T0 = Date.parse('2026-11-27T09:00:00Z');
const ANSWERS = {
  'owner, first run: day': 'Says most days are back-to-back calls, with the US team late in the evening',
  'owner, first run: slips': 'Says sleep is the first thing to slip when calls run late',
  'owner, first run: matters': 'Says shipping the launch this quarter matters most',
  'owner, first run: protect': 'Wants mornings kept for deep work',
  'owner, first run: season': 'Says they are training for a half marathon this season',
  'owner, first run: low': 'Says they feel flat the day after a late night',
} as const;
const day = (offset: number) => new Date(T0 - offset * 86_400_000).toISOString().slice(0, 10);
const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();
// Tuesdays, the mornings after the late Monday call, read low; every other day steady.
const ZONES = Array.from({ length: 30 }, (_, index) => day(29 - index))
  .map((iso) => `${iso} Recovery: ${weekday(iso) === 2 ? 'low' : 'steady'} · Form: ${weekday(iso) === 2 ? 'low' : 'steady'}`).join('\n');
const CALENDAR = [
  '[evt_us] US team sync · Monday 21:30 · 6 people · repeats',
  '[evt_launch] Launch review · Thursday 10:00 · 4 people · repeats',
  '[evt_run] Long run · Sunday 06:30 · repeats',
].join('\n');

const seedAnswers = (claims: ClaimStore): readonly Claim[] => {
  const at = new Date(T0).toISOString();
  for (const [ref, text] of Object.entries(ANSWERS)) claims.add({ kind: 'fact', text, source: 'stated', evidence: `owner, first run: "${text}"`, origin: 'owner', source_ref: ref }, at);
  return claims.claims().filter((claim) => claim.source_ref?.startsWith('owner, first run'));
};

// What a constellation rests on, counted by the observation behind each support: Waldo's read of a setup answer is that answer
// again, not a second sighting, and the owner's yes to a wording is no observation at all.
const observations = (all: readonly Claim[], node: ConstellationNode): ReadonlySet<string> => new Set(supportIds(node).flatMap((id) => {
  const claim = all.find((row) => row.id === id);
  if (!claim || claim.kind === NODE_STATEMENT) return [];
  return claim.source_ref?.startsWith('welcome:setup:') ? refPointers(claim.source_ref).map((pointer) => `claim:${pointer.slice(1)}`) : [`claim:${claim.id}`];
}));

const node = (over: Record<string, unknown>) => ({ extends: null, people: [], links_to: [], ...over });

it('reproduces: each setup answer becomes its own constellation, and no model call ever reads every source together', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('constellation-join-repro')), async (_instance, state) => {
    const transaction = <R>(work: () => R) => state.storage.transactionSync(work);
    const claims = claimStore(state.storage.sql, transaction), build = welcomeBuild(state.storage.sql, () => T0);
    const answers = seedAnswers(claims);
    const asked: string[] = [];
    // The model answers each stage as the reported build shows: the stage prompt asks for constellations from one source, and a
    // read of six answers comes back as six.
    const replies: Partial<Record<WelcomeStage, unknown>> = {
      health: { nodes: [node({ domain: 'health', label: 'Low Tuesdays', summary: 'Your Recovery and Form read low on Tuesdays.', observation: 'Recovery and Form low on Tuesdays.', source: 'apple_health', pointers: ['zones'] })] },
      setup: { nodes: answers.map((answer, index) => node({ domain: 'routines', label: `Answer ${index + 1}`, summary: `You said: ${answer.text.slice(0, 100)}.`, observation: answer.text.slice(0, 200), source: 'setup', pointers: [`c${answer.id}`] })) },
      calendar: { nodes: [node({ domain: 'work', label: 'Late Monday US call', summary: 'You meet the US team late on Mondays.', observation: 'US team sync repeats Monday 21:30.', source: 'calendar', pointers: ['evt_us'] })] },
    };
    const deps: WelcomeDeps = {
      build, claims, transaction, now: () => T0,
      read: {
        health: async () => ({ kind: 'input', text: ZONES, sources: ['apple_health'], pointers: new Set(['zones']), days: 30 }),
        setup: async () => ({ kind: 'input', text: answers.map((answer) => `[c${answer.id}] ${answer.text}`).join('\n'), sources: ['setup'], pointers: new Set(answers.map((answer) => `c${answer.id}`)), cites: new Map(answers.map((answer) => [`c${answer.id}`, answer.id])) }),
        calendar: async () => ({ kind: 'input', text: CALENDAR, sources: ['calendar'], pointers: new Set(['evt_us', 'evt_launch', 'evt_run']) }),
        mail: async () => ({ kind: 'settled', state: 'skipped' }),
        web: async () => ({ kind: 'settled', state: 'skipped' }),
      },
      ask: async (stage, text) => { asked.push(text); return JSON.stringify(replies[stage] ?? { nodes: [] }); },
      v2: { lookupOpen: () => false },
    };
    build.start();
    await runWelcome(deps);

    // Independent of how the model answers: some call must see an answer, the zone words and the calendar at once, or nothing
    // can join late calls, short sleep and a low next day.
    expect.soft(asked.some((text) => text.includes(ANSWERS['owner, first run: slips']) && text.includes('Form: low') && text.includes('US team sync'))).toBe(true);
    // With the model's per-source answers: a handful of constellations, each resting on more than one observation.
    const all = claims.allClaims(), active = claims.nodes().filter((row) => row.status === 'active');
    expect.soft(active.length).toBeLessThan(answers.length);
    for (const row of active) expect.soft(observations(all, row).size, row.label).toBeGreaterThanOrEqual(2);

    // The nightly promotion does not join them later: asked to join two answers and the calendar read into one pattern, it
    // holds it, because on the owner's store only owner-grounded observations from two different days count.
    const calendarRead = all.find((claim) => claim.source_ref?.startsWith('welcome:calendar:'))!;
    const receipts: string[] = [];
    applyPromotion(claims, JSON.stringify({ promoted: [], edges: [], nodes: [{ id: null, durable: true, reason: 'joins', domain: 'sleep', label: 'Late calls cost sleep', summary: 'Late calls push your sleep back.', strength: 0.6, status: 'active',
      supporting_spots: [answers[0]!.id, answers[1]!.id, calendarRead.id] }] }), new Date(T0).toISOString(), (receipt) => receipts.push(receipt.reason ?? receipt.outcome));
    expect.soft(receipts).toEqual(['admitted']);
  });
});
