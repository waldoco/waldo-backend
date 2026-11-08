import type { ToolName } from '@waldo/contracts';
import { z } from 'zod';
import type { GoogleClient } from '../connectors/google';
import { machineResultText, UPDATE_SWEEP_ACT_AHEAD_TEXT, UPDATE_SWEEP_JOB_TEXT } from '../prompt/machine-jobs';
import { SKIP_UPDATE, triagePrompt, updateCardPrompt, updateEffectsPrompt, type TriageHold } from '../prompt/update-cards';
import { taskBrief, type JobBook, type JobRow } from '../tasks/jobs';
import { enqueueMachine, type MachineEnqueued, type MachineHandler, type MachineSpec } from '../tasks/machine';
import { PUSHES, pushTitle } from './expo-push';
import { DAY_CARDS } from '../prompt/day-cards';
import { clockWords } from '../prompt/fixed-lines';
import { OUTSIDE_TEXT_JOB_TOOLS, OUTSIDE_TEXT_READS } from './check-back';
import { localIso } from './reminders';
import { spendOf, withinBudget, type InterruptBook, type InterruptHold, type InterruptLimits, type InterruptSpend } from './interruptions';
import { bindNotes, type BoundNote } from './source-notes';
import { aboutChanges, toldChange, type ToldBook, type ToldChange } from './triage-told';
import { changeDetail, changeLines, CONTEXT_KINDS, CursorMovedError, readChanges, touchesDay, writeChanges, type Change, type DeltaCode, type DeltaSource, type TitleDigest, type UpdateBook } from './update-cards';

// The update sweep as a machine job. Each tick the brain reads what changed on the owner's calendar and inbox and records
// it for the next main card. When an update card could go out now and something changed, it writes a reader job in the
// same transaction as the record and the new watermarks; the worker judges the changes off the owner's alarm pass, and
// the brain's apply turn writes one update card, only when the worker found something.

// Why an update card cannot go out now: the owner turned follow-ups off, the day's last card went, volume is low, quiet
// hours, or the owner's surface would only hold it. The changes still wait for the next main card.
export type SweepGate = 'held_preference' | 'held_closed' | 'held_volume' | 'held_quiet' | 'held_window';
export type SweepCheck = 'unchanged' | 'held_open_job' | 'held_breaker' | 'held_debounce' | 'held_cursor_moved' | SweepGate | MachineEnqueued['code'];

// An update card is worth reading only soon: one still waiting after half an hour is dropped, its changes left for the next card.
export const UPDATE_CARD_FRESH_MS = 30 * 60_000;
// With the day state the judge runs at most once in this gap: a tick inside it reads nothing, so what it would have read
// waits, watermarks unmoved, for the first tick after it.
export const UPDATE_JUDGE_GAP_MS = 5 * 60_000;
// When the next judge pass is due after a debounced tick. The tick runs inside the sweep's own run, which re-arms the sweep
// when it ends, so the owner object pulls the sweep to this time once its scheduled pass is done.
export const UPDATE_JUDGE_WAKE_KEY = 'update_judge_wake_v1';
// A sweep job not applied within the hour is dropped silently; its changes are already recorded for the next main card.
const UPDATE_SWEEP_DEADLINE_MS = 60 * 60_000;

export type SweepCheckDeps = Readonly<{
  updates: UpdateBook; jobs: JobBook; google: Pick<GoogleClient, 'changedEvents' | 'newMail' | 'events' | 'mailDelta' | 'calendarDelta' | 'changedEventsPage'>;
  // GOOGLE_REALTIME_TRIAGE: read exact deltas from the mail history and these calendars' sync tokens.
  delta?: DeltaSource;
  now: number; day: string; timezone: string; surface: string; sourceFollowups: boolean;
  // PROACTIVE_ACT_AHEAD: the worker prepares the move (a drafted reply, a calendar change) as well as judging the changes.
  actAhead?: boolean;
  // The day state: what each event was is kept, and two weeks ahead are read. titleDigest keys what is kept of a title.
  dayState?: Readonly<{ titleDigest: TitleDigest }>;
  gate(): SweepGate | null;
  // Every provider the worker could be served by is down.
  providerDown(): boolean;
  // The record, the observed mail, the watermarks and the job commit together or not at all; no I/O runs inside.
  transaction<T>(work: () => T): T;
  // Runs inside that transaction for a job it wrote (the jobs lane's wake).
  enqueued(job: JobRow): void;
  // The topics the owner is forgetting whose purge has not settled.
  held(): readonly string[];
  // A change it read lands on the owner's today: asks for a health recompute, after the transaction.
  dayChanged(): Promise<void>;
}>;

