// The console's phone view through OwnerDO.fetch: it reads the number on file from the signed ledger, texts a code only
// through the listed action, takes nothing but the code from the browser, and keeps neither the code nor the Twilio token.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { consoleAccess } from '../src/channels/console';

const SERVICE = `VA${'a'.repeat(32)}`, SID = `VE${'b'.repeat(32)}`, TOKEN = 'synthetic-twilio-token-for-console', CODE = '424242';
const vars = {
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
  TWILIO_ACCOUNT_SID: `AC${'c'.repeat(32)}`, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_VERIFY_SERVICE_SID: SERVICE,
};
type Read = { csrf: string; revision: string; data: { phone: string | null; verified: boolean; sms: boolean; challenge: { state: string } | null; actions: string[] } };
type Acted = { status: number; body: { receipt?: { state: string; message: string }; error?: string; duplicate?: boolean } };

// A ledger that keeps one owner's number and challenge, and a Twilio that approves only CODE.
function world(phone: string | null) {
  const open = { expires_at: 1, retry_at: null as number | null, checks_left: 5 };
  const ledger = { phone, verified: false, challenge: null as null | { state: string; expires_at: number; retry_at: number | null; checks_left: number } };
  const twilio: URLSearchParams[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://verify.twilio.com/')) {
      const form = new URLSearchParams(String(init?.body));
      twilio.push(form);
      const status = url.endsWith('/Verifications') || form.get('Code') !== CODE ? 'pending' : 'approved';
      return Response.json({ service_sid: SERVICE, sid: SID, to: ledger.phone, channel: 'sms', status });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1], args = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    if (fn === 'owner_phone_state') return Response.json(ledger);
    if (fn !== 'phone_sms_transition') return new Response('unexpected', { status: 500 });
    const payload = JSON.parse(args.p_payload!) as Record<string, string>;
    const step = ({
      reserve_send: () => { ledger.challenge = { ...open, state: 'sending' }; return { kind: 'reserved', phone: ledger.phone }; },
      finish_send: () => { ledger.challenge = { ...open, state: 'pending' }; return { kind: 'pending' }; },
      reserve_check: () => { ledger.challenge = { ...open, state: 'checking' }; return { kind: 'reserved', reference: { service: SERVICE, sid: SID, phone: ledger.phone } }; },
      finish_check: () => {
        if (payload.outcome === 'approved') { ledger.verified = true; ledger.challenge = { ...open, state: 'approved' }; return { kind: 'approved' }; }
        ledger.challenge = { ...open, state: 'pending' }; return { kind: payload.outcome };
      },
    } as Record<string, () => unknown>)[args.p_action!];
    return Response.json(step ? step() : { kind: 'denied' });
  });
  return { ledger, twilio };
}
afterEach(() => { vi.unstubAllGlobals(); });

