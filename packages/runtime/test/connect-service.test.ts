import { describe, expect, it } from 'vitest';
import { connectServiceArgsSchema } from '@waldo/contracts';
import { connectServiceHandler } from '../src/tools/live/google';
import type { GoogleAccess } from '../src/tools/live/google';
import type { GoogleClient, GoogleFeature } from '../src/connectors/google';

const access = (client: GoogleClient | null): GoogleAccess => ({
  client: async (_feature?: GoogleFeature) => client,
});

const ctx = {} as never;

describe('connect_service', () => {
  it('unconnected google returns a typed connect intent and NEVER a URL in model-visible text (S4)', async () => {
    const handler = connectServiceHandler(access(null));
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result).toMatchObject({
      ok: false, code: 'auth_failed',
      connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: 'calendar' },
    });
    // The model only ever reads fixed words; the responder turns the intent into the button.
    expect(JSON.stringify(result)).not.toContain('https://');
    expect(JSON.stringify(result)).not.toContain('state=');
    if (result.ok) return;
    expect(result.error).toContain('connect button');
  });

  it('connected google reports connected, never invents a URL', async () => {
    const handler = connectServiceHandler(access({} as GoogleClient));
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(true);
    expect(result.data.message).not.toContain('http');
  });

  it('description names the connect/link/setup intent class so the model routes to it', () => {
    const handler = connectServiceHandler(access(null));
    expect(handler.description).toMatch(/connect/i);
    expect(handler.description).toMatch(/link/i);
    expect(handler.description).toMatch(/set up/i);
    expect(handler.name).toBe('connect_service');
  });
});

describe('connectServiceArgsSchema', () => {
  it('rejects an unknown service - no free-text service names reach the handler', () => {
    expect(connectServiceArgsSchema.safeParse({ service: 'gmail' }).success).toBe(false);
  });

  it('rejects smuggled extra args (strictObject, ADR-0029)', () => {
    expect(connectServiceArgsSchema.safeParse({ service: 'google', auto: true }).success).toBe(false);
  });
});
