import {
  APP_ONBOARDING_SKIPPABLE_V1, appOnboardingStepV1Schema, appOnboardingV1Schema,
  type AppChatProviderV1, type AppOnboardingActionV1, type AppOnboardingStepV1, type AppProactiveSurfaceV1, type AppOnboardingV1,
  appSetupSpotV1Schema, type AppSetupAnswersRequestV1, type AppSetupAnswersResultV1,
} from '../../../contracts/src/app/onboarding';
import type { ClaimStore } from '../memory/claims';
import type { ConsentLedger } from './consent-ledger';
import { CURRENT_CONSENT_VERSION } from './consent-ledger';
import { numericHealthIn } from '../scribe/sanitiser';
import { bodyDigest } from './request-book';

type Sql = Pick<SqlStorage, 'exec'>;
type StepState = AppOnboardingV1['steps'][AppOnboardingStepV1];
type Steps = Record<AppOnboardingStepV1, StepState>;
type RunRow = Readonly<{ run_id: string; started_at: number; completed_at: number | null; steps_json: string; first_look_id: string | null; brief_time: string | null }>;

// The first-run steps reach the owner's existing settings, connections and chat through the owner object.
export type FirstRunHost = Readonly<{
  googleConnected(): Promise<boolean>;
  // Whether the health plane holds a live connection consent for any source (storage for a device source, storage and model use for a cloud wearable); 'unavailable' when it cannot be read.
  healthConnected(): Promise<boolean | 'unavailable'>;
  timezoneConfirmed(): boolean;
  // The owner's proactive-surface setting (the console's own): read it for the view, write it for the channel step.
  proactiveSurface(): AppProactiveSurfaceV1;
  setProactiveSurface(surface: AppProactiveSurfaceV1): boolean;
  // Whether the owner directory shows this chat channel linked; 'not_offered' where the server cannot link it, 'unknown' when it cannot say.
  chatLink(provider: AppChatProviderV1): Promise<'linked' | 'not_linked' | 'not_offered' | 'unknown'>;
  // Sets the owner's zone, pins The Brief at time and makes quiet hours end when it arrives.
  setBriefTime(time: string, timezone: string): Promise<boolean>;
  // Admits one main-chat message under clientId; repeating the id returns the first admission.
  admitFirstLook(clientId: string, text: string): Promise<boolean>;
  // Withdraws the look-up as the consent route does: every finding hidden, erased and barred.
  withdrawLookup(): Promise<unknown>;
}>;
export type FirstRunError = 'stale_version' | 'agreements_required' | 'not_started' | 'not_connected' | 'not_offered' | 'completed' | 'unavailable';

// The request the first look sends into main chat on the owner's tap. It reads as what the owner asked for, because it is.
export const FIRST_LOOK_TEXT = 'Show me today as you see it, and what you noticed about how I work.';
const NAME_REF = 'owner, first run: name', PRIORITY_REF = 'owner, first run: priority';
const calledText = (name: string) => `Wants to be called ${name}`;
const named = (claims: ClaimStore) => claims.claims().some(candidate => candidate.source_ref === NAME_REF);

