import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApp } from '../src/channels/app-api';
import { md5Hex } from '../src/channels/md5';
import type { ConsoleAuth } from '../src/identity/console-auth';

// A refused upload stores no receipt, so its closed code and status are counted for the console's freshness view. The
// count is written after the answer, through the deferred lane, and never changes what the app is told.
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
let limiterAllows = true;
const env = () => ({
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: limiterAllows }) },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
}) as never;

const VALUE = 1234;
const sample = { sample_id: 'steps-2026-10-10T08', revision: 1_760_000_000, signal: 'steps_window', unit: 'count', value: VALUE, start_at: '2026-10-10T08:00:00Z', end_at: '2026-10-10T09:00:00Z', day: '2026-10-10', utc_offset_minutes: 0 };
const batch = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 1, timezone: 'Asia/Kolkata', anchor_before: null, anchor_after: 'opaque-anchor-1', samples: [sample], deletions: [] };
const receipt = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 1, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'opaque-anchor-1', replayed: false };

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let ingestAnswer: unknown = receipt;
let noteAnswer: () => Promise<Response> = async () => Response.json({ noted: true });
beforeEach(() => {
  rpcs.length = 0; limiterAllows = true; ingestAnswer = receipt; noteAnswer = async () => Response.json({ noted: true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1]!;
    rpcs.push({ fn, body: JSON.parse(String(init.body)) });
    return fn === 'health_refusal_note' ? noteAnswer() : Response.json(ingestAnswer);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const upload = async (body: unknown, extra: Record<string, string> = {}) => {
  const deferred: Promise<unknown>[] = [];
  const response = await handleApp(new Request('https://w.test/app/v1/health/ingest', {
    method: 'POST', headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env(), auth, work => { deferred.push(work); }) as Response;
  return { response, settle: () => Promise.all(deferred) };
};
const notes = () => rpcs.filter(r => r.fn === 'health_refusal_note').map(r => r.body);

describe('refused uploads are counted by code and status', () => {
  it('counts a refusal the Worker answers and one the database answers, signed for the session owner', async () => {
    const malformed = await upload({ ...batch, samples: [{ ...sample, unit: 'furlongs' }] });
    expect(malformed.response.status).toBe(400);
    await malformed.settle();
    ingestAnswer = { error: 'consent_withdrawn' };
    const withdrawn = await upload(batch);
    expect(withdrawn.response.status).toBe(403);
    await withdrawn.settle();
    expect(notes()).toEqual([
      expect.objectContaining({ p_do_name: 'owner-1', p_payload: '{"code":"invalid_request","status":400}' }),
      expect.objectContaining({ p_do_name: 'owner-1', p_payload: '{"code":"consent_withdrawn","status":403}' }),
    ]);
  });
  it('counts an oversize body by its own status', async () => {
    const big = await upload('x'.repeat(10), { 'content-length': '999999' });
    expect(big.response.status).toBe(413);
    await big.settle();
    expect(notes().map(n => n.p_payload)).toEqual(['{"code":"invalid_request","status":413}']);
  });
  it('signs the note over its exact payload, so the database binds code and status to the owner', async () => {
    const { routerSignature } = await import('../src/identity/owner-directory');
    ingestAnswer = { error: 'anchor_conflict' };
    const refused = await upload(batch);
    await refused.settle();
    const [note] = notes();
    expect(note!.p_sig).toBe(await routerSignature('fictional-router-secret', note!.p_at as number, `health.refusal_note.owner-1.${md5Hex('{"code":"anchor_conflict","status":409}')}`));
  });
  it('counts nothing for an accepted upload', async () => {
    const accepted = await upload(batch);
    expect(accepted.response.status).toBe(200);
    await accepted.settle();
    expect(notes()).toEqual([]);
  });
  it('counts nothing for a call refused before the health route: no credential, or the rate limit', async () => {
    const unsigned = await handleApp(new Request('https://w.test/app/v1/health/ingest', { method: 'POST', body: '{}' }), env(), auth, () => { throw new Error('nothing to defer'); }) as Response;
    expect(unsigned.status).toBe(401);
    limiterAllows = false;
    const limited = await upload(batch);
    expect(limited.response.status).toBe(429);
    await limited.settle();
    expect(rpcs).toEqual([]);
  });
  it('carries no reading, no request id and no anchor', async () => {
    ingestAnswer = { error: 'sample_conflict' };
    const refused = await upload(batch);
    await refused.settle();
    const payload = String(notes()[0]!.p_payload);
    expect(JSON.parse(payload)).toEqual({ code: 'sample_conflict', status: 409 });
    for (const text of [String(VALUE), 'health-upload-001', 'opaque-anchor-1', 'steps']) expect(payload).not.toContain(text);
  });
});

describe('the count never changes the answer', () => {
  it('answers the same when the note fails', async () => {
    ingestAnswer = { error: 'epoch_conflict' };
    const counted = await upload(batch);
    const expected = [counted.response.status, await counted.response.json()];
    await counted.settle();
    noteAnswer = async () => { throw new Error('database down'); };
    const failed = await upload(batch);
    expect([failed.response.status, await failed.response.json()]).toEqual(expected);
    await expect(failed.settle()).resolves.toBeDefined();
    noteAnswer = async () => Response.json({ message: 'unsigned router call' }, { status: 401 });
    const rejected = await upload(batch);
    expect([rejected.response.status, await rejected.response.json()]).toEqual(expected);
    await expect(rejected.settle()).resolves.toBeDefined();
  });
  it('answers at once when the note hangs', async () => {
    ingestAnswer = { error: 'epoch_conflict' };
    noteAnswer = () => new Promise<Response>(() => {});
    const hung = await Promise.race([upload(batch), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 1_000))]);
    expect(hung).not.toBe('timeout');
    expect((hung as Awaited<ReturnType<typeof upload>>).response.status).toBe(409);
  });
});
