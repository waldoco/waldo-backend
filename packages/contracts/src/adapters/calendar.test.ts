// Owning ADR: ADR-0040 (CalendarProvider moves to Phase 1).
// Invariants under test: provider literals are exactly the two Phase-1 providers; the V1 seam
// is proposal-only (no direct-write method, proposal status literal-pinned, no event_id before
// user confirm); event titles are a PII boundary — the prompt-destined context shape has no
// title key; runtime boundaries resolve a coded AdapterResult instead of throwing.
// Failure modes caught: Outlook/Graph smuggled into Phase 1, a commit-shaped proposal
// (auto-reschedule drift), a verbatim title reaching a prompt-destined shape, multi-calendar
// selection creeping into V1 args, and an adapter throwing past the coded envelope.
import { describe, expect, it } from 'vitest';
import type { CalendarProvider } from './calendar';
import {
  calendarEventSchema,
  calendarPromptContextSchema,
  calendarProviderNameSchema,
  eventProposalSchema,
  findSlotsArgsSchema,
  freeSlotSchema,
  proposeEventArgsSchema,
  queryEventsArgsSchema,
} from './calendar';

const timeRange = { from: '2026-07-02T09:00:00Z', to: '2026-07-02T18:00:00Z' };

const baseEvent = {
  provider: 'google_calendar',
  event_id: 'evt-01',
  title: 'Board call',
  start: '2026-07-02T14:00:00Z',
  end: '2026-07-02T15:00:00Z',
};

const baseProposal = {
  status: 'proposed',
  title: 'Recovery window',
  start: '2026-07-02T15:30:00Z',
  end: '2026-07-02T16:00:00Z',
};

describe('calendarProviderName', () => {
  it('is exactly the two Phase-1 providers, in order', () => {
    expect(calendarProviderNameSchema.options).toEqual(['google_calendar', 'apple_calendar']);
  });

  it('rejects outlook_graph — deferred to Phase 2, deliberately absent', () => {
    expect(calendarProviderNameSchema.safeParse('outlook_graph').success).toBe(false);
  });

  it('rejects a bare vendor literal outside the ratified names', () => {
    expect(calendarProviderNameSchema.safeParse('google').success).toBe(false);
  });
});

describe('calendarEvent', () => {
  it('accepts an event for every Phase-1 provider', () => {
    for (const provider of calendarProviderNameSchema.options) {
      expect(calendarEventSchema.safeParse({ ...baseEvent, provider }).success).toBe(true);
    }
  });

  it('rejects an unknown provider literal', () => {
    expect(calendarEventSchema.safeParse({ ...baseEvent, provider: 'outlook' }).success).toBe(
      false,
    );
  });

  it('rejects a non-ISO start timestamp', () => {
    expect(calendarEventSchema.safeParse({ ...baseEvent, start: '02-07-2026 2pm' }).success).toBe(
      false,
    );
  });

  it('rejects an empty event_id', () => {
    expect(calendarEventSchema.safeParse({ ...baseEvent, event_id: '' }).success).toBe(false);
  });

  it('rejects an attendees field — not part of the V1 contract (strictObject drift)', () => {
    expect(calendarEventSchema.safeParse({ ...baseEvent, attendees: [] }).success).toBe(false);
  });
});