// The job's key is the window it covers: the watermarks before this tick moved them.
// wakeAt: when a debounced tick's changes can next be judged. recorded: the update record this tick committed with changes,
// and the sources they came from. seedCapped: the day's read of events was cut at its cap.
type SweepChecked = Readonly<{ code: SweepCheck; changes: number; analysis: number; job?: JobRow; wakeAt?: number;
  recorded?: Readonly<{ id: number; sources: readonly Change['source'][] }>; seedCapped?: true; delta?: readonly DeltaCode[] }>;
export const updateSweepCheck = async (deps: SweepCheckDeps): Promise<SweepChecked> => {
  const { updates } = deps;
  // A sweep still open holds the window: nothing is read, so the next tick after it settles reads everything since.
  if (deps.jobs.openMachine('update_sweep', 'owner')) return { code: 'held_open_job', changes: 0, analysis: 0 };
  const gate = deps.gate();
  if (gate === null && deps.providerDown()) return { code: 'held_breaker', changes: 0, analysis: 0 };
  const lastJob = deps.dayState && gate === null ? deps.jobs.lastMachine('update_sweep') : null;
  if (lastJob !== null && deps.now < lastJob + UPDATE_JUDGE_GAP_MS) return { code: 'held_debounce', changes: 0, analysis: 0, wakeAt: lastJob + UPDATE_JUDGE_GAP_MS };
  const key = `machine:update_sweep:${updates.since('mail_since')}:${updates.since('calendar_since')}`;
  const read = await readChanges(updates, deps.google, deps.now, deps.sourceFollowups, deps.dayState
    ? { day: deps.day, events: (from, to, limit, includeDeclined) => deps.google.events(from, to, limit, includeDeclined), titleDigest: deps.dayState.titleDigest } : undefined, deps.delta);
  // A job held for a topic the owner is forgetting rolls the whole write back: the record, the observed mail and the
  // watermarks stay as they were, so the tick after the forget settles reads the same window.
  const heldTopic = new Error('held_topic');
  let checked: SweepChecked;
  let changes = read.changes;
  try { checked = deps.transaction((): SweepChecked => {
    changes = writeChanges(updates, read);
    let recordId = changes.length ? updates.record(deps.day, deps.now, changes, null) : null;
    updates.pruneMail(deps.now);
    const pending = deps.sourceFollowups ? updates.pendingMail() : [];
    const analysis = deps.sourceFollowups ? [...changes.filter(change => change.source !== 'mail'), ...pending] : changes;
    const counts = { changes: changes.length, analysis: analysis.length,
      ...(recordId === null ? {} : { recorded: { id: recordId, sources: [...new Set(changes.map(change => change.source))] } }) };
    if (gate !== null) return { code: gate, ...counts };
    if (!analysis.some(change => !CONTEXT_KINDS.includes(change.kind))) return { code: 'unchanged', ...counts };
    recordId ??= updates.record(deps.day, deps.now, [], null);
    const made = enqueueMachine(deps.jobs, updateSweepSpec(analysis, { key, recordId, surface: deps.surface, timezone: deps.timezone, now: deps.now, actAhead: deps.actAhead === true }), deps.held());
    if (made.code === 'held_topic') throw heldTopic;
    if (made.code === 'enqueued') deps.enqueued(made.job);
    return { code: made.code, ...counts, job: made.job };
  }); } catch (error) {
    if (error instanceof CursorMovedError) checked = { code: 'held_cursor_moved', changes: 0, analysis: 0 };
    else if (error === heldTopic) checked = { code: 'held_topic', changes: read.changes.length, analysis: 0 };
    else throw error;
  }
  // Weight follows the day, whatever the card does: a change on the owner's today asks for a recompute once the changes are
  // recorded. A failed ask never costs the update.
  if (changes.some(change => touchesDay(change, deps.day, deps.timezone))) await deps.dayChanged().catch(() => undefined);
  const coded = read.delta?.codes.length ? { ...checked, delta: read.delta.codes } : checked;
  return read.seen?.seedCapped ? { ...coded, seedCapped: true } : coded;
};

