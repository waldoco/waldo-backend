import { afterEach, describe, expect, it, vi } from 'vitest';
import { routerSignature } from '../src/identity/owner-directory';
import { phoneSms } from '../src/identity/phone-sms';

const service = `VA${'a'.repeat(32)}`;
const sid = `VE${'b'.repeat(32)}`;
const phone = '+919800000001';
const token = 'synthetic-twilio-token-for-tests';
const env = {
  SUPABASE_PROJECT_URL: 'https://directory.test', SUPABASE_PUBLISHABLE_KEY: 'publishable', WALDO_ROUTER_HMAC_SECRET: 'router-secret',
  PHONE_SMS_VERIFY: '1', PHONE_SMS_COUNTRIES: '+91', PHONE_SMS_DAILY_LIMIT: '20',
  TWILIO_ACCOUNT_SID: `AC${'c'.repeat(32)}`, TWILIO_AUTH_TOKEN: token, TWILIO_VERIFY_SERVICE_SID: service,
};
const NOW = 1_800_000_000_000;

type Call = { url: string; body: Record<string, unknown>; headers: Headers };
// One fake for both sides: the signed ledger at the directory, and Twilio Verify.
function fake(ledger: (action: string, payload: Record<string, unknown>) => unknown, twilio: (resource: string, form: URLSearchParams) => Response | Promise<Response> = () => Response.json({})) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = new Headers(init?.headers);
    if (url.startsWith('https://verify.twilio.com/')) {
      const form = new URLSearchParams(String(init?.body));
      calls.push({ url, body: Object.fromEntries(form), headers });
      return twilio(url.split('/').pop()!, form);
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body, headers });
    if (url.endsWith('/owner_phone_state')) return Response.json(ledger('state', body));
    return Response.json(ledger(String(body.p_action), JSON.parse(String(body.p_payload)) as Record<string, unknown>));
  });
  return { fetcher, calls, twilioCalls: () => calls.filter((c) => c.url.startsWith('https://verify.twilio.com/')), ledgerCalls: () => calls.filter((c) => !c.url.startsWith('https://verify.twilio.com/')) };
}
const pendingFrom = (to = phone, overrides: Record<string, unknown> = {}) => Response.json({ service_sid: service, sid, to, channel: 'sms', status: 'pending', ...overrides });

afterEach(() => vi.restoreAllMocks());

