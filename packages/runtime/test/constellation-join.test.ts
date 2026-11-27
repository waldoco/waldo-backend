import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyPromotion, claimStore, memoryRevision, promotionInput, type Claim, type ClaimStore, type ConstellationNode } from '../src/memory/claims';
import { NODE_STATEMENT, supportIds } from '../src/memory/node-sources';
import { runWelcome, welcomeBuild, type WelcomeDeps, type WelcomeStage } from '../src/onboarding/welcome';
import { healthStage, setupStage } from '../src/onboarding/welcome-sources';
import { numericHealthIn } from '../src/scribe/sanitiser';

// Six setup answers, a month of health zone words and a calendar, through the first build and the join pass. The model's
// answers stand in for its judgment; what this checks is what code owns. Every value is synthetic.
const T0 = Date.parse('2026-11-27T09:00:00Z');
const ANSWERS = {
  day: 'Says most days are back-to-back calls, with the US team late in the evening',
  slips: 'Says sleep is the first thing to slip when calls run late',
  matters: 'Says shipping the launch this quarter matters most',
  protect: 'Wants mornings kept for deep work',
  season: 'Says they are training for a half marathon this season',
  low: 'Says they feel flat the day after a late night',
} as const;
type Answer = keyof typeof ANSWERS;
// A reading the health plane never sends in a zones answer: it must reach neither a prompt nor a row.
const PLANTED = '47.3';
const day = (offset: number) => new Date(T0 - offset * 86_400_000).toISOString().slice(0, 10);
const tuesday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay() === 2;
const ZONES = { zones: { days: Array.from({ length: 30 }, (_, index) => day(29 - index)).map((iso) => ({ day: iso, recovery: tuesday(iso) ? 'low' : 'good', form: tuesday(iso) ? 'low' : 'good', hrv: Number(PLANTED) })) } };
const CALENDAR = ['[evt_us] US team sync · Monday 21:30 · 6 people · repeats', '[evt_launch] Launch review · Thursday 10:00 · 4 people · repeats', '[evt_run] Long run · Sunday 06:30 · repeats'].join('\n');

const seedAnswers = (claims: ClaimStore): Readonly<Record<Answer, Claim>> => {
  const at = new Date(T0).toISOString();
  for (const [name, text] of Object.entries(ANSWERS)) claims.add({ kind: name === 'protect' ? 'preference' : 'fact', text, source: 'stated', evidence: `owner, first run: "${text}"`, origin: 'owner', source_ref: `owner, first run: ${name}` }, at);
  return Object.fromEntries(Object.keys(ANSWERS).map((name) => [name, claims.claims().find((claim) => claim.source_ref === `owner, first run: ${name}`)!])) as Record<Answer, Claim>;
};
// What a constellation rests on, counted by claim; the owner's yes to a wording is no observation.
const observations = (all: readonly Claim[], node: ConstellationNode) => supportIds(node).filter((id) => all.some((claim) => claim.id === id && claim.kind !== NODE_STATEMENT));
// The spot ids the join pass was shown, by their words.
const spotIds = (input: string): ReadonlyMap<string, number> => new Map([...input.matchAll(/<spot id="(\d+)"[^>]*>([^<]*)<\/spot>/g)].map((match) => [match[2]!, Number(match[1])]));

