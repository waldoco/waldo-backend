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
