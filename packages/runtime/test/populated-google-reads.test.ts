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

  it('ADVERSARIAL: a canary token in the tail (past the head) fails the offload guard; nothing raw is stored', async () => {
    const events = [
      ...populatedEvents.slice(0, 5),
      { ...populatedEvents[0]!, id: 'evt-tail', description: `${'z'.repeat(20_000)} tail marker ${canaryTokens[0]}` },
    ];
    const [calendar] = googleHandlers(googleWith(events, []), desk, clock);
    const store = inMemoryToolOutputStore();
    const result = await dispatchTool(
      { id: 'c6', name: 'query_calendar', args: {} },
      ctx('user_message'),
      { handlers: [calendar!], offload: store },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
    // the guard ran before the store: no output was persisted at all
    expect(store.read('to-1', 0, 16)).toBeNull();
  });

  it('ADVERSARIAL: a secret near a read boundary is redacted before storage; no chunk ever serves it raw', async () => {
    // Pad so the address lands within a few chars of the 4000-char head/read boundary.
    const secret = 'victim@example.com';
    const events = [
      {
        ...populatedEvents[0]!,
        id: 'evt-boundary',
        description: `${'x'.repeat(3_800)}${secret}${'y'.repeat(20_000)}`,
      },
    ];
    const [calendar] = googleHandlers(googleWith(events, []), desk, clock);
    const store = inMemoryToolOutputStore();
    const result = await dispatchTool(
      { id: 'c7', name: 'query_calendar', args: {} },
      ctx('user_message'),
      { handlers: [calendar!], offload: store },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { stored_output: string; head: string };
    // every read-back chunk, walked across the whole stored output through actual dispatch, is
    // already guarded and carries the external taint (a direct reader.handle call would miss
    // the parseToolResult boundary - that bypass rejected nothing pre-fix and hid the
    // EXTERNAL_ORIGIN_TOOLS gap behind invalid_handler_result in production)
    const { readToolOutputHandler } = await import('../src/tools/read-tool-output');
    const reader = readToolOutputHandler(store);
    let offset = 0;
    let combined = '';
    let dispatched = 0;
    for (let i = 0; i < 32; i += 1) {
      const slice = await dispatchTool(
        { id: `r${i}`, name: 'read_tool_output', args: { id: data.stored_output, offset, length: 997 } },
        ctx('user_message'),
        { handlers: [reader] },
      );
      if (!slice.ok) break;
      dispatched += 1;
      expect(slice.source_taint).toBe('external');
      const sliceData = slice.data as { text: string; next_offset: number | null };
      expect(sliceData.text).not.toContain(secret);
      combined += sliceData.text;
      if (sliceData.next_offset === null) break;
      offset = sliceData.next_offset;
    }
    expect(dispatched).toBeGreaterThan(0);
    expect(combined).not.toContain(secret);
    expect(combined).toContain('[REDACTED_EMAIL]');
    expect(data.head).not.toContain(secret);
  });

  it('the store enforces an aggregate byte budget: oldest outputs evict, newest always survives', async () => {
    const { MAX_STORED_OUTPUT_CHARS } = await import('../src/conversation/tool-output-store');
    const store = inMemoryToolOutputStore();
    // items sized under the per-item bound so the aggregate budget is what bites
    const chunk = 'q'.repeat(64_000);
    const ids: string[] = [];
    const puts = Math.ceil(MAX_STORED_OUTPUT_CHARS / 64_001) + 2;
    for (let i = 0; i < puts; i += 1) ids.push(store.put(`${chunk}${i}`).id);
    // oldest entries evicted beyond the budget; the newest is always kept
    expect(store.read(ids[0]!, 0, 8)).toBeNull();
    const latest = store.read(ids[puts - 1]!, 0, 8);
    expect(latest).not.toBeNull();
    expect(latest!.total).toBe(64_001);
    // an evicted id is a typed not_found through actual dispatch, tainted external
    const { readToolOutputHandler } = await import('../src/tools/read-tool-output');
    const reader = readToolOutputHandler(store);
    const missing = await dispatchTool(
      { id: 'r-evicted', name: 'read_tool_output', args: { id: ids[0]!, offset: 0, length: 64 } },
      ctx('user_message'),
      { handlers: [reader] },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('not_found');
    const kept = await dispatchTool(
      { id: 'r-kept', name: 'read_tool_output', args: { id: ids[puts - 1]!, offset: 0, length: 64 } },
      ctx('user_message'),
      { handlers: [reader] },
    );
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.source_taint).toBe('external');
  });

  it('the store enforces a per-item bound on the stored post-redaction text, truthfully reported', async () => {
    const { MAX_STORED_ITEM_CHARS } = await import('../src/conversation/tool-output-store');
    const store = inMemoryToolOutputStore();
    const put = store.put('r'.repeat(MAX_STORED_ITEM_CHARS * 2));
    // no silent slice: the caller learns the stored length, the original length, and the flag
    expect(put).toEqual({ id: 'to-1', stored_chars: MAX_STORED_ITEM_CHARS, original_chars: MAX_STORED_ITEM_CHARS * 2, truncated: true });
    const whole = store.read(put.id, 0, MAX_STORED_ITEM_CHARS * 2);
    expect(whole).not.toBeNull();
    expect(whole!.total).toBe(MAX_STORED_ITEM_CHARS);
    expect(whole!.original_chars).toBe(MAX_STORED_ITEM_CHARS * 2);
    expect(whole!.truncated).toBe(true);
    expect(whole!.next_offset).toBeNull();
    // a small item is stored whole, unbounded reads return it intact and untruncated
    const small = store.put('short output');
    expect(small.truncated).toBe(false);
    expect(store.read(small.id, 0, 4_000)!.text).toBe('short output');
  });

  it('DISPATCH-LEVEL: post-redaction output over the item cap gets a truthful receipt; only the stored part is ever served', async () => {
    const { MAX_STORED_ITEM_CHARS } = await import('../src/conversation/tool-output-store');
    const events = [
      { ...populatedEvents[0]!, id: 'evt-huge', description: 'w'.repeat(MAX_STORED_ITEM_CHARS + 20_000) },
    ];
    const [calendar] = googleHandlers(googleWith(events, []), desk, clock);
    const store = inMemoryToolOutputStore();
    const result = await dispatchTool(
      { id: 'c8', name: 'query_calendar', args: {} },
      ctx('user_message'),
      { handlers: [calendar!], offload: store },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { stored_output: string; total_chars: number; stored_chars: number; truncated: boolean; head: string };
    // the receipt describes the STORED text honestly: full guarded length vs kept length + flag
    expect(data.truncated).toBe(true);
    expect(data.stored_chars).toBe(MAX_STORED_ITEM_CHARS);
    expect(data.total_chars).toBeGreaterThan(MAX_STORED_ITEM_CHARS);
    // read-backs carry the same truth per slice and never serve past the stored end
    const { readToolOutputHandler } = await import('../src/tools/read-tool-output');
    const reader = readToolOutputHandler(store);
    const pastEnd = await dispatchTool(
      { id: 'r-past', name: 'read_tool_output', args: { id: data.stored_output, offset: MAX_STORED_ITEM_CHARS, length: 4_000 } },
      ctx('user_message'),
      { handlers: [reader] },
    );
    expect(pastEnd.ok).toBe(true);
    if (pastEnd.ok) {
      const sliceData = pastEnd.data as { text: string; truncated: boolean; original_chars: number; next_offset: number | null };
      expect(sliceData.text).toBe('');
      expect(sliceData.next_offset).toBeNull();
      expect(sliceData.truncated).toBe(true);
      expect(sliceData.original_chars).toBe(data.total_chars);
    }
  });

  it('a failed tool call surfaces its typed code/reason as their own fields, without result content', async () => {
    const [calendar] = googleHandlers(googleWith(populatedEvents, []), desk, clock);
    const events: { ok: boolean; error?: string; code?: string; reason?: string }[] = [];
    const { runToolLoop } = await import('../src/conversation/tool-loop');
    let stepped = 0;
    await runToolLoop({
      handlers: [calendar!],
      ctx: ctx('user_message'),
      maxSteps: 1,
      onTool: (event) => events.push({ ok: event.ok, error: event.error, code: event.code, reason: event.reason }),
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
    expect(events[0]!.code).toMatch(/^oversize/);
    expect(events[0]!.code).not.toContain('Quarterly planning sync');
    expect(events[0]!.reason ?? '').not.toContain('Quarterly planning sync');
    expect(events[0]!.error ?? '').not.toContain('Quarterly planning sync');
  });
});
