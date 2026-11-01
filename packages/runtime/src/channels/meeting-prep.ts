import type { CalendarItem, GoogleClient } from '../connectors/google';
import { MEETING_PREP_JOB_TEXT } from '../prompt/machine-jobs';
import { taskBrief } from '../tasks/jobs';
import type { MachineHandler, MachineSpec } from '../tasks/machine';
import { calendarPrepDigest, calendarPrepPrompt, checkedMail, parseCalendarPrep, prepIdentity, prepProjection, type eventBriefs, type GranolaNotes, type PrepJob } from './event-briefs';
import type { CalendarPrepReceipt } from './telegram-final-outbox';

// Meeting prep as a machine job, for a meeting the owner organized or accepted: the worker reads their mail for it off the
// owner's alarm pass, and the brain's prep decision runs on what it found, or on its saying it found nothing, with the
// delivery admission in the commit that queues the note.

// A prep job not done five minutes before the meeting is dropped: a note after that arrives too late to use.
const MEETING_PREP_LEAD_MS = 5 * 60_000;

// The documents linked to the event that the worker can open by id.
const linked = (event: PrepJob['event']) => (event.attachments ?? []).flatMap(({ title, file_id }) => file_id ? [{ title, file_id }] : []);

// One open job per occurrence, keyed per sweep: a job that settled without reaching the owner (held, parked, dropped) leaves
// the next sweep free to ask again. A prep that was decided is recorded on its digest, so the sweep writes no job for it.
export const meetingPrepSpec = (prep: PrepJob & Readonly<{ surface: string }>): MachineSpec => ({
  job: 'meeting_prep', scope: prep.identity.id, key: `machine:meeting_prep:${prep.identity.id}:${prep.inputDigest}:${prep.now}`, surface: prep.surface, text: MEETING_PREP_JOB_TEXT,
  items: [
    { ref: prep.event.id, detail: prepProjection(prep.event, prep.timezone) },
    { ref: 'mail_query', detail: prep.query ?? '(the meeting has no usable title or other attendee to search by)' },
    ...(linked(prep.event).length ? [{ ref: 'attachments', detail: JSON.stringify(linked(prep.event)) }] : []),
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
  // Granola's notes on earlier meetings with the same people, read by the harness; undefined when there is nothing to add.
  granola?(event: CalendarItem, owner: string | null, trace: string): Promise<GranolaNotes | undefined>;
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
    // The meeting as it stands: the same occurrence on the same details, not cancelled or started, and one the owner organized
    // or accepted. Read before the decision and again before the note is queued, so a meeting the owner declined after the
    // job was written gets no note.
    const standing = async () => {
      await deps.current(connectionId);
      const latest = await client.event(machine.refs[0]!);
      await deps.current(connectionId);
      const identity = await prepIdentity(connectionId, latest);
      const stands = latest.status !== 'cancelled' && latest.owner_status !== undefined && identity.id === machine.scope
        && await calendarPrepDigest(latest) === machine.input_digest && deps.now() < Date.parse(latest.start);
      return stands ? { latest, identity } : null;
    };
    const stale = () => { deps.transaction(io.settle); return { held: 'held_stale' as const }; };
    const found = await standing();
    if (!found) return stale();
    const { latest, identity } = found;
    // Granola is read only for a job still current and a meeting still standing, and the meeting is read again after it:
    // the owner may decline while Granola answers, and then the decision runs on nothing it returned.
    let granola: GranolaNotes | undefined;
    if (deps.granola) {
      await io.current();
      granola = await deps.granola(latest, client.account?.email ?? null, io.trace);
      if (!await standing()) return stale();
    }
    const now = deps.now();
    const decision = parseCalendarPrep(await deps.decide(io.trace, calendarPrepPrompt(latest, now, deps.timezone, checkedMail(result), granola), async () => { await io.current(); await deps.current(connectionId); }));
    // A reply that is no decision is no note: the job settles unrecorded rather than paying for the same reply again.
    if (decision.kind === 'malformed') { deps.transaction(io.settle); return { held: 'malformed_reply' }; }
    const commit = () => { deps.briefs.commitPrep(identity, now, machine.input_digest); io.settle(); };
    if (decision.kind === 'no_op') { deps.transaction(commit); return 'skipped'; }
    if (!await standing()) return stale();
    const receipt: CalendarPrepReceipt = { connectionId, calendarId: 'primary', eventId: latest.id, occurrence: identity.occurrence, start: identity.canonicalStart,
      revision: latest.etag ?? latest.updated ?? null, sourceDigest: machine.input_digest, timezone: deps.timezone, title: latest.title };
    if (await deps.enqueue(identity.id, decision.text, receipt, commit)) return 'delivered';
    deps.transaction(io.settle);
    return { held: 'held_budget' };
  },
  // A reader that found nothing in the mail still leaves the calendar and what Waldo knows about the people: the model judges.
  decidesOnEmpty: true,
});
