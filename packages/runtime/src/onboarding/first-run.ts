import {
  APP_ONBOARDING_SKIPPABLE_V1, appOnboardingStepV1Schema, appOnboardingV1Schema,
  type AppChatProviderV1, type AppOnboardingActionV1, type AppOnboardingStepV1, type AppProactiveSurfaceV1, type AppOnboardingV1,
  type AppSetupAnswersRequestV1, type AppSetupAnswersResultV1,
} from '../../../contracts/src/app/onboarding';
import type { ClaimStore } from '../memory/claims';
import type { ConsentLedger } from './consent-ledger';
import { CURRENT_CONSENT_VERSION } from './consent-ledger';
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

// The setup answers, each one owner fact under its own ref, pinned after the name in this order. The text is the app's own
// choice put in the third person, with the owner's words quoted as they typed them.
type SetupAnswer = Exclude<keyof AppSetupAnswersRequestV1, 'request_id'>;
const SETUP_REFS: Readonly<Record<SetupAnswer, string>> = { name: NAME_REF, day: 'owner, first run: day', slips: 'owner, first run: slips', wearable: 'owner, first run: wearable' };
const SETUP_PIN_ORDER: Readonly<Record<SetupAnswer, number>> = { name: 0, day: 1, slips: 2, wearable: 3 };
const DAY_TEXT = {
  meetings: 'Most workdays are meetings, often back to back.', focus: 'Needs long stretches of focus at work, and they are easy to break.',
  fixed: 'Workdays are a steady nine to five, much the same most days.', varies: 'Workdays are different every day, hard to plan more than a day ahead.',
} as const;
const SLIP_TEXT = { replies: 'replies and follow-ups', overlaps: 'meetings running into each other', promises: "things they said they'd do", breaks: 'breaks and meals', evenings: 'work running into the evening' } as const;
const WEARABLE_TEXT = { apple: 'an Apple Watch', samsung: 'a Samsung Galaxy Watch', oura: 'an Oura Ring', whoop: 'a WHOOP', garmin: 'a Garmin watch' } as const;
const quoted = (words: string) => `"${words}"`;
type SetupFact = Readonly<{ kind: string; text: string; evidence: string }>;
// null clears the answer: an empty choice with no words of the owner's own says nothing to keep.
const setupFact = <Answer extends SetupAnswer>(answer: Answer, value: NonNullable<AppSetupAnswersRequestV1[Answer]>): SetupFact | null => {
  const request = { [answer]: value } as AppSetupAnswersRequestV1;
  if (request.name) return { kind: 'preference', text: calledText(request.name), evidence: request.name };
  if (request.wearable) return { kind: 'fact', text: `Wears ${WEARABLE_TEXT[request.wearable]}.`, evidence: `Setup answer: ${request.wearable}` };
  if (request.day) {
    const { shape, own_words: own } = request.day;
    if (!shape && !own) return null;
    const text = shape ? `${DAY_TEXT[shape]}${own ? ` In their own words: ${quoted(own)}` : ''}` : `About their workdays, in their own words: ${quoted(own)}`;
    return { kind: 'routine', text, evidence: `Setup answer: ${[shape, own].filter(Boolean).join('; ')}` };
  }
  if (request.slips) {
    const { picked, own_words: own } = request.slips;
    if (!picked.length && !own) return null;
    const listed = picked.map(slip => SLIP_TEXT[slip]).join(', ');
    const text = picked.length ? `Things that tend to slip, for Waldo to watch first: ${listed}.${own ? ` In their own words: ${quoted(own)}` : ''}` : `Things that tend to slip, in their own words: ${quoted(own)}`;
    return { kind: 'preference', text, evidence: `Setup answer: ${[...picked, own].filter(Boolean).join('; ')}` };
  }
  return null;
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
  const saveAnswers = (request: AppSetupAnswersRequestV1): AppSetupAnswersResultV1['held'] => {
    for (const name of Object.keys(SETUP_REFS) as SetupAnswer[]) {
      const value = request[name];
      if (value === undefined) continue;
      const fact = value === null ? null : setupFact(name, value);
      if (!fact) { for (const retired of live(SETUP_REFS[name])) claims.setStatus(retired.id, 'dismissed'); continue; }
      const saved = answer(SETUP_REFS[name], fact.kind, fact.text, fact.evidence);
      if (!saved || !claims.pin(saved.id, 'profile', SETUP_PIN_ORDER[name])) throw new Error('setup answer not pinned');
    }
    return { name: live(NAME_REF).length > 0, day: live(SETUP_REFS.day).length > 0, slips: live(SETUP_REFS.slips).length > 0, wearable: live(SETUP_REFS.wearable).length > 0 };
  };
  // Called in the consent route's transaction after a grant. The consent route asks for a new copy; the finished run stays done.
  const agreementsAccepted = (): void => {
    const run = row();
    if (run && run.completed_at !== null && steps(run).agreements !== 'done' && consent.agreed()) step(run, 'agreements', 'done');
  };
  return { view, act, agreementsAccepted, saveAnswers };
};
export type FirstRun = ReturnType<typeof firstRun>;
