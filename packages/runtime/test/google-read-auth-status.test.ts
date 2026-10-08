import { describe, expect, it } from 'vitest';
import { GoogleError } from '../src/connectors/google';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';

// Issue #665. Pins how each Google READ tool turns a provider status into an owner-facing result.
// Layer: SOURCE unit. Drive (read-drive.test.ts) and MCP (mcp-google-auth.test.ts) are pinned elsewhere.
// 401 = stored grant dead -> reconnect intent. 5xx/other = transient, no connect prompt.
// 403 (issue #668): consent is offered only on structured scope evidence (ACCESS_TOKEN_SCOPE_INSUFFICIENT); a disabled API
// or an unexplained denial returns the provider's words with no prompt, matching Drive.
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-03T08:00:00Z') };
const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => undefined };
const failing = (status: number, reason?: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' | 'SERVICE_DISABLED'): GoogleAccess => ({
  client: async () => new Proxy({}, { get: (_t, k) => k === 'then' ? undefined : async () => { throw new GoogleError(status, `provider ${status}`, reason); } }) as never,
});
const READS = [
  ['query_calendar', { include_declined: false, limit: 20 }, 'calendar'],
  ['get_communication', { limit: 10 }, 'mail'],
  ['search_communication', { query: 'x', limit: 10 }, 'mail'],
  ['read_thread', { thread_id: 't1', limit: 10 }, 'mail'],
  ['get_tasks', { status: 'open', limit: 10 }, 'tasks'],
] as const;
const run = (access: GoogleAccess, name: string, args: unknown) =>
  googleHandlers(access, desk, clock).find((h) => h.name === name)!.handle(args as never);

describe('google read tools: provider status to owner-facing result', () => {
  for (const [name, args, feature] of READS) {
    it(`${name}: 401 -> reauth_needed connect intent (no URL), feature ${feature}`, async () => {
      const r = await run(failing(401), name, args);
      expect(r).toMatchObject({ ok: false, code: 'auth_failed', source_taint: 'external', connect: { status: 'auth_required', service: 'google', reason: 'reauth_needed', feature } });
      expect(JSON.stringify(r)).not.toMatch(/https?:|state=|accounts\.google/);
    });
    it(`${name}: 500 -> transient, no connect prompt`, async () => {
      const r = await run(failing(500), name, args);
      expect(r).toMatchObject({ ok: false, code: 'transient', source_taint: 'external' });
      expect((r as { connect?: unknown }).connect).toBeUndefined();
    });
    it(`${name}: 403 with no structured reason -> plain refusal, no consent prompt`, async () => {
      const r = await run(failing(403), name, args);
      expect(r).toMatchObject({ ok: false, code: 'rejected', source_taint: 'external' });
      expect((r as { connect?: unknown }).connect).toBeUndefined();
    });
    it(`${name}: 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT -> scope_missing consent prompt`, async () => {
      const r = await run(failing(403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'), name, args);
      expect(r).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'scope_missing', feature } });
    });
    it(`${name}: 403 SERVICE_DISABLED -> refusal naming the disabled API, no consent prompt`, async () => {
      const r = await run(failing(403, 'SERVICE_DISABLED'), name, args);
      expect(r).toMatchObject({ ok: false, code: 'rejected', error: expect.stringContaining('API is disabled') });
      expect((r as { connect?: unknown }).connect).toBeUndefined();
    });
  }
});

describe('google read tools: connected-but-dead grant asks for reconnect, not a fresh connect', () => {
  const deadGrant = (error: string | null): GoogleAccess => ({
    client: async () => null,
    state: async () => [{ id: 'conn-1', email: 'me@example.com', error, calendar: true, mail: true, tasks: true }],
  });
  for (const [name, args, feature] of READS) {
    it(`${name}: no serving client while a connected account is failing -> reauth_needed (${feature})`, async () => {
      const r = await run(deadGrant('google token failed: invalid_grant'), name, args);
      expect(r).toMatchObject({ ok: false, code: 'auth_failed', source_taint: 'external', connect: { status: 'auth_required', service: 'google', reason: 'reauth_needed', feature } });
      expect(JSON.stringify(r)).not.toMatch(/https?:|state=|accounts\.google/);
    });
  }
  it('no serving client and no failing account -> not_connected', async () => {
    const r = await run(deadGrant(null), 'query_calendar', { include_declined: false, limit: 20 });
    expect(r).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'not_connected' } });
  });
  it('no serving client and a failing account that does not cover the feature -> not_connected', async () => {
    const access: GoogleAccess = {
      client: async () => null,
      state: async () => [{ id: 'conn-1', email: 'me@example.com', error: 'google token failed: invalid_grant', calendar: false, mail: false, tasks: false }],
    };
    const r = await run(access, 'query_calendar', { include_declined: false, limit: 20 });
    expect(r).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'not_connected' } });
  });
  it('no serving client and no state seam -> not_connected (unchanged)', async () => {
    const r = await run({ client: async () => null }, 'query_calendar', { include_declined: false, limit: 20 });
    expect(r).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'not_connected' } });
  });
});
