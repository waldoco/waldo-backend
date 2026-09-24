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
  it('unconnected google delivers the signed URL via the button channel and NEVER puts it in model-visible text', async () => {
    const sent: string[] = [];
    const handler = connectServiceHandler(access(null, 'https://worker.example/oauth/google/start?state=abc'), async (url) => { sent.push(url); return true; });
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(false);
    // The signed link must travel only through the button channel (live-proven: models rewrite URLs when relaying).
    expect(sent).toEqual(['https://worker.example/oauth/google/start?state=abc']);
    expect(result.data.message).not.toContain('https://');
    expect(result.data.message).not.toContain('state=abc');
    expect(result.data.message).toContain('button');
  });

  it('without a deliver capability the URL still never leaks into model text', async () => {
    const handler = connectServiceHandler(access(null, 'https://worker.example/oauth/google/start?state=abc'));
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.message).not.toContain('https://');
    expect(result.data.message).not.toContain('state=abc');
    expect(result.data.message).toContain('could not be sent');
  });

  it('a failed button send degrades honestly without exposing the URL', async () => {
    const handler = connectServiceHandler(access(null, 'https://worker.example/oauth/google/start?state=abc'), async () => false);
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.message).toContain('could not be sent');
    expect(result.data.message).not.toContain('https://');
  });

  it('connected google reports connected, never invents a URL, never sends a button', async () => {
    let delivered = 0;
    const handler = connectServiceHandler(access({} as GoogleClient, 'https://worker.example/should-not-appear'), async () => { delivered += 1; return true; });
    const result = await handler.handle({ service: 'google' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.connected).toBe(true);
    expect(result.data.message).not.toContain('http');
    expect(delivered).toBe(0);
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