// The setup answers, each one owner fact under its own ref and pinned where every turn reads it: the first four and how Waldo
// should bring things up in the profile after the name, the rest of the conversation in the facts block. The text is the app's
// own choice put in the third person, with the owner's words quoted as they typed them; the later answers date those words,
// since they describe a stretch of the owner's life and may carry a reading the owner stated.
type SetupAnswer = Exclude<keyof AppSetupAnswersRequestV1, 'request_id'>;
const SETUP_REFS: Readonly<Record<SetupAnswer, string>> = {
  name: NAME_REF, day: 'owner, first run: day', slips: 'owner, first run: slips', wearable: 'owner, first run: wearable',
  matters: 'owner, first run: matters', spots: 'owner, first run: spots', protect: 'owner, first run: protect', rope: 'owner, first run: rope',
  season: 'owner, first run: season', low: 'owner, first run: low',
};
const SETUP_PINS: Readonly<Record<SetupAnswer, Readonly<{ block: 'profile' | 'facts'; order: number }>>> = {
  name: { block: 'profile', order: 0 }, day: { block: 'profile', order: 1 }, slips: { block: 'profile', order: 2 }, wearable: { block: 'profile', order: 3 },
  rope: { block: 'profile', order: 4 }, matters: { block: 'facts', order: 0 }, spots: { block: 'facts', order: 1 }, protect: { block: 'facts', order: 2 },
  season: { block: 'facts', order: 3 }, low: { block: 'facts', order: 4 },
};
// The picks about the owner's body (sleep, energy, stress) are the health part of an answer: a claim of kind health under its own
// ref, so every path that leaves health out (the background decision, a job built from external data) leaves them out too. These
// are the app's closed choices, not a reading of text; the owner's own words stay with the rest of the answer.
const HEALTH_PART = ', health';
const BODY_MATTERS: readonly string[] = ['sleep', 'energy', 'stress'];
const HEALTH_PICKS: ReadonlySet<string> = new Set([...BODY_MATTERS, ...appSetupSpotV1Schema.options.filter(spot => BODY_MATTERS.includes(spot.slice(0, spot.indexOf('-'))))]);

const setupParts = (answer: SetupAnswer) => [SETUP_REFS[answer], `${SETUP_REFS[answer]}${HEALTH_PART}`];
// Whether a claim is a setup answer, by the ref this module writes it under.
export const isSetupRef = (ref: string | null | undefined): boolean => ref !== null && ref !== undefined && (Object.keys(SETUP_REFS) as SetupAnswer[]).some(answer => setupParts(answer).includes(ref));
const DAY_TEXT = {
  meetings: 'Most workdays are meetings, often back to back.', focus: 'Needs long stretches of focus at work, and they are easy to break.',
  fixed: 'Workdays are a steady nine to five, much the same most days.', varies: 'Workdays are different every day, hard to plan more than a day ahead.',
} as const;
const SLIP_TEXT = { replies: 'replies and follow-ups', overlaps: 'meetings running into each other', promises: "things they said they'd do", breaks: 'breaks and meals', evenings: 'work running into the evening' } as const;
const WEARABLE_TEXT = { apple: 'an Apple Watch', samsung: 'a Samsung Galaxy Watch', oura: 'an Oura Ring', whoop: 'a WHOOP', garmin: 'a Garmin watch' } as const;
const MATTER_TEXT = { sleep: 'their sleep', energy: 'their energy', stress: 'stress', schedule: 'their schedule', mail: 'mail and follow-ups', promises: "the things they said they'd do" } as const;
const SPOT_TEXT = {
  'sleep-onset': 'getting to sleep', 'sleep-waking': 'waking in the night', 'sleep-hours': 'not getting enough hours of sleep',
  'energy-mornings': 'energy dips in the mornings', 'energy-lunch': 'energy dips after lunch', 'energy-afternoon': 'energy dips in the late afternoon', 'energy-varies': 'energy dips at different times',
  'stress-much': 'stress from too much at once', 'stress-work': 'stress from the work itself', 'stress-people': 'stress from people',
  'schedule-b2b': 'back-to-back days', 'schedule-moving': 'things moving at the last minute', 'schedule-think': 'no time to think',
  'mail-replying': 'replying to mail', 'mail-chasing': 'chasing others on mail', 'mail-finding': 'finding things in mail',
  'promises-work': 'promises at work slipping', 'promises-home': 'promises at home slipping', 'promises-people': 'promises to friends and family slipping',
  'promises-favours': 'small favours slipping', 'promises-replies': 'replies they owe', 'promises-lookinto': 'things they said they would look into',
} as const;
const PROTECT_TEXT = { workouts: 'their workouts', family: 'family time', meals: 'meals', mornings: 'their mornings before work', focus: 'their focus time' } as const;
const ROPE_TEXT = {
  tell: 'When Waldo spots something, wants simply to be told.',
  suggest: 'When Waldo spots something, wants to hear what Waldo would change, and decides themselves.',
  draft: 'When Waldo spots something, wants it ready to approve; nothing goes anywhere until they say so.',
} as const;
const SEASON_TEXT = { busy: 'a busy stretch at work', travel: 'travelling soon', none: 'nothing unusual coming up' } as const;
const LOW_TEXT = { focus: 'focus goes first', patience: 'patience with people goes first', sleep: 'sleep goes first', push: 'they push through anyway', cancel: 'they start cancelling things' } as const;
const quoted = (words: string) => `"${words}"`;
type SetupFact = Readonly<{ kind: string; text: string; evidence: string }>;
// A list of choices with the owner's words after it, dated; an empty choice with no words of the owner's own says nothing to
// keep, so it clears the answer as null does.
const pickedFact = <Choice extends string>(kind: string, lead: string, alone: string, names: Readonly<Record<Choice, string>>) =>
  ({ picked, own_words: own }: { picked: readonly Choice[]; own_words: string }, day: string): SetupFact | null => !picked.length && !own ? null : {
    kind, evidence: `Setup answer on ${day}: ${[...picked, own].filter(Boolean).join('; ')}`,
    text: picked.length ? `${lead}: ${picked.map(choice => names[choice]).join(', ')}.${own ? ` In their own words at setup on ${day}: ${quoted(own)}` : ''}`
      : `${alone}, in their own words at setup on ${day}: ${quoted(own)}`,
  };
