// Tier-2 connector contract (BUILD_ORDER 12, AUTH_DECISION_SPEC addendum 7:34 PM,
// CONNECT_FLOW_DESIGN 4.4 / S4): every service tool called while unconnected MUST fail with
// code 'auth_failed' carrying a typed ConnectIntent, and MUST NEVER place a URL in
// model-visible text - the responder turns the intent into the channel's connect affordance.
// propose_calendar_change (desk-only) is exempt by design - the pinned name list below is
// the contract: adding a tier-2 handler without this behavior fails here.
import { describe, expect, it } from 'vitest';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import { GoogleError } from '../src/connectors/google';

const clock = { timezone: 'Asia/Calcutta', now: () => new Date('2026-09-24T10:00:00Z') };
const desk = { propose: async () => 'proposal:1', proposeSendEmail: async () => ({ id: 'proposal:1', reused: null }), record: () => undefined };

const TIER2_HANDLERS = ['query_calendar', 'get_communication', 'draft_email', 'send_email', 'get_tasks'];

describe('tier-2 connector contract', () => {
  it('pins which google handlers are tier-2 (update this list with any new connector tool)', () => {
    const names = googleHandlers({ client: async () => null }, desk, clock).map((h) => h.name);
    expect(names.sort()).toEqual([...TIER2_HANDLERS, 'propose_calendar_change'].sort());
  });

  it('every tier-2 handler fails auth_failed with a typed connect intent and never leaks a URL', async () => {
    for (const name of TIER2_HANDLERS) {
      const google: GoogleAccess = { client: async () => null };
      const handler = googleHandlers(google, desk, clock).find((h) => h.name === name)!;
      const result = await handler.handle({ include_declined: false, limit: 5 } as never, { authenticatedUserId: 'owner-1', session: { rate_limit_window: { started_at: 0 } } } as never);
      expect(result, name).toMatchObject({
        ok: false, code: 'auth_failed',
        connect: { status: 'auth_required', service: 'google', reason: 'not_connected' },
      });
      expect(JSON.stringify(result), name).not.toMatch(/https?:|state=|\/c\//);
    }
  });

  it('a 403 scope rejection maps to auth_failed with a scope_missing intent, not a generic error', async () => {
    const google: GoogleAccess = {
      client: async () => ({
        events: async () => { throw new GoogleError(403, 'insufficient authentication scopes'); },
      }) as never,
    };
    const query = googleHandlers(google, desk, clock).find((h) => h.name === 'query_calendar')!;
    const result = await query.handle({ include_declined: false, limit: 5 } as never);
    expect(result).toMatchObject({
      ok: false, code: 'auth_failed',
      connect: { status: 'auth_required', service: 'google', reason: 'scope_missing', feature: 'calendar' },
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=/);
  });

  it('a 401 maps to a reauth_needed intent - a dead grant asks for reconnect, not a raw error', async () => {
    const google: GoogleAccess = {
      client: async () => ({
        events: async () => { throw new GoogleError(401, 'invalid grant'); },
      }) as never,
    };
    const query = googleHandlers(google, desk, clock).find((h) => h.name === 'query_calendar')!;
    const result = await query.handle({ include_declined: false, limit: 5 } as never);
    expect(result).toMatchObject({
      ok: false, code: 'auth_failed',
      connect: { status: 'auth_required', service: 'google', reason: 'reauth_needed', feature: 'calendar' },
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=/);
  });
});