const SPOTS: Partial<Record<WelcomeStage, unknown>> = {
  health: { spots: [
    { area: 'body', text: 'Recovery and Form read low on Tuesdays', source: 'apple_health', pointers: ['recovery', 'form'] },
    { area: 'body', text: `HRV ${PLANTED} on Tuesdays`, source: 'apple_health', pointers: ['recovery'] },
  ] },
  calendar: { spots: [
    { area: 'work', text: 'A late call with the US team every Monday evening', source: 'calendar', pointers: ['evt_us'] },
    { area: 'work', text: 'A launch review every Thursday morning', source: 'calendar', pointers: ['evt_launch'] },
    { area: 'goals', text: 'A long run every Sunday morning', source: 'calendar', pointers: ['evt_run'] },
  ] },
};
// The model's join: patterns across sources, with links across areas. One proposal tries to write a reading about the body,
// which code refuses.
const joinReply = (input: string, answers: Readonly<Record<Answer, Claim>>) => {
  const spot = spotIds(input), id = (text: string) => spot.get(text)!;
  return JSON.stringify({
    constellations: [
      { id: null, replaces: [], area: 'work', label: 'Late calls with the US team', summary: 'Your Mondays end with a late call to the US team.', strength: 0.8, spots: [answers.day.id, id('A late call with the US team every Monday evening')] },
      { id: null, replaces: [], area: 'body', label: 'Short sleep after late calls', summary: 'Sleep slips and you feel flat after a late night.', strength: 0.7, spots: [answers.slips.id, answers.low.id] },
      { id: null, replaces: [], area: 'body', label: 'Low Tuesdays', summary: 'Recovery and Form run low on Tuesdays, the morning after the late call.', strength: 0.7, spots: [id('Recovery and Form read low on Tuesdays'), answers.low.id] },
      { id: null, replaces: [], area: 'goals', label: 'Half marathon season', summary: 'You are training for a half marathon, with a long run on Sundays.', strength: 0.8, spots: [answers.season.id, id('A long run every Sunday morning')] },
      { id: null, replaces: [], area: 'body', label: 'Sleep under 6 hours', summary: 'You sleep 5 hours after late calls.', strength: 0.5, spots: [answers.slips.id, answers.day.id] },
    ],
    links: [{ from: 'new:0', to: 'new:1', relation: 'tends to precede' }, { from: 'new:1', to: 'new:2', relation: 'tends to precede' }],
    promoted: [],
  });
};

it('six answers, a month of zone words and a calendar join into a handful of linked constellations; a rerun, a pin, a dismissal and the body rules hold', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('constellation-join')), async (_instance, state) => {
    const transaction = <R>(work: () => R) => state.storage.transactionSync(work);
    const claims = claimStore(state.storage.sql, transaction), build = welcomeBuild(state.storage.sql, () => T0);
    const answers = seedAnswers(claims);
    expect(claims.pin(answers.protect.id, 'facts', 0)).toBe(true);
    const pinned = JSON.stringify(claims.allClaims().find((claim) => claim.id === answers.protect.id));
    const asked: string[] = [], joins: string[] = [];
    const join = async () => {
      const input = promotionInput(claims);
      joins.push(input);
      return transaction(() => applyPromotion(claims, joinReply(input, answers), new Date(T0).toISOString()));
    };
    const deps: WelcomeDeps = {
      build, claims, transaction, now: () => T0, join,
      read: {
        health: healthStage({ consent: async () => ({ kind: 'granted', sources: new Set(['apple']) }) }, async () => ZONES, () => 'UTC', () => T0, () => true),
        setup: async () => (await setupStage(claims, () => true)()).kind === 'input' ? { kind: 'input', text: '', sources: ['setup'], pointers: new Set() } : { kind: 'settled', state: 'skipped' },
        calendar: async () => ({ kind: 'input', text: CALENDAR, sources: ['calendar'], pointers: new Set(['evt_us', 'evt_launch', 'evt_run']) }),
        mail: async () => ({ kind: 'settled', state: 'skipped' }),
        web: async () => ({ kind: 'settled', state: 'skipped' }),
      },
      ask: async (stage, text) => { asked.push(text); return JSON.stringify(SPOTS[stage] ?? { spots: [] }); },
    };
    build.start();
    await runWelcome(deps);

    // The stages wrote spots only; one join read them all together, answers, zone words and calendar alike.
    expect(asked).toHaveLength(2);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toContain(ANSWERS.slips);
    expect(joins[0]).toContain('Recovery and Form read low on Tuesdays');
    expect(joins[0]).toContain('A late call with the US team every Monday evening');

    // A handful of constellations, each resting on two or more spots, no two alike, linked across areas.
    const all = claims.allClaims(), active = claims.nodes().filter((row) => row.status === 'active');
    expect(active.map((row) => row.label).sort()).toEqual(['Half marathon season', 'Late calls with the US team', 'Low Tuesdays', 'Short sleep after late calls']);
    for (const row of active) expect(observations(all, row).length, row.label).toBeGreaterThanOrEqual(2);
    expect(new Set(active.map((row) => JSON.stringify(observations(all, row)))).size).toBe(active.length);
    const domain = new Map(active.map((row) => [row.id, row.domain]));
    expect(claims.edges().some((edge) => domain.get(edge.from_id) !== domain.get(edge.to_id))).toBe(true);
    expect(build.view()).toMatchObject({ state: 'done', nodes: 4 });

    // A second run over the same spots changes nothing.
    const revision = memoryRevision(state.storage.sql), before = promotionInput(claims);
    await join();
    expect(memoryRevision(state.storage.sql)).toBe(revision);
    expect(promotionInput(claims)).toBe(before);

    // The owner's pin is untouched.
    expect(JSON.stringify(claims.allClaims().find((claim) => claim.id === answers.protect.id))).toBe(pinned);

    // A constellation the owner took away does not come back on its spots, under its old words or new ones.
    const gone = active.find((row) => row.label === 'Short sleep after late calls')!;
    transaction(() => { claims.forgetNode(gone.id, new Date(T0).toISOString()); claims.barrier(gone.label, new Date(T0).toISOString()); });
    const receipts: string[] = [];
    const again = JSON.parse(joinReply(promotionInput(claims), answers)) as { constellations: { label: string; summary: string }[] };
    again.constellations.push({ ...again.constellations[1]!, label: 'Late nights cost sleep', summary: 'A late night costs you sleep.' });
    transaction(() => applyPromotion(claims, JSON.stringify(again), new Date(T0).toISOString(), (receipt) => receipts.push(receipt.reason ?? receipt.outcome)));
    expect(claims.nodes().map((row) => row.label)).not.toContain('Short sleep after late calls');
    expect(claims.nodes().map((row) => row.label)).not.toContain('Late nights cost sleep');
    expect(receipts.filter((reason) => reason === 'refused' || reason === 'dismissed').length).toBeGreaterThanOrEqual(2);

    // No raw health value reached a prompt or any stored row.
    expect([...asked, ...joins].some((text) => text.includes(PLANTED))).toBe(false);
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => row.name);
    for (const table of tables) {
      const rows = state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray();
      expect(JSON.stringify(rows), table).not.toContain(PLANTED);
    }
    for (const row of claims.nodes()) expect(numericHealthIn(`${row.label} ${row.summary}`), row.label).toBe(false);
  });
});

