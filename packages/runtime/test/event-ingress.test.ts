import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT_INGRESS_PREFIX, handleEventIngress, parseEventSources, type EventIngressEnv } from '../src/channels/event-ingress';

const namespace = () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};

const sign = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const SOURCES = JSON.stringify({
  github: { secret: 'gh-secret', verify: 'hmac-sha256', owner_do: 'do-main', timezone: 'Asia/Kolkata' },
  uptime: { secret: 'up-secret', verify: 'token', owner_do: 'do-main', notify: false },
});

const post = (source: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`https://w.test${EVENT_INGRESS_PREFIX}${source}`, { method: 'POST', body, headers });

const run = async (request: Request, env: EventIngressEnv) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleEventIngress(request, env, (work) => pending.push(work));
  await Promise.all(pending);
  return response;
};

afterEach(() => vi.unstubAllGlobals());

describe('handleEventIngress', () => {
  it('routes a verified GitHub push to the pinned owner DO as a capped envelope', async () => {
    const { fetch, idFromName, ns } = namespace();
    const env: EventIngressEnv = { TELEGRAM_OWNER_DO: ns, WALDO_EVENT_SOURCES: SOURCES };
    const body = JSON.stringify({
      repository: { full_name: 'waldoco/waldo-backend' },
      pusher: { name: 'octocat' },
      commits: [{ message: 'fix the thing\n\nlong body here' }],
      head_commit: { message: 'fix the thing\n\nlong body here' },
      compare: 'https://github.com/waldoco/waldo-backend/compare/a...b',
    });
    const response = await run(post('github', body, { 'x-github-event': 'push', 'x-hub-signature-256': await sign('gh-secret', body) }), env);
    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('do-main');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://telegram-owner/event');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-waldo-event-source']).toBe('github');
    expect((init.headers as Record<string, string>)['x-waldo-timezone']).toBe('Asia/Kolkata');
    expect((init.headers as Record<string, string>)['x-waldo-event-notify']).toBe('1');
    const envelope = JSON.parse(init.body as string);
    expect(envelope).toMatchObject({
      subject: 'waldoco/waldo-backend', kind: 'push',
      title: 'octocat pushed 1 commit: fix the thing',
      url: 'https://github.com/waldoco/waldo-backend/compare/a...b',
    });
    expect(envelope.title).not.toContain('long body here');
  });

  it('rejects a bad signature with 403 and never wakes the owner', async () => {
    const { fetch, ns } = namespace();
    const env: EventIngressEnv = { TELEGRAM_OWNER_DO: ns, WALDO_EVENT_SOURCES: SOURCES };
    const body = JSON.stringify({ repository: { full_name: 'r' }, commits: [] });
    const response = await run(post('github', body, { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=deadbeef' }), env);
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a token source and forwards notify=0 when the source is record-only', async () => {
    const { fetch, ns } = namespace();
    const env: EventIngressEnv = { TELEGRAM_OWNER_DO: ns, WALDO_EVENT_SOURCES: SOURCES };
    const body = JSON.stringify({ subject: 'api', kind: 'down', title: 'API is unreachable', detail: 'x'.repeat(500) });
    const response = await run(post('uptime', body, { 'x-waldo-event-token': 'up-secret' }), env);
    expect(response.status).toBe(200);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-waldo-event-notify']).toBe('0');
    const envelope = JSON.parse(init.body as string);
    expect(envelope.detail.length).toBeLessThanOrEqual(400);
  });

  it('acknowledges and drops malformed or unknown-event payloads without waking anyone', async () => {
    const { fetch, ns } = namespace();
    const env: EventIngressEnv = { TELEGRAM_OWNER_DO: ns, WALDO_EVENT_SOURCES: SOURCES };
    const missing = JSON.stringify({ hello: 'world' });
    expect((await run(post('uptime', missing, { 'x-waldo-event-token': 'up-secret' }), env)).status).toBe(200);
    const star = JSON.stringify({ action: 'created' });
    expect((await run(post('github', star, { 'x-github-event': 'star', 'x-hub-signature-256': await sign('gh-secret', star) }), env)).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('404s unconfigured sources, missing config, and non-POST', async () => {
    const { ns } = namespace();
    const env: EventIngressEnv = { TELEGRAM_OWNER_DO: ns, WALDO_EVENT_SOURCES: SOURCES };
    expect((await run(post('stripe', '{}'), env)).status).toBe(404);
    expect((await run(post('github', '{}'), { TELEGRAM_OWNER_DO: ns })).status).toBe(404);
    expect((await handleEventIngress(new Request(`https://w.test${EVENT_INGRESS_PREFIX}github`), env, () => undefined)).status).toBe(404);
  });

  it('parses source config defensively', () => {
    expect(parseEventSources(undefined)).toEqual({});
    expect(parseEventSources('not json')).toEqual({});
    expect(parseEventSources('[1,2]')).toEqual({});
    expect(Object.keys(parseEventSources(SOURCES))).toEqual(['github', 'uptime']);
  });

  it('caps a hostile oversize title instead of storing it whole', async () => {
    const { fetch, ns } = namespace();
    const env: EventIngressEnv = { TELEGRAM_OWNER_DO: ns, WALDO_EVENT_SOURCES: SOURCES };
    const body = JSON.stringify({ subject: 'api', kind: 'down', title: 'T'.repeat(5000) });
    await run(post('uptime', body, { 'x-waldo-event-token': 'up-secret' }), env);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const envelope = JSON.parse(init.body as string);
    expect(envelope.title.length).toBeLessThanOrEqual(200);
  });
});