const SETUP_FACTS: { readonly [Answer in SetupAnswer]: (value: NonNullable<AppSetupAnswersRequestV1[Answer]>, day: string) => SetupFact | null } = {
  name: name => ({ kind: 'preference', text: calledText(name), evidence: name }),
  day: ({ shape, own_words: own }) => !shape && !own ? null : {
    kind: 'routine', evidence: `Setup answer: ${[shape, own].filter(Boolean).join('; ')}`,
    text: shape ? `${DAY_TEXT[shape]}${own ? ` In their own words: ${quoted(own)}` : ''}` : `About their workdays, in their own words: ${quoted(own)}`,
  },
  slips: ({ picked, own_words: own }) => !picked.length && !own ? null : {
    kind: 'preference', evidence: `Setup answer: ${[...picked, own].filter(Boolean).join('; ')}`,
    text: picked.length ? `Things that tend to slip, for Waldo to watch first: ${picked.map(slip => SLIP_TEXT[slip]).join(', ')}.${own ? ` In their own words: ${quoted(own)}` : ''}`
      : `Things that tend to slip, in their own words: ${quoted(own)}`,
  },
  wearable: wearable => ({ kind: 'fact', text: `Wears ${WEARABLE_TEXT[wearable]}.`, evidence: `Setup answer: ${wearable}` }),
  matters: pickedFact('goal', "Wants Waldo's help most with", "What they want Waldo's help with most", MATTER_TEXT),
  spots: (spots, day) => !spots.length ? null
    : { kind: 'fact', text: `Where it is hardest for them: ${spots.map(spot => SPOT_TEXT[spot]).join(', ')}.`, evidence: `Setup answer on ${day}: ${spots.join('; ')}` },
  protect: pickedFact('preference', 'Never to be moved or booked over', 'What is never to be moved or booked over', PROTECT_TEXT),
  rope: (rope, day) => ({ kind: 'preference', text: ROPE_TEXT[rope], evidence: `Setup answer on ${day}: ${rope}` }),
  season: ({ choice, own_words: own }, day) => !choice && !own ? null : {
    kind: 'fact', evidence: `Setup answer on ${day}: ${[choice, own].filter(Boolean).join('; ')}`,
    text: choice ? `At setup on ${day}: ${SEASON_TEXT[choice]}.${own ? ` In their own words: ${quoted(own)}` : ''}` : `At setup on ${day}, about the stretch they are in, in their own words: ${quoted(own)}`,
  },
  low: pickedFact('fact', 'When running low', 'What happens when they run low', LOW_TEXT),
};
const setupFact = <Answer extends SetupAnswer>(answer: Answer, value: NonNullable<AppSetupAnswersRequestV1[Answer]>, day: string): SetupFact | null =>
  (SETUP_FACTS[answer] as (value: NonNullable<AppSetupAnswersRequestV1[Answer]>, day: string) => SetupFact | null)(value, day);
