import { describe, expect, it } from 'vitest';
import worker from '../src/index';

describe('healthz', () => {
  it('returns ok with the release, before any auth or flag gates', async () => {
    const res = await worker.fetch(new Request('https://waldo.invalid/healthz'), {
      WALDO_RELEASE: 'abc123',
    } as unknown as Cloudflare.Env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, release: 'abc123' });
  });

  it('unknown paths still 404 when the public api is disabled', async () => {
    const res = await worker.fetch(new Request('https://waldo.invalid/nope'), {} as unknown as Cloudflare.Env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });
});