// The harness's wake hint after an ingestion commits: ids only, never text, emitted outside the transaction. Each consumer
// reads by its own watermark, so a lost event costs latency, not data. The shape is the one agreed with memory's daytime
// consolidator (WALDO_MEMORY_REDESIGN_2026-10-30.md §6.3).
export type ObservedEvent = Readonly<{ kind: 'chat' | 'mail' | 'calendar' | 'health' | 'connector'; refs: readonly string[]; taint: 'owner' | 'external'; at: number; localDay: string }>;
export const observedEvents = (checked: SweepChecked, localDay: string, at: number): readonly ObservedEvent[] =>
  (checked.recorded?.sources ?? []).map(kind => ({ kind, refs: [`update:${checked.recorded!.id}`], taint: 'external', at, localDay }));
export type ObservedSubscriber = (event: ObservedEvent) => void;
export const emitObserved = (subscribers: readonly ObservedSubscriber[], events: readonly ObservedEvent[]): void => {
  for (const event of events) for (const subscriber of subscribers) subscriber(event);
};

const updateSweepSpec = (analysis: readonly Change[], job: Readonly<{ key: string; recordId: number; surface: string; timezone: string; now: number; actAhead: boolean }>): MachineSpec => ({
  job: 'update_sweep', scope: 'owner', key: job.key, surface: job.surface, text: job.actAhead ? UPDATE_SWEEP_ACT_AHEAD_TEXT : UPDATE_SWEEP_JOB_TEXT,
  // Mail with a source is named by its thread ref, which the apply turn's own prompt already carries; the rest by the event
  // or message a reader opens it by, and a change recorded before those were kept by position.
  items: analysis.map((change, index) => ({ ref: change.source_ref ?? change.ref ?? `${change.source}-${index + 1}`, detail: `${change.source} ${change.kind}: ${changeDetail(change)}` })),
  timezone: job.timezone, now: job.now, deadlineAt: job.now + UPDATE_SWEEP_DEADLINE_MS, recordId: job.recordId,
});

// What an update push says, written by code from the calendar change the turn chose by its event id: the meeting's title as
// pushTitle shows it and its new local time, or the fixed line. Nothing the model wrote reaches it, so nothing the turn read
// (mail, an invite's description or location, the health log, what its tools returned) can either. A mail, a change the job
// does not hold, a title pushTitle will not show, a start that does not parse, and every change while the owner has not turned
// named updates on, give the fixed line.
const LOCAL_DATE = (timezone: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone });
const pushWhen = (item: Readonly<Record<string, unknown>>, timezone: string, now: number): Readonly<{ day: string | null; time: string | null }> | null => {
  const start = typeof item.start === 'string' ? item.start : '';
  const today = localIso(now, timezone).slice(0, 10);
  if (item.all_day === true) {
    const date = start.slice(0, 10);
    const noon = Date.parse(`${date}T12:00:00Z`);
    if (!Number.isFinite(noon)) return null;
    return { day: date === today ? 'today' : LOCAL_DATE('UTC').format(noon), time: null };
  }
  const at = Date.parse(start);
  if (!Number.isFinite(at)) return null;
  const local = localIso(at, timezone);
  return { day: local.slice(0, 10) === today ? null : LOCAL_DATE(timezone).format(at), time: clockWords(local.slice(11, 16)) };
};
export const updatePushLine = (changes: readonly Change[], event: string | undefined, rules: Readonly<{ named: boolean; timezone: string; now: number }>): string => {
  const fixed = PUSHES.update.body;
  const change = rules.named && event ? changes.find(change => change.source === 'calendar' && change.ref === `event:${event}`) : undefined;
  if (!change) return fixed;
  let item: Record<string, unknown>;
  try { item = JSON.parse(change.detail) as Record<string, unknown>; } catch { return fixed; }
  const title = pushTitle(item.title);
  if (!title) return fixed;
  if (change.kind === 'cancelled') return `${title} cancelled`;
  const when = pushWhen(item, rules.timezone, rules.now);
  if (!when) return fixed;
  const at = [when.day && (when.day === 'today' ? 'today' : `on ${when.day}`), when.time && `at ${when.time}`].filter(Boolean).join(' ');
  if (change.kind === 'added') return `${title} added ${at}`;
  const before = change.before;
  const moved = before && (item.all_day === true ? before.start.slice(0, 10) !== String(item.start).slice(0, 10) : Date.parse(before.start) !== Date.parse(String(item.start)));
  return moved ? `${title} moved to ${[when.day, when.time].filter(Boolean).join(' ')}` : `${title} ${at} changed`;
};