// An answer as its parts, main then health: the health picks as a health claim of their own, the rest of the answer as before.
const setupFacts = (answer: SetupAnswer, value: NonNullable<AppSetupAnswersRequestV1[SetupAnswer]>, day: string): readonly [SetupFact | null, SetupFact | null] => {
  const choices = Array.isArray(value) ? null : typeof value === 'object' && 'picked' in value ? value as { picked: readonly string[]; own_words: string } : null;
  const picks: readonly string[] = Array.isArray(value) ? value : choices?.picked ?? [];
  const health = picks.filter(pick => HEALTH_PICKS.has(pick));
  if (!health.length) return [setupFact(answer, value, day), null];
  const rest = picks.filter(pick => !health.includes(pick));
  const main = choices ? setupFact(answer, { ...choices, picked: rest } as never, day) : rest.length ? setupFact(answer, rest as never, day) : null;
  const part = setupFact(answer, (choices ? { picked: health, own_words: '' } : health) as never, day);
  return [main, part && { ...part, kind: 'health' }];
};

// The name the owner asked to be called, as the one active name claim holds it, or null when there is none to serve. The claim's
// text is the owner's word and its evidence the name as typed: the two agree until a claim edit rewrites the text alone, and
// then no name is served rather than whatever the edit says.
export const ownerName = (claims: ClaimStore): string | null => {
  const claim = claims.claims().find(candidate => candidate.source_ref === NAME_REF && candidate.status === 'active');
  if (!claim) return null;
  const name = claim.evidence.split(' | ')[0]!.trim();
  return name.length > 0 && name.length <= 80 && claim.text === calledText(name) ? name : null;
};

// The name the owner gave at sign-up, kept as the name step keeps it, so the first run does not ask again. The first answer
// stands: a later change goes through name.set, which corrects this same claim.
export const recordSignupName = (claims: ClaimStore, name: string, at: number): boolean => {
  if (named(claims)) return false;
  claims.add({ kind: 'preference', text: calledText(name), source: 'stated', evidence: name, origin: 'owner', source_ref: NAME_REF }, new Date(at).toISOString());
  const saved = claims.claims().find(candidate => candidate.source_ref === NAME_REF);
  if (!saved) throw new Error('sign-up name not stored');
  claims.pin(saved.id, 'profile', 0);
  return true;
};