let n = 0;
const owner = (extra: Record<string, string | undefined>, work: (o: { read(): Promise<Read>; act(action: string, fields?: Record<string, string>): Promise<Acted>; actAs(requestId: string, action: string, fields?: Record<string, string>, revision?: string): Promise<Acted & { revision: string }>; state: DurableObjectState }) => Promise<void>) => {
  const name = `phone-console-${n++}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    const object = new OwnerDO(state, { ...env, ...vars, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined, ...extra });
    const cookie = `waldo_console=${await consoleAccess(state.storage).grant()}`;
    const read = async (): Promise<Read> => {
      const response = await object.fetch(new Request('https://owner/console/dashboard/api/v1/controls?view=phone', { headers: { cookie } }));
      expect(response.status).toBe(200);
      return response.json();
    };
    let request = 0;
    const actAs = async (requestId: string, action: string, fields: Record<string, string> = {}, revision?: string): Promise<Acted & { revision: string }> => {
      const current = await read();
      const used = revision ?? current.revision;
      const body = new URLSearchParams({ csrf: current.csrf, revision: used, view: 'phone', action, request_id: requestId, ...fields });
      const response = await object.fetch(new Request('https://owner/console/dashboard/api/v1/actions', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body }));
      return { status: response.status, body: await response.json(), revision: used };
    };
    const act = (action: string, fields: Record<string, string> = {}): Promise<Acted> => actAs(`phone-request-${++request}`, action, fields);
    await work({ read, act, actAs, state });
  });
};

describe('the console phone view', () => {
  it('texts a code to the number on file and proves it with the right code, keeping neither the code nor the token', async () => {
    const w = world('+919800000001');
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ read, act, state }) => {
      expect((await read()).data).toEqual({ phone: '+919800000001', verified: false, sms: true, challenge: null, actions: ['phone.sms_send'] });
      expect(await act('phone.sms_send')).toMatchObject({ status: 200, body: { receipt: { state: 'recorded', message: expect.stringContaining('within 10 minutes') } } });
      expect(w.twilio.map((form) => Object.fromEntries(form))).toEqual([{ To: '+919800000001', Channel: 'sms' }]);
      expect((await read()).data.actions).toEqual(['phone.sms_send', 'phone.sms_check']);
      expect(await act('phone.sms_check', { code: '111111' })).toMatchObject({ status: 409, body: { receipt: { message: 'That code did not match. Check it and try again.' } } });
      expect(await act('phone.sms_check', { code: '42 42 42' })).toMatchObject({ status: 200, body: { receipt: { state: 'recorded', message: 'Your number is verified.' } } });
      expect((await read()).data).toMatchObject({ verified: true, actions: [] });
      const stored = JSON.stringify([...(await state.storage.list()).entries()]);
      for (const secret of [CODE, '111111', TOKEN]) expect(stored).not.toContain(secret);
    });
  });

  it('keeps the code out of the receipt book: a retried request reads back its receipt whatever code it carries', async () => {
    world('+919800000001');
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ act, actAs }) => {
      await act('phone.sms_send');
      const first = await actAs('phone-retry', 'phone.sms_check', { code: '111111' });
      expect(first).toMatchObject({ status: 409, body: { receipt: { message: 'That code did not match. Check it and try again.' } } });
      expect(await actAs('phone-retry', 'phone.sms_check', { code: '222222' }, first.revision)).toMatchObject({ status: 409, body: { duplicate: true, receipt: first.body.receipt } });
    });
  });

  it('takes no number from the browser', async () => {
    const w = world('+919800000001');
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ act }) => {
      expect(await act('phone.sms_send', { phone: '+14155550100' })).toMatchObject({ status: 400, body: { error: 'invalid_action' } });
      expect(w.twilio).toEqual([]);
    });
  });

  it('with the switch off it shows the number and offers nothing, and a send is refused before anything is called', async () => {
    const w = world('+919800000001');
    await owner({ PHONE_SMS_VERIFY: '0' }, async ({ read, act }) => {
      expect((await read()).data).toEqual({ phone: '+919800000001', verified: false, sms: false, challenge: null, actions: [] });
      expect(await act('phone.sms_send')).toMatchObject({ status: 409, body: { error: 'no_longer_eligible' } });
      expect(w.twilio).toEqual([]);
      expect(w.ledger.challenge).toBeNull();
    });
  });

  it('offers nothing for an owner with no number, or one already verified', async () => {
    world(null);
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ read }) => { expect((await read()).data.actions).toEqual([]); });
    const w = world('+919800000001');
    w.ledger.verified = true;
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ read }) => { expect((await read()).data.actions).toEqual([]); });
  });

  it('offers a resend only once the wait the ledger set has passed, and a check only while checks are left', async () => {
    const w = world('+919800000001');
    w.ledger.challenge = { state: 'pending', expires_at: 1, retry_at: Math.floor(Date.now() / 1000) + 60, checks_left: 5 };
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ read }) => { expect((await read()).data.actions).toEqual(['phone.sms_check']); });
    w.ledger.challenge = { state: 'pending', expires_at: 1, retry_at: Math.floor(Date.now() / 1000) - 1, checks_left: 0 };
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ read }) => { expect((await read()).data.actions).toEqual(['phone.sms_send']); });
    w.ledger.challenge = { state: 'unknown', expires_at: 1, retry_at: Math.floor(Date.now() / 1000) + 3600, checks_left: 5 };
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ read }) => { expect((await read()).data.actions).toEqual([]); });
    for (const state of ['sending', 'checking']) {
      w.ledger.challenge = { state, expires_at: 1, retry_at: null, checks_left: 5 };
      await owner({ PHONE_SMS_VERIFY: '1' }, async ({ read }) => { expect((await read()).data.actions).toEqual([]); });
    }
  });

  it('asks for six digits before asking Twilio', async () => {
    const w = world('+919800000001');
    await owner({ PHONE_SMS_VERIFY: '1' }, async ({ act }) => {
      await act('phone.sms_send');
      expect(await act('phone.sms_check', { code: '4242' })).toMatchObject({ status: 409, body: { receipt: { message: 'Enter the six digits from the text.' } } });
      expect(w.twilio).toHaveLength(1);
    });
  });
});