// The apply turn's tools: with source follow-ups it may open a source-bound loop (a card, since the turn is tainted);
// otherwise it reads, and asks the owner on a card for any change.
export const updateSweepTools = (sourceFollowups: boolean): readonly ToolName[] =>
  sourceFollowups ? ['get_context', 'read_memory', 'search_episodes', 'open_loop'] : OUTSIDE_TEXT_JOB_TOOLS;
// The triage turn reads what it needs, and may raise a card only while the owner can be interrupted: the card is the
// interrupt, so it can never outrun the budget. A send and a calendar change raise their own card; propose_action raises one
// for any other tool.
const CARD_TOOLS: readonly ToolName[] = ['send_email', 'propose_calendar_change', 'propose_action'];
export const triageTools = (sourceFollowups: boolean, canAct: boolean): readonly ToolName[] =>
  [...new Set<ToolName>([...OUTSIDE_TEXT_READS, ...(sourceFollowups ? updateSweepTools(true) : []), ...(canAct ? CARD_TOOLS : [])])];

export const updateSweepApplyText = (localNow: string, changes: readonly Change[], context: Readonly<{ ledger: string; feedback: string; volume: 'normal' | 'high'; sourceFollowups: boolean }>,
  result: Parameters<typeof machineResultText>[0], withheld: readonly string[] = []): string =>
  `${updateCardPrompt(localNow, { changes: changeLines(changes), ...context })}\n\n${machineResultText(result, withheld)}`;

// What the apply turn may choose with the day state: revise a day card that reached the owner today, or say an update, and
// with either a push; or nothing ({} or SKIP). The schema is the contract between the turn and the code that delivers it.
const UPDATE_TEXT_CHARS = 4_000;
const effectText = z.string().trim().min(1).max(UPDATE_TEXT_CHARS);
const dayCardIds = DAY_CARDS.map(card => card.id) as [string, ...string[]];
export const updateEffectsSchema = z.strictObject({
  revise: z.strictObject({ card: z.enum(dayCardIds), text: effectText }).optional(),
  say: effectText.optional(),
  push: z.strictObject({ event: z.string().trim().min(1).max(256).optional() }).optional(),
}).refine(chosen => !(chosen.revise && chosen.say), { error: 'revise or say, not both' })
  .refine(chosen => !chosen.push || chosen.revise || chosen.say, { error: 'a push opens a revision or a message' });
export type UpdateEffects = z.infer<typeof updateEffectsSchema>;
export const parseUpdateEffects = (reply: string): UpdateEffects | 'invalid' => {
  const text = reply.trim();
  if (!text || text === SKIP_UPDATE) return {};
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)?.[1] ?? text;
  try {
    const parsed = updateEffectsSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : 'invalid';
  } catch { return 'invalid'; }
};
// What was delivered for a job, as a bounded code: the effect, and whether a push went with it or quiet hours kept it back.
export type UpdateEffectCode = 'none' | 'effects_invalid' | 'revise_undelivered' | `${'revise' | 'say'}${'' | '+push' | '+quiet'}`;