it('an owner with one constellation per answer gets them joined, and a constellation whose words they confirmed keeps them', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('constellation-join-legacy')), async (_instance, state) => {
    const transaction = <R>(work: () => R) => state.storage.transactionSync(work);
    const claims = claimStore(state.storage.sql, transaction), at = new Date(T0).toISOString();
    const answers = seedAnswers(claims);
    const legacy = (Object.keys(ANSWERS) as Answer[]).map((name, index) => claims.saveNode({ id: null, domain: 'routines', label: `Answer ${index + 1}`, summary: ANSWERS[name], strength: 0.5, status: 'active', supporting_spots: [answers[name].id] }, at));
    expect(claims.confirmNode(legacy[3]!, 'app:node.confirm', at)).toBe(true);
    const reply = { constellations: [
      { id: null, replaces: legacy, area: 'body', label: 'Late calls cost sleep', summary: 'Late calls push your sleep back and leave you flat.', strength: 0.7, spots: [answers.day.id, answers.slips.id, answers.low.id] },
      { id: legacy[3], replaces: [], area: 'work', label: 'Mornings', summary: 'Rewritten by the pass.', strength: 0.6, spots: [answers.protect.id, answers.matters.id] },
    ], links: [{ from: 'new:0', to: String(legacy[3]), relation: 'worsens' }], promoted: [] };
    transaction(() => applyPromotion(claims, JSON.stringify(reply), at));
    const active = claims.nodes().filter((row) => row.status === 'active');
    expect(active.map((row) => row.label).sort()).toEqual(['Answer 4', 'Late calls cost sleep']);
    const confirmed = active.find((row) => row.id === legacy[3])!;
    expect(confirmed.summary).toBe(ANSWERS.protect);
    expect(observations(claims.allClaims(), confirmed).sort()).toEqual([answers.matters.id, answers.protect.id].sort());
    expect(claims.edges()).toHaveLength(1);
  });
});
