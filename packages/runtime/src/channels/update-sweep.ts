import type { ToolName } from '@waldo/contracts';
import { z } from 'zod';
import type { GoogleClient } from '../connectors/google';
import { machineResultText, UPDATE_SWEEP_JOB_TEXT } from '../prompt/machine-jobs';
import { SKIP_UPDATE, updateCardPrompt, updateEffectsPrompt } from '../prompt/update-cards';
import { taskBrief, type JobBook, type JobRow } from '../tasks/jobs';
import { enqueueMachine, type MachineEnqueued, type MachineHandler, type MachineSpec } from '../tasks/machine';
import { numericHealthIn } from '../scribe/sanitiser';
import { PUSHES } from './expo-push';
import { DAY_CARDS } from '../prompt/day-cards';
import { OUTSIDE_TEXT_JOB_TOOLS } from './check-back';
import { localIso } from './reminders';
import { changeDetail, changeLines, readChanges, touchesDay, writeChanges, type Change, type UpdateBook } from './update-cards';

// The update sweep as a machine job. Each tick the brain reads what changed on the owner's calendar and inbox and records
// it for the next main card. When an update card could go out now and something changed, it writes a reader job in the
// same transaction as the record and the new watermarks; the worker judges the changes off the owner's alarm pass, and
// the brain's apply turn writes one update card, only when the worker found something.

// Why an update card cannot go out now: the owner turned follow-ups off, the day's last card went, volume is low, quiet
// hours, or the owner's surface would only hold it. The changes still wait for the next main card.
export type SweepGate = 'held_preference' | 'held_closed' | 'held_volume' | 'held_quiet' | 'held_window';
export type SweepCheck = 'unchanged' | 'held_open_job' | 'held_breaker' | SweepGate | MachineEnqueued['code'];

// An update card is worth reading only soon: one still waiting after half an hour is dropped, its changes left for the next card.
export const UPDATE_CARD_FRESH_MS = 30 * 60_000;
// A sweep job not applied within the hour is dropped silently; its changes are already recorded for the next main card.
const UPDATE_SWEEP_DEADLINE_MS = 60 * 60_000;

export type SweepCheckDeps = Readonly<{
  updates: UpdateBook; jobs: JobBook; google: Pick<GoogleClient, 'changedEvents' | 'newMail' | 'events'>;
  now: number; day: string; timezone: string; surface: string; sourceFollowups: boolean;
  // The day state: what each event was is kept, and two weeks ahead are read.
  dayState?: boolean;
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
type SweepChecked = Readonly<{ code: SweepCheck; changes: number; analysis: number; job?: JobRow }>;
export const updateSweepCheck = async (deps: SweepCheckDeps): Promise<SweepChecked> => {
  const { updates } = deps;
  // A sweep still open holds the window: nothing is read, so the next tick after it settles reads everything since.
  if (deps.jobs.openMachine('update_sweep', 'owner')) return { code: 'held_open_job', changes: 0, analysis: 0 };
  const gate = deps.gate();
  if (gate === null && deps.providerDown()) return { code: 'held_breaker', changes: 0, analysis: 0 };
  const key = `machine:update_sweep:${updates.since('mail_since')}:${updates.since('calendar_since')}`;
  const read = await readChanges(updates, deps.google, deps.now, deps.sourceFollowups, deps.dayState
    ? { day: deps.day, events: (from, to, limit, includeDeclined) => deps.google.events(from, to, limit, includeDeclined) } : undefined);
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
    const counts = { changes: changes.length, analysis: analysis.length };
    if (gate !== null) return { code: gate, ...counts };
    if (!analysis.length) return { code: 'unchanged', ...counts };
    recordId ??= updates.record(deps.day, deps.now, [], null);
    const made = enqueueMachine(deps.jobs, updateSweepSpec(analysis, { key, recordId, surface: deps.surface, timezone: deps.timezone, now: deps.now }), deps.held());
    if (made.code === 'held_topic') throw heldTopic;
    if (made.code === 'enqueued') deps.enqueued(made.job);
    return { code: made.code, ...counts, job: made.job };
  }); } catch (error) {
    if (error !== heldTopic) throw error;
    checked = { code: 'held_topic', changes: read.changes.length, analysis: 0 };
  }
  // Weight follows the day, whatever the card does: a change on the owner's today asks for a recompute once the changes are
  // recorded. A failed ask never costs the update.
  if (changes.some(change => touchesDay(change, deps.day, deps.timezone))) await deps.dayChanged().catch(() => undefined);
  return checked;
};

const updateSweepSpec = (analysis: readonly Change[], job: Readonly<{ key: string; recordId: number; surface: string; timezone: string; now: number }>): MachineSpec => ({
  job: 'update_sweep', scope: 'owner', key: job.key, surface: job.surface, text: UPDATE_SWEEP_JOB_TEXT,
  // Mail with a source is named by its thread ref, which the apply turn's own prompt already carries; the rest by the event
  // or message a reader opens it by, and a change recorded before those were kept by position.
  items: analysis.map((change, index) => ({ ref: change.source_ref ?? change.ref ?? `${change.source}-${index + 1}`, detail: `${change.source} ${change.kind}: ${changeDetail(change)}` })),
  timezone: job.timezone, now: job.now, deadlineAt: job.now + UPDATE_SWEEP_DEADLINE_MS, recordId: job.recordId,
});

