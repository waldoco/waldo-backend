import type { GoogleClient } from '../connectors/google';
import { MEETING_PREP_JOB_TEXT } from '../prompt/machine-jobs';
import { taskBrief } from '../tasks/jobs';
import type { MachineHandler, MachineSpec } from '../tasks/machine';
import { calendarPrepDigest, calendarPrepPrompt, checkedMail, parseCalendarPrep, prepIdentity, prepProjection, type eventBriefs, type PrepJob } from './event-briefs';
import type { CalendarPrepReceipt } from './telegram-final-outbox';

// Meeting prep as a machine job, for a meeting the owner organized or accepted: the worker reads their mail for it off the
// owner's alarm pass, and the brain's existing prep decision runs on what it found, with the delivery admission in the
// commit that queues the note.

// A prep job not done five minutes before the meeting is dropped: a note after that arrives too late to use.
const MEETING_PREP_LEAD_MS = 5 * 60_000;

// One open job per occurrence, keyed per sweep: a job that settled without reaching the owner (held, parked, dropped) leaves
// the next sweep free to ask again. A prep that was decided is recorded on its digest, so the sweep writes no job for it.
export const meetingPrepSpec = (prep: PrepJob & Readonly<{ surface: string }>): MachineSpec => ({
  job: 'meeting_prep', scope: prep.identity.id, key: `machine:meeting_prep:${prep.identity.id}:${prep.inputDigest}:${prep.now}`, surface: prep.surface, text: MEETING_PREP_JOB_TEXT,
  items: [
    { ref: prep.event.id, detail: prepProjection(prep.event, prep.timezone) },
    { ref: 'mail_query', detail: prep.query ?? '(the meeting has no usable title or other attendee to search by)' },
  ],
  timezone: prep.timezone, now: prep.now, deadlineAt: Date.parse(prep.event.start) - MEETING_PREP_LEAD_MS,
  source: { connection_id: prep.connectionId }, inputDigest: prep.inputDigest,
});

export type MeetingPrepApplyDeps = Readonly<{
  briefs: Pick<ReturnType<typeof eventBriefs>, 'commitPrep'>; timezone: string; now(): number;
  // Quiet hours, low volume or prep turned off, read at apply.
  held(): 'held_quiet' | 'held_volume' | 'held_preference' | null;
  client(): Promise<GoogleClient | null>;
  // The calendar connection still belongs to this owner; throws when it no longer does.
  current(connectionId: string): Promise<void>;
  transaction(work: () => void): void;
  // The prep decision turn, with no tools and the prep's JSON format: its raw reply.
  decide(trace: string, prompt: string, current: () => Promise<void>): Promise<string>;
  // Queues the note when the interrupt budget admits it, `commit` in the same transaction; false when it is not admitted.
  enqueue(id: string, text: string, receipt: CalendarPrepReceipt, commit: () => void): Promise<boolean>;
}>;

export const meetingPrepApplier = (deps: MeetingPrepApplyDeps): MachineHandler => ({
  apply: async (row, result, io) => {
    const held = deps.held();
    if (held) { deps.transaction(io.settle); return { held }; }
    const machine = taskBrief(row).machine!;
    const connectionId = machine.source!.connection_id;
    const client = await deps.client();
    if (!client || client.account?.connection_id !== connectionId) { deps.transaction(io.settle); return { held: 'no_source' }; }
    await deps.current(connectionId);
    const latest = await client.event(machine.refs[0]!);
    await deps.current(connectionId);
    const identity = await prepIdentity(connectionId, latest);
    const start = Date.parse(latest.start);
    if (latest.status === 'cancelled' || identity.id !== machine.scope || await calendarPrepDigest(latest) !== machine.input_digest || deps.now() >= start) {
      deps.transaction(io.settle);
      return { held: 'held_stale' };
    }
    const now = deps.now();
    const text = parseCalendarPrep(await deps.decide(io.trace, calendarPrepPrompt(latest, now, deps.timezone, checkedMail(result)), async () => { await io.current(); await deps.current(connectionId); }));
    const commit = () => { deps.briefs.commitPrep(identity, now, machine.input_digest); io.settle(); };
    if (text === null) { deps.transaction(commit); return 'skipped'; }
    const receipt: CalendarPrepReceipt = { connectionId, calendarId: 'primary', eventId: latest.id, occurrence: identity.occurrence, start: identity.canonicalStart,
      revision: latest.etag ?? latest.updated ?? null, sourceDigest: machine.input_digest, timezone: deps.timezone };
    if (await deps.enqueue(identity.id, text, receipt, commit)) return 'delivered';
    deps.transaction(io.settle);
    return { held: 'held_budget' };
  },
  // The worker found nothing that makes a note worth sending: the occurrence counts as prepped on this digest.
  noNews: async (row, settle) => {
    const machine = taskBrief(row).machine!;
    const client = await deps.client();
    const latest = client ? await client.event(machine.refs[0]!).catch(() => null) : null;
    const identity = latest ? await prepIdentity(machine.source!.connection_id, latest) : null;
    deps.transaction(() => {
      if (identity?.id === machine.scope) deps.briefs.commitPrep(identity, deps.now(), machine.input_digest);
      settle();
    });
  },
});