// The owner's first run. One row survives restarts; a second start returns the same run. The answers themselves live where
// they are used: the name and this week's priority as owner-stated claims, the Brief time in the day plan, the agreements in
// the consent ledger. This row holds step states, ids and times only.
export const firstRun = (sql: Sql, consent: ConsentLedger, claims: ClaimStore, host: FirstRunHost, now: () => number) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS onboarding_runs (
    id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
    steps_json TEXT NOT NULL, first_look_id TEXT, brief_time TEXT)`);
  const row = (): RunRow | null => sql.exec<RunRow>('SELECT run_id, started_at, completed_at, steps_json, first_look_id, brief_time FROM onboarding_runs WHERE id = 1').toArray()[0] ?? null;
  const steps = (run: RunRow): Steps => {
    const stored = JSON.parse(run.steps_json) as Partial<Steps>;
    return Object.fromEntries(appOnboardingStepV1Schema.options.map(step => [step, stored[step] ?? 'pending'])) as Steps;
  };
  const write = (patch: Partial<Omit<RunRow, 'run_id' | 'started_at'>> & { steps?: Steps }) => {
    const { steps: next, ...rest } = patch;
    if (next) sql.exec('UPDATE onboarding_runs SET steps_json = ? WHERE id = 1', JSON.stringify(next));
    for (const [column, value] of Object.entries(rest)) sql.exec(`UPDATE onboarding_runs SET ${column} = ? WHERE id = 1`, value);
  };
  const step = (run: RunRow, name: AppOnboardingStepV1, state: StepState) => write({ steps: { ...steps(run), [name]: state } });
  // An owner-stated answer from the first run is a claim like any other, so "What Waldo knows" shows it and a forget reaches it.
  const answer = (ref: string, kind: string, text: string, evidence: string) => {
    const at = new Date(now()).toISOString(), claim = { kind, text, source: 'stated', evidence, origin: 'owner', source_ref: ref };
    const previous = claims.claims().find(candidate => candidate.source_ref === ref);
    if (previous?.text === text && previous.kind === kind) return previous;
    if (previous) { if (!claims.correct(previous.id, claim, at)) throw new Error('first-run answer not corrected'); }
    else claims.add(claim, at);
    return claims.claims().find(candidate => candidate.source_ref === ref) ?? null;
  };

  const view = async (): Promise<AppOnboardingV1> => {
    const run = row();
    const base = run ? steps(run) : Object.fromEntries(appOnboardingStepV1Schema.options.map(name => [name, 'pending'])) as Steps;
    // Connecting Google is its own flow; the step reads as done from the live connection.
    const google = base.google !== 'done' && run && await host.googleConnected() ? 'done' : base.google;
    // A name sign-up recorded answers the name step.
    const name = base.name === 'pending' && named(claims) ? 'done' : base.name;
    // While the run is open the agreements step reads from the ledger itself, however they were accepted, so a copy bump shows
    // it pending again. A finished run keeps its step: one finished while the agreements were held back records them done when
    // they are accepted later on the consent route (agreementsAccepted), and keeps that through later copy changes too.
    const agreements = !run || run.completed_at !== null ? base.agreements : consent.agreed() ? 'done' : 'pending';
    const body = {
      version: 1 as const,
      state: !run ? 'not_started' as const : run.completed_at === null ? 'in_progress' as const : 'completed' as const,
      run_id: run?.run_id ?? null, started_at: run?.started_at ?? null, completed_at: run?.completed_at ?? null,
      steps: { ...base, google, name, agreements },
      first_look: { message_id: run?.first_look_id ?? null },
      brief: { time: run?.brief_time ?? null, timezone_confirmed: host.timezoneConfirmed() },
      channel: { surface: host.proactiveSurface() },
    };
    return appOnboardingV1Schema.parse({ ...body, revision: await bodyDigest(body) });
  };

  const act = async (action: AppOnboardingActionV1): Promise<FirstRunError | null> => {
    const at = now();
    if (action.action === 'start') {
      if (!row()) sql.exec('INSERT INTO onboarding_runs (id, run_id, started_at, completed_at, steps_json, first_look_id, brief_time) VALUES (1, ?, ?, NULL, ?, NULL, NULL)',
        `onb_${crypto.randomUUID().replaceAll('-', '')}`, at, '{}');
      return null;
    }
    const run = row();
    if (!run) return 'not_started';
    if (run.completed_at !== null) return 'completed';
    if (action.action === 'agreements.accept') {
      // While the server holds the copy back there is nothing to accept, and nothing is recorded or withdrawn.
      if (!consent.offered('terms')) return 'not_offered';
      if (action.terms_version !== CURRENT_CONSENT_VERSION.terms || action.notice_version !== CURRENT_CONSENT_VERSION.privacy_notice) return 'stale_version';
      // A yes the server does not offer records nothing, so the step is never half accepted.
      if (action.owner_lookup && !consent.offered('owner_lookup')) return 'not_offered';
      if (!action.owner_lookup) await host.withdrawLookup();
      consent.attestAge(at);
      consent.grant('terms', action.terms_version, at);
      consent.grant('privacy_notice', action.notice_version, at);
      if (action.owner_lookup) consent.grant('owner_lookup', action.notice_version, at);
      step(row()!, 'agreements', 'done');
      return null;
    }
    // The ledger answers, as the link route asks it: after a copy bump both refuse until the new copy is accepted.
    if (!consent.stepsOpen()) return 'agreements_required';
    switch (action.action) {
      case 'name.set': {
        const saved = answer(NAME_REF, 'preference', calledText(action.name), action.name);
        if (saved) claims.pin(saved.id, 'profile', 0);
        step(run, 'name', 'done');
        return null;
      }
      case 'priority.set':
        answer(PRIORITY_REF, 'goal', `The one thing that matters most in the week of ${new Date(at).toISOString().slice(0, 10)}: ${action.text}`, action.text);
        step(run, 'priority', 'done');
        return null;
      case 'health.connected': {
        const connected = await host.healthConnected();
        if (connected === 'unavailable') return 'unavailable';
        if (!connected) return 'not_connected';
        step(row()!, 'health', 'done');
        return null;
      }
      case 'brief_time.set':
        if (!(await host.setBriefTime(action.time, action.timezone))) return 'unavailable';
        write({ steps: { ...steps(row()!), brief_time: 'done' }, brief_time: action.time });
        return null;
      case 'channel.set':
        if (!host.setProactiveSurface(action.surface)) return 'unavailable';
        step(row()!, 'channel', 'done');
        return null;
      case 'channel.linked': {
        const state = await host.chatLink(action.provider);
        if (state === 'not_offered') return 'not_offered';
        if (state === 'unknown') return 'unavailable';
        if (state === 'not_linked') return 'not_connected';
        step(row()!, 'channel', 'done');
        return null;
      }
      case 'first_look.request': {
        // One first look per run: the client id comes from the run, so a repeat or a second device gets the same message.
        const client = `onboarding-first-look-${run.run_id.slice(4, 36)}`;
        if (!(await host.admitFirstLook(client, FIRST_LOOK_TEXT))) return 'unavailable';
        write({ steps: { ...steps(row()!), first_look: 'done' }, first_look_id: client });
        return null;
      }
      case 'skip':
        if (steps(run)[action.step] === 'pending') step(run, action.step, 'skipped');
        return null;
      case 'complete': {
        // What the owner left unanswered stays unasked: the rest is learned in the first week, in context.
        // The agreements are done only with a live ledger row behind them; a run finished while they are held back leaves them pending.
        const current = { ...steps(run), agreements: consent.agreed() ? 'done' as const : 'pending' as const };
        for (const name of APP_ONBOARDING_SKIPPABLE_V1) {
          if (current[name] === 'pending') current[name] = (name === 'google' && await host.googleConnected()) || (name === 'name' && named(claims)) ? 'done' : 'skipped';
        }
        write({ steps: current, completed_at: at });
        return null;
      }
    }
  };
  // The setup answers a request names, each set, corrected in place or cleared, and then which of them Waldo holds. A cleared
  // answer is retired, not forgotten: it leaves the profile and recall, and the owner can still ask Waldo to forget it.
  const live = (ref: string) => [...claims.claims(), ...claims.claims('promoted')].filter(candidate => candidate.source_ref === ref);
  const saveAnswers = (request: AppSetupAnswersRequestV1): Required<AppSetupAnswersResultV1['held']> => {
    const day = new Date(now()).toISOString().slice(0, 10);
    for (const name of Object.keys(SETUP_REFS) as SetupAnswer[]) {
      const value = request[name];
      if (value === undefined) continue;
      const parts = value === null ? [null, null] : setupFacts(name, value, day);
      setupParts(name).forEach((ref, index) => {
        const fact = parts[index];
        if (!fact) { for (const retired of live(ref)) claims.setStatus(retired.id, 'dismissed'); return; }
        // A reading the owner stated is kept as they said it, as health, so every path that leaves health out leaves it out; and,
        // as in the profile view, it is left to recall rather than shown on every turn: get_health is current.
        const reading = numericHealthIn(fact.text);
        const saved = answer(ref, reading ? 'health' : fact.kind, fact.text, fact.evidence);
        if (!saved) throw new Error('setup answer not saved');
        if (reading) claims.unpin(saved.id);
        else if (!claims.pin(saved.id, SETUP_PINS[name].block, SETUP_PINS[name].order)) throw new Error('setup answer not pinned');
      });
    }
    return Object.fromEntries((Object.keys(SETUP_REFS) as SetupAnswer[]).map(name => [name, setupParts(name).some(ref => live(ref).length > 0)])) as Required<AppSetupAnswersResultV1['held']>;
  };
  // Called in the consent route's transaction after a grant. The consent route asks for a new copy; the finished run stays done.
  const agreementsAccepted = (): void => {
    const run = row();
    if (run && run.completed_at !== null && steps(run).agreements !== 'done' && consent.agreed()) step(run, 'agreements', 'done');
  };
  return { view, act, agreementsAccepted, saveAnswers };
};
export type FirstRun = ReturnType<typeof firstRun>;