// A note the turn keeps of what a change in the batch says happened: the change's ref, one line, and the open loop it bears on.
const NOTE_LINE_CHARS = 280;
const noteChoice = z.strictObject({
  ref: z.string().trim().min(1).max(256),
  line: z.string().trim().min(1).max(NOTE_LINE_CHARS),
  loop: z.string().trim().min(1).max(64).optional(),
});
// The triage turn's choice. The schema is the contract between the turn and the code that delivers it.
export const triageSchema = z.strictObject({
  decision: z.enum(['act', 'tell', 'brief', 'note', 'silent']),
  // TRIAGE_CARES: what to keep on record, with note alone or beside act, tell or brief. A note never reaches the owner by itself.
  notes: z.array(noteChoice).min(1).max(8).optional(),
  // TRIAGE_CARES: the changes a tell or a card is about, by ref, so only they count as told; without it, the whole batch.
  about: z.array(z.string().trim().min(1).max(256)).min(1).max(20).optional(),
  revise: z.strictObject({ card: z.enum(dayCardIds), text: effectText }).optional(),
  say: effectText.optional(),
  push: z.strictObject({ event: z.string().trim().min(1).max(256).optional() }).optional(),
  // With the owner's interruption limits: it cannot wait for the next day card, and the message asks the owner something.
  urgent: z.boolean().optional(),
  asks: z.boolean().optional(),
}).refine(chosen => chosen.decision === 'tell' || (!chosen.revise && !chosen.say && !chosen.push), { error: 'say, revise and push go only with tell' })
  .refine(chosen => chosen.decision !== 'tell' || (!!chosen.revise !== !!chosen.say), { error: 'a tell says or revises, not both' })
  .refine(chosen => chosen.decision !== 'note' || !!chosen.notes, { error: 'a note keeps at least one note' })
  .refine(chosen => chosen.decision !== 'silent' || !chosen.notes, { error: 'silent keeps nothing' })
  .refine(chosen => !chosen.about || chosen.decision === 'tell' || chosen.decision === 'act', { error: 'about goes only with tell or act' });
export type Triage = z.infer<typeof triageSchema>;
export const parseTriage = (reply: string): Triage | 'invalid' => {
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(reply.trim())?.[1] ?? reply.trim();
  try {
    const parsed = triageSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : 'invalid';
  } catch { return 'invalid'; }
};
// What triage delivered, as a bounded code. act: the turn raised a card. held_*: a tell that would have interrupted the owner
// waited for the next main card (a revision in it still landed, silently). invalid: an unreadable choice, left for the next card.
// note: notes were kept, alone or beside the code before it; note_unbound: none named a change in the batch or passed the health
// floor, and a batch chosen only for a note is left for the next card. held_told: a tell about only what the owner was already
// told, version for version, which is the same thing twice: nothing goes and nothing carries it.
export type TriageCode = 'act' | 'act_without_card' | 'tell' | 'tell+push' | 'revise' | 'brief' | 'note' | 'note_unbound' | 'silent' | 'invalid' | 'revise_undelivered' | 'held_told' | `held_${TriageHold | InterruptHold}`
  // An interruption charged to the urgent allowance, past the day's budget or the gap.
  | 'act+urgent' | 'tell+urgent'
  // A card the turn raised past the budget or the gap without calling it urgent: charged like an urgent one, traced apart.
  | 'act+over_budget';
// The owner's daily interrupt budget for triage: act, and a tell that messages or pushes, each spend one.
export const TRIAGE_INTERRUPTS_PER_DAY = 2;
export const TRIAGE_COOLDOWN_MS = 60 * 60_000;
export const triageHold = (spent: Readonly<{ count: number; last: number | null }>, now: number, quiet: boolean): TriageHold | null =>
  quiet ? 'quiet' : spent.count >= TRIAGE_INTERRUPTS_PER_DAY ? 'budget' : spent.last !== null && now - spent.last < TRIAGE_COOLDOWN_MS ? 'cooldown' : null;

