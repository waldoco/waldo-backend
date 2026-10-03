import { expect, it } from 'vitest';
import { connectorBackedTools } from '@waldo/contracts';
import { googleHandlers } from '../src/tools/live/google';
const google = { client: async () => null };
const desk = {} as never;
const clock = { now: () => new Date('2026-10-02T00:00:00Z') } as never;
it('the Google read, draft and send handlers declare requires_connector; propose_calendar_change stays desk-only', () => {
  const handlers = googleHandlers(google as never, desk, clock);
  const declared = connectorBackedTools(handlers);
  expect(declared).toEqual(['draft_email', 'get_communication', 'get_tasks', 'query_availability', 'query_calendar', 'read_thread', 'search_communication', 'send_email']);
});
it('omitting the declaration is not connector-backed', () => {
  expect(connectorBackedTools([{ name: 'read_thread' }, { name: 'get_tasks', requires_connector: true }])).toEqual(['get_tasks']);
});

it('guard: any Google handler that reaches the Google client at runtime must declare requires_connector', async () => {
  const touched = new Set<string>();
  let current = '';
  const probe = { client: async () => { touched.add(current); return null; } };
  const handlers = googleHandlers(probe as never, { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => undefined } as never, { timezone: 'UTC', now: () => new Date('2026-10-05T03:00:00Z') } as never);
  const range = { from: '2026-10-05T09:00:00+05:30', to: '2026-10-05T17:00:00+05:30' };
  const args: Record<string, unknown> = {
    query_calendar: { date_range: range, limit: 5 }, get_communication: { date_range: range, limit: 5 }, search_communication: { query: 'x', limit: 5 },
    read_thread: { thread_id: 't', limit: 5 }, get_tasks: { status: 'all', limit: 5 },
    draft_email: { to: ['a@example.invalid'], subject: 's', body: 'b' }, send_email: { to: ['a@example.invalid'], subject: 's', body: 'b' },
    query_availability: { date_range: range, calendar_ids: ['primary'], duration_minutes: 30, work_windows: [] },
    propose_calendar_change: { action: 'create', title: 't', start: range.from, end: range.to },
  };
  for (const h of handlers) {
    current = h.name;
    try { await (h as { handle(a: unknown, c: unknown): Promise<unknown> }).handle(args[h.name] ?? {}, { turnId: 'turn-1', toolCallId: 'call-1', authenticatedUserId: 'owner-1' }); } catch { /* only whether the client was reached matters */ }
  }
  // The probe must have seen the read handlers, so an empty set cannot pass the guard silently.
  expect(touched.size).toBeGreaterThanOrEqual(5);
  for (const h of handlers) expect(h.requires_connector === true, h.name).toBe(touched.has(h.name));
});
