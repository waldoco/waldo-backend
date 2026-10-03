import { describe, expect, it } from 'vitest';
import { GoogleError } from '../src/connectors/google';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';

// Issue #663. Pins how each Google READ tool turns a provider status into an owner-facing result.
// Layer: SOURCE unit. Drive (read-drive.test.ts) and MCP (mcp-google-auth.test.ts) are pinned elsewhere.
// 401 = stored grant dead -> reconnect intent. 5xx/other = transient, no connect prompt.
// 403 is CHARACTERIZATION of current behavior: these four-feature reads answer a blanket scope_missing
// consent prompt, while Drive refuses with the provider's words and no prompt. That divergence is
// recorded here, not endorsed; changing it is a behavior decision for the owner/Dalda, not this slice.
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-03T08:00:00Z') };
const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => undefined };
const failing = (status: number): GoogleAccess => ({
  client: async () => new Proxy({}, { get: (_t, k) => k === 'then' ? undefined : async () => { throw new GoogleError(status, `provider ${status}`); } }) as never,
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
    it(`${name}: 403 currently -> scope_missing consent prompt (characterization, see header)`, async () => {
      const r = await run(failing(403), name, args);
      expect(r).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'scope_missing', feature } });
    });
  }
});
