// The app's phone view on the one controls path: GET /app/v1/controls?view=phone reads the number on file, and
// POST /app/v1/actions texts or checks a code through the same control-action receipt book the app already reads back.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { appControlsRequest, type AppControlsHost } from '../src/channels/app-controls';

const SERVICE = `VA${'a'.repeat(32)}`, SID = `VE${'b'.repeat(32)}`, TOKEN = 'synthetic-twilio-token-for-app', CODE = '424242', PHONE = '+919800000001';
const phoneEnv = (on: string) => ({
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
  PHONE_SMS_VERIFY: on, TWILIO_ACCOUNT_SID: `AC${'c'.repeat(32)}`, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_VERIFY_SERVICE_SID: SERVICE,
});
const unused = () => { throw Error('The phone view reads the signed ledger only'); };
afterEach(() => { vi.unstubAllGlobals(); });

function world() {
  const open = { expires_at: 1, retry_at: null, checks_left: 5 };
  const ledger = { phone: PHONE as string | null, verified: false, challenge: null as Record<string, unknown> | null };
  const twilio: Record<string, string>[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://verify.twilio.com/')) {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      twilio.push(form);
      return Response.json({ service_sid: SERVICE, sid: SID, to: PHONE, channel: 'sms', status: url.endsWith('/Verifications') || form.Code !== CODE ? 'pending' : 'approved' });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1], args = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    if (fn === 'owner_phone_state') return Response.json(ledger);
    const payload = JSON.parse(args.p_payload ?? '{}') as Record<string, string>;
    if (args.p_action === 'reserve_send') { ledger.challenge = { ...open, state: 'sending' }; return Response.json({ kind: 'reserved', phone: ledger.phone }); }
    if (args.p_action === 'finish_send') { ledger.challenge = { ...open, state: 'pending' }; return Response.json({ kind: 'pending' }); }
    if (args.p_action === 'reserve_check') { ledger.challenge = { ...open, state: 'checking' }; return Response.json({ kind: 'reserved', reference: { service: SERVICE, sid: SID, phone: PHONE } }); }
    if (args.p_action === 'finish_check') {
      const approved = payload.outcome === 'approved';
      ledger.verified ||= approved; ledger.challenge = { ...open, state: approved ? 'approved' : 'pending' };
      return Response.json({ kind: payload.outcome });
    }
    return new Response('unexpected', { status: 500 });
  });
  return { ledger, twilio };
}
const app = (on: string, run: (o: { read(): Promise<{ status: number; body: Record<string, unknown> }>; act(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>; storage: DurableObjectStorage }) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-phone-${crypto.randomUUID()}`)), async (_i, state) => {
    const host: AppControlsHost = { csrf: 'c'.repeat(64), expires: Date.now() + 60_000, storage: state.storage, assertCurrent: async () => {},
      sessions: async () => [{ csrf: 'c'.repeat(64), expires: Date.now() + 60_000 }], view: unused, act: unused,
      account: { owner: 'owner-app-phone', auth: null, requestUrl: 'https://app.fixture.invalid/app/v1/controls', purgeOwnerFiles: unused, eraseOwnerStorage: unused },
      phone: phoneEnv(on) };
    const call = async (request: Request) => { const response = await appControlsRequest(request, host); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
    await run({
      read: () => call(new Request('https://app.fixture.invalid/app/v1/controls?view=phone')),
      act: (body) => call(new Request('https://app.fixture.invalid/app/v1/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
      storage: state.storage,
    });
  });

it('reads the number on file, texts a code to it and proves it, with receipts the app can read back', async () => {
  const w = world();
  await app('1', async ({ read, act, storage }) => {
    const first = await read();
    expect(first.status).toBe(200);
    const projection = appControlProjectionV1Schema.parse(first.body);
    expect(projection).toMatchObject({ view: 'phone', data: { phone: PHONE, verified: false, sms: true, challenge: null, actions: ['phone.sms_send'] } });
    expect(first.body).not.toHaveProperty('csrf');
    const sent = await act({ view: 'phone', action: 'phone.sms_send', revision: projection.revision, request_id: 'phone-request-1' });
    expect(sent.status).toBe(200);
    expect(appControlResultV1Schema.parse(sent.body).receipt.state).toBe('recorded');
    expect(w.twilio).toEqual([{ To: PHONE, Channel: 'sms' }]);
    const waiting = appControlProjectionV1Schema.parse((await read()).body);
    expect(waiting).toMatchObject({ data: { actions: ['phone.sms_send', 'phone.sms_check'] } });
    const checked = await act({ view: 'phone', action: 'phone.sms_check', code: CODE, revision: waiting.revision, request_id: 'phone-request-2' });
    expect(appControlResultV1Schema.parse(checked.body).receipt).toEqual({ state: 'recorded', message: 'Your number is verified.' });
    const back = await appControlsRequest(new Request('https://app.fixture.invalid/app/v1/actions/phone-request-2'), {
      csrf: 'c'.repeat(64), expires: Date.now() + 60_000, storage, assertCurrent: async () => {}, sessions: unused, view: unused, act: unused,
      account: { owner: 'owner-app-phone', auth: null, requestUrl: '', purgeOwnerFiles: unused, eraseOwnerStorage: unused }, phone: phoneEnv('1') });
    expect(await back.json()).toMatchObject({ request_id: 'phone-request-2', duplicate: true, receipt: { state: 'recorded' } });
    expect(JSON.stringify([...(await storage.list()).entries()])).not.toMatch(new RegExp(`${CODE}|${TOKEN}`));
  });
});

it('refuses a number in the request, and a stale read, before anything is texted', async () => {
  const w = world();
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    expect((await act({ view: 'phone', action: 'phone.sms_send', value: '+14155550100', revision, request_id: 'phone-request-3' })).status).toBe(400);
    expect((await act({ view: 'phone', action: 'phone.sms_send', revision: 'f'.repeat(64), request_id: 'phone-request-4' })).body).toMatchObject({ error: 'stale_read' });
    expect(w.twilio).toEqual([]);
  });
});

it('with the switch off the app sees the number, no texting, and a send is refused', async () => {
  const w = world();
  await app('0', async ({ read, act }) => {
    const projection = appControlProjectionV1Schema.parse((await read()).body);
    expect(projection).toMatchObject({ data: { phone: PHONE, sms: false, actions: [] } });
    expect((await act({ view: 'phone', action: 'phone.sms_send', revision: projection.revision, request_id: 'phone-request-5' })).body).toMatchObject({ error: 'no_longer_eligible' });
    expect(w.twilio).toEqual([]);
    expect(w.ledger.challenge).toBeNull();
  });
});