describe('queryEventsArgs', () => {
  it('accepts a bounded time range', () => {
    expect(queryEventsArgsSchema.safeParse({ time_range: timeRange }).success).toBe(true);
  });

  it('rejects missing time_range', () => {
    expect(queryEventsArgsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a calendar_id selector — multi-calendar merging is out of V1 scope', () => {
    expect(
      queryEventsArgsSchema.safeParse({ time_range: timeRange, calendar_id: 'work' }).success,
    ).toBe(false);
  });
});

describe('findSlotsArgs', () => {
  it('accepts a time range with a positive duration', () => {
    expect(
      findSlotsArgsSchema.safeParse({ time_range: timeRange, duration_min: 30 }).success,
    ).toBe(true);
  });

  it('rejects a non-positive duration_min', () => {
    expect(findSlotsArgsSchema.safeParse({ time_range: timeRange, duration_min: 0 }).success).toBe(
      false,
    );
  });

  it('rejects a fractional duration_min — whole minutes only', () => {
    expect(
      findSlotsArgsSchema.safeParse({ time_range: timeRange, duration_min: 30.5 }).success,
    ).toBe(false);
  });
});

describe('freeSlot', () => {
  it('accepts a start/end pair', () => {
    expect(
      freeSlotSchema.safeParse({ start: baseProposal.start, end: baseProposal.end }).success,
    ).toBe(true);
  });

  it('rejects a title on a slot — open time carries no PII and no title', () => {
    expect(
      freeSlotSchema.safeParse({ start: baseProposal.start, end: baseProposal.end, title: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('proposeEventArgs', () => {
  it('accepts a titled time window', () => {
    const { status: _status, ...args } = baseProposal;
    expect(proposeEventArgsSchema.safeParse(args).success).toBe(true);
  });

  it('rejects an empty title', () => {
    const { status: _status, ...args } = baseProposal;
    expect(proposeEventArgsSchema.safeParse({ ...args, title: '' }).success).toBe(false);
  });
});

describe('eventProposal — proposal-only write ceiling', () => {
  it("accepts a proposal with the literal-pinned 'proposed' status", () => {
    expect(eventProposalSchema.safeParse(baseProposal).success).toBe(true);
  });

  it("rejects a 'committed' status — auto-reschedule is structurally impossible in V1", () => {
    expect(eventProposalSchema.safeParse({ ...baseProposal, status: 'committed' }).success).toBe(
      false,
    );
  });

  it('rejects an event_id on a proposal — an id exists only after user-confirmed insert', () => {
    expect(eventProposalSchema.safeParse({ ...baseProposal, event_id: 'evt-02' }).success).toBe(
      false,
    );
  });
});

describe('calendarPromptContext — title PII redaction', () => {
  const baseContext = {
    event_id: 'evt-01',
    category: 'high_stakes_meeting',
    start: baseEvent.start,
    end: baseEvent.end,
  };

  it('accepts a category-labelled context', () => {
    expect(calendarPromptContextSchema.safeParse(baseContext).success).toBe(true);
  });

  it('rejects a title key — prompt-destined context carries a category, never the verbatim title', () => {
    expect(
      calendarPromptContextSchema.safeParse({ ...baseContext, title: 'Therapy' }).success,
    ).toBe(false);
  });

  it('rejects an empty category', () => {
    expect(calendarPromptContextSchema.safeParse({ ...baseContext, category: '' }).success).toBe(
      false,
    );
  });
});

describe('CalendarProvider seam — fake provider', () => {
  const slot = freeSlotSchema.parse({ start: baseProposal.start, end: baseProposal.end });
  const proposal = eventProposalSchema.parse(baseProposal);

  const provider: CalendarProvider = {
    provider: 'google_calendar',
    query_events: async () => ({ ok: false, error: 'token expired', code: 'auth_failed' }),
    find_slots: async () => ({ ok: true, data: [slot] }),
    propose_event: async () => ({ ok: true, data: proposal }),
  };

  it('resolves a coded failure instead of throwing', async () => {
    const args = queryEventsArgsSchema.parse({ time_range: timeRange });
    await expect(provider.query_events(args)).resolves.toEqual({
      ok: false,
      error: 'token expired',
      code: 'auth_failed',
    });
  });

  it('propose_event returns a proposal, never a committed event', async () => {
    const { status: _status, ...rawArgs } = baseProposal;
    const result = await provider.propose_event(proposeEventArgsSchema.parse(rawArgs));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('proposed');
      expect('event_id' in result.data).toBe(false);
    }
  });

  it('the V1 seam has no direct-write method — a create_event implementation does not typecheck', () => {
    // @ts-expect-error create_event is not part of the Phase-1 contract (proposal-only, ADR-0040)
    const drifted: CalendarProvider = { ...provider, create_event: async () => undefined };
    void drifted;
  });
});