// What an update push may say. It may name the change (a meeting's title, its times, its people); it never carries a link
// (a meeting link can hold its passcode), an email address, a health value, or four words in a row from a mail or health
// line the turn read. Anything else, and every line
// while the owner has not turned named updates on, is the fixed line. A destination rule, so it holds at the send.
export const UPDATE_PUSH_CHARS = 140;
const SHARED_WORDS = 4;
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const shingles = (text: string) => { const w = words(text); return w.slice(0, Math.max(0, w.length - SHARED_WORDS + 1)).map((_, i) => w.slice(i, i + SHARED_WORDS).join(' ')); };
export const updatePushLine = (line: string, rules: Readonly<{ named: boolean; forbidden: readonly string[] }>): string => {
  const fixed = PUSHES.update.body;
  const plain = line.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(/\S+@\S+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!rules.named || !plain || numericHealthIn(plain)) return fixed;
  const seen = new Set(rules.forbidden.flatMap(shingles));
  if (shingles(plain).some(shingle => seen.has(shingle))) return fixed;
  if (plain.length <= UPDATE_PUSH_CHARS) return plain;
  const cut = plain.slice(0, UPDATE_PUSH_CHARS - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trim()}…`;
};

// The apply turn's tools: with source follow-ups it may open a source-bound loop (a card, since the turn is tainted);
// otherwise it reads, and asks the owner on a card for any change.
export const updateSweepTools = (sourceFollowups: boolean): readonly ToolName[] =>
  sourceFollowups ? ['get_context', 'read_memory', 'search_episodes', 'open_loop'] : OUTSIDE_TEXT_JOB_TOOLS;

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
  push: z.string().trim().min(1).max(500).optional(),
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

export type UpdateSweepApplyDeps = Readonly<{
  updates: UpdateBook; timezone: string; now(): number; sourceFollowups(): boolean;
  gate(): SweepGate | null;
  transaction(work: () => void): void;
  context(): Promise<Readonly<{ ledger: string; feedback: string; volume: 'normal' | 'high' }>>;
  // The update-card turn on the owner's chain, with updateSweepTools and the job's taint: its raw reply.
  turn(trace: string, text: string, current: () => Promise<void>): Promise<string>;
  // Queues the card under its key for the update record, `commit` in the same transaction; a key already queued only commits.
  // With the day state it may be a revision of a day card, and carry the push line to raise once it is delivered.
  deliver(id: string, trace: string, text: string, recordId: number, commit: () => void, effect?: Readonly<{ revision?: string; push?: string }>): Promise<void>;
  // Set when the day state is on.
  dayState?: Readonly<{
    // The owner's quiet hours: a revision still lands, a message and a push do not.
    quiet(): boolean;
    // Where today's day cards stand, for the turn, and the surface the owner reads Waldo on.
    cards(): string;
    surface: string;
    // Whether a day card reached the owner today, so it can be revised.
    delivered(card: string): boolean;
    // The push line as it may go out (updatePushLine), given the mail the turn read.
    pushLine(line: string, mail: readonly string[]): Promise<string>;
    chose(trace: string, code: UpdateEffectCode): void;
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
  return {
    apply: async (row, result, io) => {
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
      const quiet = day.quiet();
      const prompt = updateEffectsPrompt(localIso(deps.now(), deps.timezone), { changes: changeLines(changes), ...await deps.context(), sourceFollowups, cards: day.cards(), quiet, surface: day.surface });
      const chosen = parseUpdateEffects(await deps.turn(io.trace, `${prompt}\n\n${machineResultText(result, withheld)}`, io.current));
      const skip = (code: UpdateEffectCode) => { day.chose(io.trace, code); judged(row, io.settle); return 'skipped' as const; };
      if (chosen === 'invalid') return skip('effects_invalid');
      if (chosen.revise && !day.delivered(chosen.revise.card)) return skip('revise_undelivered');
      const effect = chosen.revise ? 'revise' : chosen.say ? 'say' : null;
      if (!effect) return skip('none');
      if (quiet && effect === 'say') return skip('say+quiet');
      const push = chosen.push && !quiet ? await day.pushLine(chosen.push, changes.filter(change => change.source === 'mail').map(change => change.detail)) : undefined;
      day.chose(io.trace, `${effect}${quiet ? '+quiet' : push ? '+push' : ''}`);
      await deps.deliver(`update:${row.id}`, io.trace, chosen.revise?.text ?? chosen.say!, recordId!, commit,
        { ...(chosen.revise ? { revision: chosen.revise.card } : {}), ...(push ? { push } : {}) });
      return 'delivered';
    },
    noNews: judged,
  };
};
