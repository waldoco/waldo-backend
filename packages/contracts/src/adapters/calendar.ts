import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { iso8601Schema } from '../core/error';

// Single owner of calendar-provider literals. Phase 1 ships Google Calendar + Apple Calendar
// (EventKit); Outlook/Graph is deliberately absent until Phase 2 (ADR-0040).
export const calendarProviderNameSchema = z.enum(['google_calendar', 'apple_calendar']);
export type CalendarProviderName = z.infer<typeof calendarProviderNameSchema>;

// `title` is a PII boundary ("Doctor appointment", "Therapy" — ADR-0040). It may cross this
// seam, but prompt-bound derivations use calendarPromptContextSchema, which has no title key.
export const calendarEventSchema = z.strictObject({
  provider: calendarProviderNameSchema,
  event_id: z.string().min(1),
  title: z.string().min(1),
  start: iso8601Schema,
  end: iso8601Schema,
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const queryEventsArgsSchema = z.strictObject({
  time_range: z.strictObject({ from: iso8601Schema, to: iso8601Schema }),
});
export type QueryEventsArgs = z.infer<typeof queryEventsArgsSchema>;

export const findSlotsArgsSchema = z.strictObject({
  time_range: z.strictObject({ from: iso8601Schema, to: iso8601Schema }),
  duration_min: z.int().positive(),
});
export type FindSlotsArgs = z.infer<typeof findSlotsArgsSchema>;

// A free slot carries no title: open time is not PII, so this shape is prompt-safe as-is.
export const freeSlotSchema = z.strictObject({
  start: iso8601Schema,
  end: iso8601Schema,
});
export type FreeSlot = z.infer<typeof freeSlotSchema>;

export const proposeEventArgsSchema = z.strictObject({
  title: z.string().min(1),
  start: iso8601Schema,
  end: iso8601Schema,
});
export type ProposeEventArgs = z.infer<typeof proposeEventArgsSchema>;

// Proposal-only is the V1 write ceiling (ADR-0040: no auto-rescheduling without confirm).
// status is literal-pinned, and no event_id exists here — a provider event id only comes into
// being after the user confirms the propose_schedule card (connector_write, ADR-0021).
export const eventProposalSchema = z.strictObject({
  status: z.literal('proposed'),
  title: z.string().min(1),
  start: iso8601Schema,
  end: iso8601Schema,
});
export type EventProposal = z.infer<typeof eventProposalSchema>;

// Prompt-destined derivation of a calendar event: a category label stands in for the title,
// and strictObject makes a verbatim title structurally unrepresentable (ADR-0040 — category
// inference only, never quote titles in prompts). No category taxonomy is ratified yet, so
// the label stays a non-empty string rather than a minted enum.
export const calendarPromptContextSchema = z.strictObject({
  event_id: z.string().min(1),
  category: z.string().min(1),
  start: iso8601Schema,
  end: iso8601Schema,
});
export type CalendarPromptContext = z.infer<typeof calendarPromptContextSchema>;

// The CalendarProvider seam (ADR-0040). Methods resolve a coded AdapterResult instead of
// throwing on provider failure. The interface deliberately exposes no direct-write method:
// propose_event is the only mutation-shaped call, and it returns a proposal.
export interface CalendarProvider {
  provider: CalendarProviderName;
  query_events(args: QueryEventsArgs): Promise<AdapterResult<CalendarEvent[]>>;
  find_slots(args: FindSlotsArgs): Promise<AdapterResult<FreeSlot[]>>;
  propose_event(args: ProposeEventArgs): Promise<AdapterResult<EventProposal>>;
}
