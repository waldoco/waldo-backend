// Tier-2 connector contract (BUILD_ORDER 12, AUTH_DECISION_SPEC addendum 7:34 PM):
// every service tool called while unconnected MUST fail with code 'auth_failed',
// MUST offer the connect link through the deliver channel (button) when one exists,
// and MUST NEVER place a URL in model-visible text. connect_service (tier 1) and
// propose_calendar_change (desk-only) are exempt by design - the pinned name list
// below is the contract: adding a tier-2 handler without this behavior fails here.
import { describe, expect, it } from 'vitest';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import { GoogleError } from '../src/connectors/google';

const clock = { timezone: 'Asia/Calcutta', now: () => new Date('2026-09-24T10:00:00Z') };
const desk = { propose: async () => 'proposal:1', record: () => undefined };

const TIER2_HANDLERS = ['query_calendar', 'get_communication', 'draft_email'];

describe('tier-2 connector contract', () => {
  it('pins which google handlers are tier-2 (update this list with any new connector tool)', () => {
    const names = googleHandlers({ client: async () => null, connectUrl: async () => null }, desk, clock).map((h) => h.name);
    expect(names.sort()).toEqual([...TIER2_HANDLERS, 'propose_calendar_change'].sort());
  });

  it('every tier-2 handler fails auth_failed while unconnected and never leaks a URL', async () => {
    for (const name of TIER2_HANDLERS) {
      const sent: string[] = [];
      const google: GoogleAccess = { client: async () => null, connectUrl: async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=zzz' };
      const handler = googleHandlers(google, desk, clock, async (url) => (sent.push(url), true)).find((h) => h.name === name)!;
      const result = await handler.handle({ include_declined: false, limit: 5 } as never);
      expect(result, name).toMatchObject({ ok: false, code: 'auth_failed' });
      expect(JSON.stringify(result), name).not.toMatch(/https?:|state=/);
      expect(sent, name).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=zzz']);
    }
  });

  it('a 403 scope rejection also maps to auth_failed with the link, not a generic error', async () => {
    const sent: string[] = [];
    const google: GoogleAccess = {
      client: async () => ({
        events: async () => { throw new GoogleError(403, 'insufficient authentication scopes'); },
      }) as never,
      connectUrl: async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=scoped',
    };
    const query = googleHandlers(google, desk, clock, async (url) => (sent.push(url), true)).find((h) => h.name === 'query_calendar')!;
    const result = await query.handle({ include_declined: false, limit: 5 } as never);
    expect(result).toMatchObject({ ok: false, code: 'auth_failed' });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=/);
    expect(sent).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=scoped']);
  });
});
