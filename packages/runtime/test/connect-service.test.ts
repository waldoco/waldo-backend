import { describe, expect, it } from 'vitest';
import { connectServiceArgsSchema } from '@waldo/contracts';
import { connectServiceHandler } from '../src/tools/live/google';
import type { GoogleAccess } from '../src/tools/live/google';
import type { GoogleClient, GoogleFeature } from '../src/connectors/google';

const access = (client: GoogleClient | null, url: string | null): GoogleAccess => ({
  client: async (_feature?: GoogleFeature) => client,
  connectUrl: async (_feature: GoogleFeature) => url,
});

const ctx = {} as never;

describe('connect_service', () => {
  it('unconnected google returns the real consent URL with give-the-owner-this-link phrasing', async () => {
    const handler = connectServiceHandler(access(null, 'https://worker.example/oauth/google/start?state=abc'));
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(false);
    expect(result.data.message).toContain('Give the owner this link');
    expect(result.data.message).toContain('https://worker.example/oauth/google/start?state=abc');
  });

  it('connected google reports connected and never invents a URL', async () => {
    const handler = connectServiceHandler(access({} as GoogleClient, 'https://worker.example/should-not-appear'));
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(true);
    expect(result.data.message).not.toContain('http');
  });

  it('google not configured says so plainly, no fabricated link', async () => {
    const handler = connectServiceHandler(access(null, null));
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(false);
    expect(result.data.message).toContain('not set up');
    expect(result.data.message).not.toContain('http');
  });

  it('description names the connect/link/setup intent class so the model routes to it', () => {
    const handler = connectServiceHandler(access(null, null));
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