export type UpdateSweepApplyDeps = Readonly<{
  updates: UpdateBook; timezone: string; now(): number; sourceFollowups(): boolean;
  gate(): SweepGate | null;
  transaction(work: () => void): void;
  context(): Promise<Readonly<{ ledger: string; feedback: string; volume: 'normal' | 'high' }>>;
  // The update-card turn on the owner's chain, with updateSweepTools (or the tools given) and the job's taint: its raw reply.
  turn(trace: string, text: string, current: () => Promise<void>, tools?: readonly ToolName[]): Promise<string>;
  // Queues the card under its key for the update record, `commit` in the same transaction; a key already queued only commits.
  // With the day state it may be a revision of a day card, and carry the push line to raise once it is delivered.
  deliver(id: string, trace: string, text: string, recordId: number, commit: () => void, effect?: Readonly<{ revision?: string; push?: string; inPlace?: true }>): Promise<void>;
  // Set when the day state is on.
  dayState?: Readonly<{
    // The owner's quiet hours: a revision still lands, a message and a push do not.
    quiet(): boolean;
    // Where today's day cards stand, for the turn, and whether the owner's surface shows a revised card in place.
    cards(): string;
    revisesCards: boolean;
    // Whether a day card reached the owner today, so it can be revised.
    delivered(card: string): boolean;
    // Whether the owner turned named update pushes on (updatePushLine).
    named(): boolean;
    chose(trace: string, code: UpdateEffectCode | TriageCode): void;
    // The job settled, however it ended: changes that arrived while it was open can be read now, not at the next poll.
    settled(): void;
  }>;
  // PROACTIVE_GATE: the owner's interruption limits, shared with every unasked message, replace triage's own budget.
  // closed: outside the owner's day (before their Brief or from their Close on), which, like quiet hours, nothing unasked goes past.
  interruptions?: Readonly<{ book: InterruptBook; limits(): InterruptLimits; closed(): boolean }>;
  // GOOGLE_REALTIME_TRIAGE, with the day state: the apply turn triages the batch.
  triage?: Readonly<{
    // What the turn reads beside the batch: the owner's goals, from their memory, and with TRIAGE_CARES their recent
    // conversation across surfaces, the people in play and what the owner did after recent updates (their open loops are in
    // the ledger).
    context(changes: readonly Change[]): Promise<Readonly<{ goals: string; exchange?: string; people?: string; signals?: string }>>;
    // How many approval cards were raised since `at`: what the turn offered with propose_action.
    cardsSince(at: number): number;
    // PROACTIVE_ACT_AHEAD: the turn builds on the worker's prepared move, and writes for the surface the owner reads.
    actAhead?: Readonly<{ style(): string }>;
    // TRIAGE_CARES: the owner's source notes. record runs inside the settle's transaction; loopOpen says whether a loop a note
    // names is open, so the note becomes evidence on it.
    notes?: Readonly<{ record(notes: readonly BoundNote[], recordId: number, now: number): number; loopOpen(id: string): boolean }>;
    // TRIAGE_CARES: what the owner was told, written with the delivery or the card; raised names the cards raised since `at`.
    told?: Readonly<{ book: Pick<ToldBook, 'record' | 'lastTold' | 'toldExactly'>; raised(at: number): readonly string[] }>;
  }>;
}>;

