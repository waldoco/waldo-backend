import { describe, expect, it } from 'vitest';
import { buildSessionState, type TriggerType } from '@waldo/contracts';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import { sanitise } from '../src/scribe/sanitiser';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';

const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'] as const;

const ctx = (trigger: TriggerType): ToolDispatcherContext => ({
  authenticatedUserId: 'user-1',
  trigger,
  session: buildSessionState({ trigger, canary_tokens: [...canaryTokens], started_at: 1_700_000_000_000 }),
  hasApproval: () => true,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise,
});

// Synthetic but realistic populated payloads: no real owner data, just the shape live APIs return.
const populatedEvents = Array.from({ length: 25 }, (_, i) => ({
  id: `evt-${i}`,
  summary: `Quarterly planning sync ${i} with https://example.com/docs/agenda-${i}?ref=mtg`,
  start: `2026-09-2${i % 9}T10:00:00+05:30`,
  end: `2026-09-2${i % 9}T11:00:00+05:30`,
  location: 'Studio 4, 221 Baker Street',
  description: `Agenda: review https://example.com/specs/v${i} and the attached notes. `.repeat(30),
  attendees: [`a${i}@example.com`, `b${i}@example.com`],
}));

const populatedMail = Array.from({ length: 10 }, (_, i) => ({
  id: `msg-${i}`,
  from: `Sender ${i} <sender${i}@example.com>`,
  subject: `Invoice #${1000 + i} for September`,
  snippet: `Hi, attaching the September invoice. Please review the line items at https://billing.example.com/i/${1000 + i} and confirm. `.repeat(30),
  at: `2026-09-24T0${i}:15:00Z`,
}));

const googleWith = (events: unknown[], messages: unknown[]): GoogleAccess =>
  ({
    client: async () => ({
      events: async () => events,
      newMail: async () => messages,
    }),
    status: async () => ({ calendar: true, mail: true }),
  }) as unknown as GoogleAccess;

const desk = { record: () => undefined, proposeBrowserSubmit: async () => null } as never;
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-25T16:00:00Z') };

describe('Populated google reads (live failure tg-904957558/560 class)', () => {
  it('REPRO: a populated calendar result fails when no offload store is wired', async () => {
    const [calendar] = googleHandlers(googleWith(populatedEvents, []), desk, clock);
    const result = await dispatchTool(
      { id: 'c1', name: 'query_calendar', args: { date_range: { from: '2026-09-25T00:00:00+05:30', to: '2026-10-10T23:59:59+05:30' } } },
      ctx('user_message'),
      { handlers: [calendar!] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('oversize');
  });

  it('REPRO: a populated gmail result fails when no offload store is wired', async () => {
    const [, mail] = googleHandlers(googleWith([], populatedMail), desk, clock);
    const result = await dispatchTool(
      { id: 'c2', name: 'get_communication', args: {} },
      ctx('user_message'),
      { handlers: [mail!] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('oversize');
  });

  it('an empty calendar result passes, matching the live pass', async () => {
    const [calendar] = googleHandlers(googleWith([], []), desk, clock);
    const result = await dispatchTool({ id: 'c3', name: 'query_calendar', args: {} }, ctx('user_message'), { handlers: [calendar!] });
    expect(result.ok).toBe(true);
  });
});

describe('Fix targets', () => {
  it('populated calendar succeeds with the offload store wired: stored_output + head + read_with', async () => {
    const [calendar] = googleHandlers(googleWith(populatedEvents, []), desk, clock);
    const offload = inMemoryToolOutputStore();
    const result = await dispatchTool(
      { id: 'c4', name: 'query_calendar', args: { date_range: { from: '2026-09-25T00:00:00+05:30', to: '2026-10-10T23:59:59+05:30' } } },
      ctx('user_message'),
      { handlers: [calendar!], offload },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { stored_output?: string; head?: string; read_with?: string };
      expect(data.stored_output).toBeDefined();
      expect(data.read_with).toBe('read_tool_output');
      // Redaction markers ([REDACTED_EMAIL] etc.) legitimately expand the head past the raw
      // slice bound; the load-bearing property is that the model-facing payload stays small.
      expect(data.head!.length).toBeLessThanOrEqual(4_096);
      expect(JSON.stringify(data).length).toBeLessThanOrEqual(4_096 + 1_024);
    }
  });

  it('a failed tool call surfaces its typed code:reason on the span, without result content', async () => {
    const [calendar] = googleHandlers(googleWith(populatedEvents, []), desk, clock);
    const events: { ok: boolean; error?: string }[] = [];
    const { runToolLoop } = await import('../src/conversation/tool-loop');
    let stepped = 0;
    await runToolLoop({
      handlers: [calendar!],
      ctx: ctx('user_message'),
      maxSteps: 1,
      onTool: (event) => events.push({ ok: event.ok, error: event.error }),
      step: async () => {
        stepped += 1;
        if (stepped > 1) return { text: 'done' };
        return {
          text: '',
          tool_calls: [{ call_id: 'c5', name: 'query_calendar', arguments: JSON.stringify({ date_range: { from: '2026-09-25T00:00:00+05:30', to: '2026-10-10T23:59:59+05:30' } }) }],
        };
      },
    }).catch(() => undefined);
    expect(events).toHaveLength(1);
    expect(events[0]!.ok).toBe(false);
    expect(events[0]!.error).toMatch(/^oversize/);
    expect(events[0]!.error).not.toContain('Quarterly planning sync');
  });
});