describe('the switch and the credentials', () => {
  it.each([[undefined], ['0'], ['true'], ['on'], [' 1']])('with PHONE_SMS_VERIFY=%s nothing is offered and nothing is called', async (value) => {
    const f = fake(() => ({ kind: 'reserved', phone }));
    const sms = phoneSms({ ...env, PHONE_SMS_VERIFY: value }, f.fetcher, () => NOW);
    expect(sms.offered).toBe(false);
    expect(await sms.send('owner-a')).toEqual({ kind: 'disabled' });
    expect(await sms.check('owner-a', '123456')).toEqual({ kind: 'disabled' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['account', { TWILIO_ACCOUNT_SID: 'ACshort' }], ['service', { TWILIO_VERIFY_SERVICE_SID: 'https://attacker.invalid' }],
    ['token', { TWILIO_AUTH_TOKEN: '' }], ['router secret', { WALDO_ROUTER_HMAC_SECRET: undefined }],
    ['country list', { PHONE_SMS_COUNTRIES: undefined }], ['country list', { PHONE_SMS_COUNTRIES: '' }], ['country code', { PHONE_SMS_COUNTRIES: '91' }],
    ['country code', { PHONE_SMS_COUNTRIES: '+91,+0' }], ['country code', { PHONE_SMS_COUNTRIES: '+9100' }],
    ['daily cap', { PHONE_SMS_DAILY_LIMIT: undefined }], ['daily cap', { PHONE_SMS_DAILY_LIMIT: '0' }], ['daily cap', { PHONE_SMS_DAILY_LIMIT: '20 a day' }],
    ['API key, with no fallback to the account token', { TWILIO_API_KEY_SID: 'SKshort', TWILIO_API_KEY_SECRET: 'synthetic-key-secret' }],
    ['API key secret', { TWILIO_API_KEY_SID: `SK${'e'.repeat(32)}`, TWILIO_API_KEY_SECRET: '' }],
  ])('with a bad or missing %s nothing is offered', async (_label, override) => {
    const f = fake(() => ({ kind: 'reserved', phone }));
    const sms = phoneSms({ ...env, ...override }, f.fetcher, () => NOW);
    expect(sms.offered).toBe(false);
    expect(await sms.send('owner-a')).toEqual({ kind: 'disabled' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('sending a code', () => {
  it('reserves first, texts the number the ledger reserved, then finishes with the verification Twilio returned', async () => {
    const f = fake((action) => action === 'reserve_send' ? { kind: 'reserved', phone } : { kind: 'pending' }, () => pendingFrom());
    const sms = phoneSms(env, f.fetcher, () => NOW);
    expect(sms.offered).toBe(true);
    expect(await sms.send('owner-a')).toEqual({ kind: 'pending' });
    expect(f.calls.map((c) => c.url.split('/').pop())).toEqual(['phone_sms_transition', 'Verifications', 'phone_sms_transition']);
    const [reserve, , finish] = f.calls;
    const reservePayload = JSON.parse(String(reserve!.body.p_payload)) as Record<string, unknown>;
    expect(reserve!.body.p_action).toBe('reserve_send');
    expect(Object.keys(reservePayload).sort()).toEqual(['countries', 'daily_limit', 'do_name', 'operation', 'service']);
    expect(reservePayload).toMatchObject({ do_name: 'owner-a', service, countries: ['+91'], daily_limit: 20 });
    expect(reserve!.body.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, NOW / 1000, `phonesms.reserve_send.${String(reserve!.body.p_payload)}`));
    expect(f.twilioCalls()[0]!.body).toEqual({ To: phone, Channel: 'sms' });
    expect(JSON.parse(String(finish!.body.p_payload))).toEqual({ do_name: 'owner-a', service, operation: reservePayload.operation, outcome: 'pending', sid });
  });

  it('signs every listed country code into the reservation', async () => {
    const f = fake(() => ({ kind: 'unsupported' }));
    expect(await phoneSms({ ...env, PHONE_SMS_COUNTRIES: '+91, +44,+1', PHONE_SMS_DAILY_LIMIT: '35' }, f.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'unsupported' });
    expect(JSON.parse(String(f.ledgerCalls()[0]!.body.p_payload))).toMatchObject({ countries: ['+91', '+44', '+1'], daily_limit: 35 });
    expect(f.twilioCalls()).toEqual([]);
  });

  it.each([[400, 60200], [401, 20003], [403, 20403], [404, 20404]])('a send Twilio refuses with HTTP %s is finished refused and logged by its numeric code alone', async (status, code) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fake((action) => action === 'reserve_send' ? { kind: 'reserved', phone } : { kind: 'refused' },
      () => Response.json({ code, message: `Invalid parameter To: ${phone}`, status }, { status }));
    expect(await phoneSms(env, f.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'refused' });
    expect(JSON.parse(String(f.ledgerCalls()[1]!.body.p_payload))).toMatchObject({ outcome: 'refused', sid: '' });
    expect(error.mock.calls).toEqual([[JSON.stringify({ hop: 'phone_sms', ok: false, code: 'provider_refused', resource: 'Verifications', status, twilio_code: code })]]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(phone.slice(1));
  });

  it.each(['no_number', 'verified', 'unsupported', 'number_taken', 'held', 'busy', 'throttled', 'denied'])('a %s refusal from the ledger texts nothing', async (kind) => {
    const f = fake(() => ({ kind }));
    expect(await phoneSms(env, f.fetcher, () => NOW).send('owner-a')).toEqual({ kind });
    expect(f.twilioCalls()).toEqual([]);
    expect(f.ledgerCalls()).toHaveLength(1);
  });

  it.each([[{ kind: 'reserved' }], [{ kind: 'reserved', phone: '98000 00001' }], [{ kind: 'reserved', phone: 42 }]])('a reservation without a valid number texts nothing and stays unknown: %j', async (reservation) => {
    const f = fake((action) => action === 'reserve_send' ? reservation : { kind: 'unknown' });
    expect(await phoneSms(env, f.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'unknown' });
    expect(f.twilioCalls()).toEqual([]);
    expect(JSON.parse(String(f.ledgerCalls()[1]!.body.p_payload))).toMatchObject({ outcome: 'unknown', sid: '' });
  });

  it.each([
    ['another recipient', () => pendingFrom('+14155550100')], ['another service', () => pendingFrom(phone, { service_sid: `VA${'d'.repeat(32)}` })],
    ['a provider error', () => new Response('provider details', { status: 500 })], ['a network failure', () => { throw new TypeError('network'); }],
  ])('%s is recorded as unknown, never as sent', async (_label, twilio) => {
    const f = fake((action) => action === 'reserve_send' ? { kind: 'reserved', phone } : { kind: 'unknown' }, twilio);
    expect(await phoneSms(env, f.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'unknown' });
    expect(JSON.parse(String(f.ledgerCalls()[1]!.body.p_payload))).toMatchObject({ outcome: 'unknown', sid: '' });
  });

  it('a lost reservation answer texts nothing; a lost finish answer reads as unknown', async () => {
    const lostReserve = fake(() => { throw new Error('directory down'); });
    expect(await phoneSms(env, lostReserve.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'unknown' });
    expect(lostReserve.twilioCalls()).toEqual([]);
    const lostFinish = fake((action) => { if (action === 'finish_send') throw new Error('directory down'); return { kind: 'reserved', phone }; }, () => pendingFrom());
    expect(await phoneSms(env, lostFinish.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'unknown' });
    expect(lostFinish.twilioCalls()).toHaveLength(1);
  });

  it('an unexpected ledger answer reads as unknown, and an approval is never accepted from a send', async () => {
    for (const answer of [{ kind: 'approved' }, { kind: 'surprise' }, null, 'reserved']) {
      const f = fake((action) => action === 'reserve_send' ? { kind: 'reserved', phone } : answer, () => pendingFrom());
      expect(await phoneSms(env, f.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'unknown' });
    }
  });
});

describe('checking a code', () => {
  const reference = { service, sid, phone };
  it('checks the verification the ledger reserved and finishes with its answer', async () => {
    const f = fake((action) => action === 'reserve_check' ? { kind: 'reserved', reference } : { kind: 'approved' },
      () => Response.json({ service_sid: service, sid, to: phone, channel: 'sms', status: 'approved' }));
    expect(await phoneSms(env, f.fetcher, () => NOW).check('owner-a', '123456')).toEqual({ kind: 'approved' });
    expect(f.twilioCalls()[0]!.url).toBe(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`);
    expect(f.twilioCalls()[0]!.body).toEqual({ VerificationSid: sid, Code: '123456' });
    const reserve = JSON.parse(String(f.ledgerCalls()[0]!.body.p_payload)) as Record<string, unknown>;
    expect(JSON.parse(String(f.ledgerCalls()[1]!.body.p_payload))).toEqual({ ...reserve, outcome: 'approved', sid });
  });

  it.each(['', '12345', '1234567', '12345a', ' 123456', '１２３４５６'])('a code that is not six digits (%j) reaches nobody', async (code) => {
    const f = fake(() => ({ kind: 'reserved', reference }));
    expect(await phoneSms(env, f.fetcher, () => NOW).check('owner-a', code)).toEqual({ kind: 'denied' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['another service', { ...reference, service: `VA${'d'.repeat(32)}` }], ['a malformed verification', { ...reference, sid: 'VEshort' }],
    ['a malformed number', { ...reference, phone: '98000' }], ['no reference', undefined],
  ])('a reservation naming %s asks Twilio nothing', async (_label, ref) => {
    const f = fake((action) => action === 'reserve_check' ? { kind: 'reserved', reference: ref } : { kind: 'unknown' });
    expect(await phoneSms(env, f.fetcher, () => NOW).check('owner-a', '123456')).toEqual({ kind: 'unknown' });
    expect(f.twilioCalls()).toEqual([]);
  });

  it('an approval about another verification is finished as unknown, never as approved', async () => {
    const f = fake((action) => action === 'reserve_check' ? { kind: 'reserved', reference } : { kind: 'unknown' },
      () => Response.json({ service_sid: service, sid: `VE${'e'.repeat(32)}`, to: phone, channel: 'sms', status: 'approved' }));
    expect(await phoneSms(env, f.fetcher, () => NOW).check('owner-a', '123456')).toEqual({ kind: 'unknown' });
    expect(JSON.parse(String(f.ledgerCalls()[1]!.body.p_payload))).toMatchObject({ outcome: 'unknown', sid: '' });
  });

  it.each(['busy', 'expired', 'throttled', 'denied'])('a %s refusal asks Twilio nothing', async (kind) => {
    const f = fake(() => ({ kind }));
    expect(await phoneSms(env, f.fetcher, () => NOW).check('owner-a', '123456')).toEqual({ kind });
    expect(f.twilioCalls()).toEqual([]);
  });

  it('a check Twilio refuses is finished refused, so the ledger gives the try back, and is logged without the code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fake((action) => action === 'reserve_check' ? { kind: 'reserved', reference } : { kind: 'refused' }, () => Response.json({ code: 20003 }, { status: 401 }));
    expect(await phoneSms(env, f.fetcher, () => NOW).check('owner-a', '424242')).toEqual({ kind: 'refused' });
    expect(JSON.parse(String(f.ledgerCalls()[1]!.body.p_payload))).toMatchObject({ outcome: 'refused', sid: '' });
    expect(error.mock.calls).toEqual([[JSON.stringify({ hop: 'phone_sms', ok: false, code: 'provider_refused', resource: 'VerificationCheck', status: 401, twilio_code: 20003 })]]);
  });
});

describe('what never leaves its place', () => {
  it('the Twilio token goes only in the Twilio authorization header, and the code only to Twilio', async () => {
    const log = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    const f = fake((action) => action === 'reserve_send' ? { kind: 'reserved', phone } : action === 'reserve_check' ? { kind: 'reserved', reference: { service, sid, phone } } : { kind: 'pending' },
      (resource) => resource === 'Verifications' ? pendingFrom() : Response.json({ service_sid: service, sid, to: phone, channel: 'sms', status: 'pending' }));
    const sms = phoneSms(env, f.fetcher, () => NOW);
    await sms.send('owner-a');
    await sms.check('owner-a', '424242');
    for (const call of f.ledgerCalls()) {
      expect(JSON.stringify(call.body)).not.toContain(token);
      expect(JSON.stringify(call.body)).not.toContain('424242');
      expect([...call.headers.values()].join(' ')).not.toContain(token);
    }
    for (const call of f.twilioCalls()) expect(call.headers.get('authorization')).toBe(`Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${token}`)}`);
    expect(f.twilioCalls().map((c) => c.body.Code ?? null)).toEqual([null, '424242']);
    for (const spy of log) expect(spy).not.toHaveBeenCalled();
  });

  it('an API key, restricted to Verify or not, is used in place of the account token whenever it is set', async () => {
    const key = `SK${'e'.repeat(32)}`, secret = 'synthetic-key-secret';
    for (const account of [{}, { TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined }]) {
      const f = fake((action) => action === 'reserve_send' ? { kind: 'reserved', phone } : { kind: 'pending' }, () => pendingFrom());
      expect(await phoneSms({ ...env, ...account, TWILIO_API_KEY_SID: key, TWILIO_API_KEY_SECRET: secret }, f.fetcher, () => NOW).send('owner-a')).toEqual({ kind: 'pending' });
      expect(f.twilioCalls()[0]!.headers.get('authorization')).toBe(`Basic ${btoa(`${key}:${secret}`)}`);
      for (const call of f.ledgerCalls()) expect(JSON.stringify(call.body)).not.toContain(secret);
    }
  });
});

describe('reading the state', () => {
  it('reads the number on file, its proof and the code in flight, signed for that owner', async () => {
    const challenge = { state: 'pending', expires_at: 1_800_000_600, retry_at: 1_800_000_060, checks_left: 5 };
    const f = fake(() => ({ phone, verified: false, challenge }));
    expect(await phoneSms(env, f.fetcher, () => NOW).state('owner-a')).toEqual({ phone, verified: false, sms: true, challenge });
    expect(f.calls[0]!.body).toMatchObject({ p_do_name: 'owner-a' });
    expect(f.calls[0]!.body.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, NOW / 1000, 'phonestate.owner-a'));
  });

  it('says texting is not offered for a number outside the listed country codes, or no number', async () => {
    const challenge = null;
    expect(await phoneSms(env, fake(() => ({ phone: '+447700900001', verified: false, challenge })).fetcher, () => NOW).state('owner-a'))
      .toEqual({ phone: '+447700900001', verified: false, sms: false, challenge });
    expect(await phoneSms({ ...env, PHONE_SMS_COUNTRIES: '+44' }, fake(() => ({ phone: '+447700900001', verified: false, challenge })).fetcher, () => NOW).state('owner-a'))
      .toMatchObject({ sms: true });
    expect(await phoneSms(env, fake(() => ({ phone: null, verified: false, challenge })).fetcher, () => NOW).state('owner-a')).toMatchObject({ sms: false });
  });

  it('reads with the switch off, and says texting is not offered', async () => {
    const f = fake(() => ({ phone: null, verified: false, challenge: null }));
    expect(await phoneSms({ ...env, PHONE_SMS_VERIFY: '0' }, f.fetcher, () => NOW).state('owner-a')).toEqual({ phone: null, verified: false, sms: false, challenge: null });
  });

  it('an unknown owner reads as null; without a directory there is nothing to read', async () => {
    expect(await phoneSms(env, fake(() => null).fetcher, () => NOW).state('owner-a')).toBeNull();
    expect(await phoneSms({ ...env, SUPABASE_PROJECT_URL: undefined }, fake(() => null).fetcher, () => NOW).state('owner-a')).toBeNull();
  });

  it.each([
    [{ phone: '98000', verified: false, challenge: null }], [{ phone, verified: 'no', challenge: null }],
    [{ phone, verified: false, challenge: { state: 'sent', expires_at: 1, retry_at: null, checks_left: 5 } }], [{ phone, verified: false, challenge: { state: 'pending', expires_at: '1', retry_at: null, checks_left: 5 } }],
    [{ phone, verified: false, challenge: { state: 'pending', expires_at: 1, retry_at: '1', checks_left: 5 } }], [{ phone, verified: false, challenge: { state: 'pending', expires_at: 1, retry_at: null, checks_left: 6 } }],
    [{ phone, verified: false, challenge: { state: 'pending', expires_at: 1, checks_left: 5 } }],
    [{ phone, verified: false }], [[]],
  ])('a malformed read is refused, not shown: %j', async (row) => {
    await expect(phoneSms(env, fake(() => row).fetcher, () => NOW).state('owner-a')).rejects.toThrow('phone state shape');
  });
});