// The sweep job's apply. The gate runs again here, since quiet hours or the day's last card can come while the worker
// reads. Only the job's own changes reach the turn, and only they are judged.
export const updateSweepApplier = (deps: UpdateSweepApplyDeps): MachineHandler => {
  const judged = (row: JobRow, settle: () => void) => deps.transaction(() => {
    const { record_id: recordId, refs } = taskBrief(row).machine!;
    deps.updates.judgedJob(recordId!, refs);
    settle();
  });
  const apply: MachineHandler['apply'] = async (row, result, io) => {
      const gate = deps.gate();
      if (gate) { deps.transaction(io.settle); return { held: gate }; }
      const { record_id: recordId, refs, withheld } = taskBrief(row).machine!;
      const changes = deps.updates.jobChanges(recordId!, refs);
      if (!changes.length) { deps.transaction(io.settle); return { held: 'held_stale' }; }
      const sourceFollowups = deps.sourceFollowups();
      const commit = () => { deps.updates.judgedJob(recordId!, refs); io.settle(); };
      const day = deps.dayState;
      if (!day) {
        const text = updateSweepApplyText(localIso(deps.now(), deps.timezone), changes, { ...await deps.context(), sourceFollowups }, result, withheld);
        const reply = (await deps.turn(io.trace, text, io.current)).trim();
        if (!reply || reply === SKIP_UPDATE) { judged(row, io.settle); return 'skipped'; }
        await deps.deliver(`update:${row.id}`, io.trace, reply, recordId!, commit);
        return 'delivered';
      }
      if (deps.triage) return triage(row, result, io, day, deps.triage, changes, recordId!, withheld, sourceFollowups, commit);
      const quiet = day.quiet();
      const prompt = updateEffectsPrompt(localIso(deps.now(), deps.timezone), { changes: changeLines(changes), ...await deps.context(), sourceFollowups, cards: day.cards(), quiet, revisesCards: day.revisesCards });
      const chosen = parseUpdateEffects(await deps.turn(io.trace, `${prompt}\n\n${machineResultText(result, withheld)}`, io.current));
      const skip = (code: UpdateEffectCode) => { day.chose(io.trace, code); judged(row, io.settle); return 'skipped' as const; };
      if (chosen === 'invalid') return skip('effects_invalid');
      if (chosen.revise && !day.delivered(chosen.revise.card)) return skip('revise_undelivered');
      const effect = chosen.revise ? 'revise' : chosen.say ? 'say' : null;
      if (!effect) return skip('none');
      if (quiet && effect === 'say') return skip('say+quiet');
      // A push goes only from a surface that raises one; elsewhere the message is the notification.
      const push = chosen.push && !quiet && day.revisesCards ? updatePushLine(changes, chosen.push.event, { named: day.named(), timezone: deps.timezone, now: deps.now() }) : undefined;
      day.chose(io.trace, `${effect}${quiet ? '+quiet' : push ? '+push' : ''}`);
      await deps.deliver(`update:${row.id}`, io.trace, chosen.revise?.text ?? chosen.say!, recordId!, commit,
        { ...(chosen.revise ? { revision: chosen.revise.card, ...(effect === 'revise' ? { inPlace: true as const } : {}) } : {}), ...(push ? { push } : {}) });
      return 'delivered';
  };
  // The triage outcome is what the turn did, held to the owner's limits by code: a card it raised is the act, whatever it
  // answered; a tell that would interrupt them waits while quiet hours, the budget or the cooldown hold.
  const triage = async (row: JobRow, result: Parameters<MachineHandler['apply']>[1], io: Parameters<MachineHandler['apply']>[2], day: NonNullable<UpdateSweepApplyDeps['dayState']>,
    sense: NonNullable<UpdateSweepApplyDeps['triage']>, changes: readonly Change[], recordId: number, withheld: readonly string[] | undefined, sourceFollowups: boolean, commit: () => void) => {
    const started = deps.now();
    const localDay = localIso(started, deps.timezone).slice(0, 10);
    const limits = deps.interruptions?.limits();
    const own = deps.interruptions && limits ? { book: deps.interruptions.book, limits, closed: deps.interruptions.closed() } : null;
    // With the owner's limits the turn may act or tell past the budget when it judges the batch urgent, so it keeps its card
    // tools while some urgent allowance is left; any card past the budget or the gap draws on that allowance, marked or not.
    const ownHold = (urgent: boolean, asks: boolean) => own!.book.hold({ consent: true, quiet: day.quiet(), closed: own!.closed, asks, urgent, limits: own!.limits });
    const hold = own ? (day.quiet() ? 'quiet' : null) : triageHold(deps.updates.interrupts(localDay), started, day.quiet());
    const canAct = own ? ownHold(true, false) === null : hold === null;
    // Each change with when the owner was last told about its source, so the turn says only what is new.
    const toldOf = sense.told ? await Promise.all(changes.map(toldChange)) : [];
    const lines = sense.told ? changes.map((change, index) => {
      const last = toldOf[index] ? sense.told!.book.lastTold(toldOf[index]!.source_ref) : null;
      return `${changeLines([change])}${last === null ? '' : ` [told the owner ${localIso(last, deps.timezone).slice(0, 16).replace('T', ' ')}]`}`;
    }).join('\n') : changeLines(changes);
    const prompt = triagePrompt(localIso(started, deps.timezone), { changes: lines, ...await deps.context(), ...await sense.context(changes), sourceFollowups, notes: !!sense.notes, told: !!sense.told,
      cards: day.cards(), revisesCards: day.revisesCards, hold, left: TRIAGE_INTERRUPTS_PER_DAY - deps.updates.interrupts(localDay).count, ...(own ? { limits: own.book.line(own.limits) } : {}),
      ...(sense.actAhead ? { actAhead: { style: sense.actAhead.style() } } : {}) });
    const reply = await deps.turn(io.trace, `${prompt}\n\n${machineResultText(result, withheld)}`, io.current, triageTools(sourceFollowups, canAct));
    const chosen = parseTriage(reply);
    const asks = chosen !== 'invalid' && chosen.asks === true;
    const urgent = chosen !== 'invalid' && chosen.urgent === true;
    // What a delivery will be charged to, known before it goes so the trace code survives a failed delivery.
    const charge = (): InterruptSpend | null => own ? spendOf(own.book.spent(), own.limits, deps.now()) : null;
    const spend = () => { if (own) own.book.spend(own.limits, asks, `update:${row.id}`); else deps.updates.interrupted(localDay, deps.now()); };
    // Notes are bound to the batch before anything commits, and kept with whatever commit the outcome makes: a held tell, a
    // spent budget or quiet hours still keep them, and they spend nothing.
    const notes = chosen !== 'invalid' && chosen.notes && sense.notes ? bindNotes(chosen.notes, changes, { recordId, now: deps.now(), loopOpen: sense.notes.loopOpen }).notes : [];
    const keep = () => { if (notes.length) sense.notes!.record(notes, recordId, deps.now()); commit(); };
    // The changes a tell or a card was about, as told rows; recorded in the same commit as what reached the owner.
    const about = chosen === 'invalid' ? undefined : chosen.about;
    const toldRows = (): readonly ToldChange[] => { const named = aboutChanges(changes, about); return changes.flatMap((change, index) => named.includes(change) && toldOf[index] ? [toldOf[index]!] : []); };
    const told = (cards: readonly string[] = []) => { if (sense.told) sense.told.book.record(toldRows(), recordId, deps.now(), cards); };
    if (chosen !== 'invalid' && chosen.notes && chosen.decision !== 'note') day.chose(io.trace, notes.length ? 'note' : 'note_unbound');
    const settle = (code: TriageCode, work: () => void = () => undefined) => { day.chose(io.trace, code); deps.transaction(() => { work(); keep(); }); return 'skipped' as const; };
    if (sense.cardsSince(started) > 0) return settle(own === null || withinBudget(own.book.spent(), own.limits, deps.now()) ? 'act' : urgent ? 'act+urgent' : 'act+over_budget', () => { spend(); told(sense.told?.raised(started)); });
    if (chosen === 'invalid') return settle('invalid');
    if (chosen.decision === 'act') return settle('act_without_card');
    if (chosen.decision === 'brief') return settle('brief');
    // Kept on record only: the next main card does not carry it. With no note kept, nothing is lost: the next card carries it.
    if (chosen.decision === 'note') return notes.length ? settle('note', () => deps.updates.noted(recordId)) : settle('note_unbound');
    if (chosen.decision === 'silent') return settle('silent', () => deps.updates.noted(recordId));
    // The same thing twice, by identity: every change it is about was told before, version for version.
    if (sense.told && toldRows().length && toldRows().every(row => sense.told!.book.toldExactly(row))) return settle('held_told', () => deps.updates.noted(recordId));
    if (chosen.revise && !day.delivered(chosen.revise.card)) return settle('revise_undelivered');
    // A message interrupts; so does a push, and a revision that can only go out as a new message.
    const interrupts = !!chosen.say || !!chosen.push || !day.revisesCards;
    const held = own ? (interrupts ? ownHold(chosen.urgent === true, asks) : null) : hold;
    if (interrupts && held !== null) {
      if (!chosen.revise || !day.revisesCards) return settle(`held_${held}`);
      // Only the revision in place still lands, silently.
      day.chose(io.trace, `held_${held}`);
      await deps.deliver(`update:${row.id}`, io.trace, chosen.revise.text, recordId, () => { told(); keep(); }, { revision: chosen.revise.card, inPlace: true });
      return 'delivered' as const;
    }
    // A push goes only from a surface that raises one; elsewhere the message is the notification.
    const push = chosen.push && day.revisesCards ? updatePushLine(changes, chosen.push.event, { named: day.named(), timezone: deps.timezone, now: deps.now() }) : undefined;
    day.chose(io.trace, !interrupts ? 'revise' : interrupts && charge() === 'urgent' ? 'tell+urgent' : push ? 'tell+push' : 'tell');
    await deps.deliver(`update:${row.id}`, io.trace, chosen.say ?? chosen.revise!.text, recordId, () => { if (interrupts) spend(); told(); keep(); },
      { ...(chosen.revise ? { revision: chosen.revise.card, ...(!interrupts ? { inPlace: true as const } : {}) } : {}), ...(push ? { push } : {}) });
    return 'delivered' as const;
  };
  return {
    apply: async (row, result, io) => { try { return await apply(row, result, io); } finally { deps.dayState?.settled(); } },
    noNews: (row, settle) => { judged(row, settle); deps.dayState?.settled(); },
  };
};
