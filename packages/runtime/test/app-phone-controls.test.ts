// The app's phone view on the one controls path: GET /app/v1/controls?view=phone reads the number on file, and
// POST /app/v1/actions sets it, texts or checks a code through the same control-action receipt book the app already reads back.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_IMESSAGE_ENROLL_RECEIPTS_V1, APP_PHONE_SET_RECEIPTS_V1, appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { appControlsRequest, type AppControlsHost } from '../src/channels/app-controls';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { APP_CONTROLS_WHATSAPP_PROOF_REVISION } from '../../contracts/src/app/controls';
import { phoneControlAct, type IMessageProof, type IMessageReach, type WhatsAppProof } from '../src/channels/dashboard-phone';

const SERVICE = `VA${'a'.repeat(32)}`, SID = `VE${'b'.repeat(32)}`, TOKEN = 'synthetic-twilio-token-for-app', CODE = '424242', PHONE = '+919800000001';
// Synthetic numbers: NEW is free, TAKEN is verified on another owner in the fake ledger.
const NEW = '+919800000002', TAKEN = '+919800000003';
const phoneEnv = (on: string) => ({
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
  PHONE_SMS_VERIFY: on, PHONE_SMS_COUNTRIES: '+91', PHONE_SMS_DAILY_LIMIT: '20', TWILIO_ACCOUNT_SID: `AC${'c'.repeat(32)}`, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_VERIFY_SERVICE_SID: SERVICE,
});
const unused = () => { throw Error('The phone view reads the signed ledger only'); };
// How often the owner DO was told the directory unlinked its WhatsApp chat.
let whatsappUnlinks = 0;
afterEach(() => { vi.unstubAllGlobals(); });

function world() {
  const open = { expires_at: 1, retry_at: null, checks_left: 5 };
  // linked: the providers linked from the number on file, which a change of number unlinks.
  const ledger = { phone: PHONE as string | null, verified: false, challenge: null as Record<string, unknown> | null, linked: [] as string[] };
  whatsappUnlinks = 0;
  const twilio: Record<string, string>[] = [], sets: Record<string, unknown>[] = [];
  let failSet = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://verify.twilio.com/')) {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      twilio.push(form);
      return Response.json({ service_sid: SERVICE, sid: SID, to: PHONE, channel: 'sms', status: url.endsWith('/Verifications') || form.Code !== CODE ? 'pending' : 'approved' });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1], args = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    if (fn === 'owner_phone_state') return Response.json(ledger);
    if (fn === 'owner_phone_set') {
      const asked = JSON.parse(args.p_payload ?? '{}') as Record<string, unknown>;
      sets.push(asked);
      if (failSet) return new Response('unavailable', { status: 503 });
      if (asked.phone === TAKEN) return Response.json({ kind: 'taken' });
      if (asked.phone === ledger.phone) return Response.json({ kind: 'unchanged' });
      const unlinked = ledger.linked;
      Object.assign(ledger, { phone: asked.phone, verified: false, challenge: null, linked: [] });
      return Response.json({ kind: 'set', unlinked });
    }
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
  return { ledger, twilio, sets, failSets: () => { failSet = true; } };
}
const app = (on: string, run: (o: { read(): Promise<{ status: number; body: Record<string, unknown> }>; act(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>; storage: DurableObjectStorage }) => Promise<void>, signedInAt = new Date().toISOString(), imessageProof?: IMessageProof, whatsapp?: Readonly<{ proof: WhatsAppProof; revision: number | null }>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-phone-${crypto.randomUUID()}`)), async (_i, state) => {
    const host: AppControlsHost = { csrf: 'c'.repeat(64), expires: Date.now() + 60_000, signedInAt, storage: state.storage, assertCurrent: async () => {},
      sessions: async () => [{ csrf: 'c'.repeat(64), expires: Date.now() + 60_000 }], view: unused, act: unused,
      account: { owner: 'owner-app-phone', auth: null, requestUrl: 'https://app.fixture.invalid/app/v1/controls', purgeOwnerFiles: unused, eraseOwnerStorage: unused },
      phone: phoneEnv(on), whatsappUnlinked: async () => { whatsappUnlinks++; }, ...(imessageProof ? { imessageProof } : {}), ...(whatsapp ? { whatsappProof: whatsapp.proof } : {}) };
    const withRevision = (request: Request) => { if (whatsapp?.revision) request.headers.set(APP_CONTRACT_HEADER, `controls=${whatsapp.revision}`); return request; };
    const call = async (request: Request) => { const response = await appControlsRequest(withRevision(request), host); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
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
    expect(projection).toMatchObject({ view: 'phone', data: { phone: PHONE, verified: false, sms: true, challenge: null, actions: ['phone.sms_send', 'phone.set'] } });
    expect(first.body).not.toHaveProperty('csrf');
    const sent = await act({ view: 'phone', action: 'phone.sms_send', revision: projection.revision, request_id: 'phone-request-1' });
    expect(sent.status).toBe(200);
    expect(appControlResultV1Schema.parse(sent.body).receipt.state).toBe('recorded');
    expect(w.twilio).toEqual([{ To: PHONE, Channel: 'sms' }]);
    const waiting = appControlProjectionV1Schema.parse((await read()).body);
    expect(waiting).toMatchObject({ data: { actions: ['phone.sms_send', 'phone.sms_check', 'phone.set'] } });
    const checked = await act({ view: 'phone', action: 'phone.sms_check', code: CODE, revision: waiting.revision, request_id: 'phone-request-2' });
    expect(appControlResultV1Schema.parse(checked.body).receipt).toEqual({ state: 'recorded', message: 'Your number is verified.' });
    const back = await appControlsRequest(new Request('https://app.fixture.invalid/app/v1/actions/phone-request-2'), {
      csrf: 'c'.repeat(64), expires: Date.now() + 60_000, signedInAt: new Date().toISOString(), storage, assertCurrent: async () => {}, sessions: unused, view: unused, act: unused,
      account: { owner: 'owner-app-phone', auth: null, requestUrl: '', purgeOwnerFiles: unused, eraseOwnerStorage: unused }, phone: phoneEnv('1'), whatsappUnlinked: unused });
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

it('sets a new number unverified, then texts the code to that number, and keeps the number out of storage', async () => {
  const w = world();
  w.ledger.verified = true;
  await app('1', async ({ read, act, storage }) => {
    const first = appControlProjectionV1Schema.parse((await read()).body);
    expect(first.data).toMatchObject({ phone: PHONE, verified: true, actions: ['phone.set'] });
    const set = await act({ view: 'phone', action: 'phone.set', value: NEW, revision: first.revision, request_id: 'phone-request-6' });
    expect(set.status).toBe(200);
    expect(appControlResultV1Schema.parse(set.body).receipt).toEqual(APP_PHONE_SET_RECEIPTS_V1.set);
    expect(w.sets).toEqual([{ do_name: 'owner-app-phone', phone: NEW, countries: ['+91'] }]);
    const changed = appControlProjectionV1Schema.parse((await read()).body);
    expect(changed.data).toMatchObject({ phone: NEW, verified: false, actions: ['phone.sms_send', 'phone.set'] });
    expect((await act({ view: 'phone', action: 'phone.sms_send', revision: changed.revision, request_id: 'phone-request-7' })).status).toBe(200);
    expect(w.twilio).toEqual([{ To: NEW, Channel: 'sms' }]);
    expect(JSON.stringify([...(await storage.list()).entries()])).not.toContain(NEW.slice(1));
  });
});

it('answers taken, without saving or saying whose, when another owner verified the number', async () => {
  const w = world();
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    const taken = await act({ view: 'phone', action: 'phone.set', value: TAKEN, revision, request_id: 'phone-request-8' });
    expect(taken.status).toBe(409);
    expect(appControlResultV1Schema.parse(taken.body).receipt).toEqual(APP_PHONE_SET_RECEIPTS_V1.taken);
    expect(w.ledger.phone).toBe(PHONE);
    expect(w.twilio).toEqual([]);
  });
});

it('says a lost answer from the ledger is unconfirmed, since the number may have been saved', async () => {
  const w = world();
  w.failSets();
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    const lost = await act({ view: 'phone', action: 'phone.set', value: NEW, revision, request_id: 'phone-request-9' });
    expect(lost.status).toBe(503);
    expect(appControlResultV1Schema.parse(lost.body).receipt).toEqual(APP_PHONE_SET_RECEIPTS_V1.unknown);
  });
});

it('refuses to change the number without a recent email code, before the ledger is asked', async () => {
  const w = world();
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    const refused = await act({ view: 'phone', action: 'phone.set', value: NEW, revision, request_id: 'phone-request-10' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'step_up_required' });
    expect(w.sets).toEqual([]);
  }, new Date(Date.now() - 3 * 60 * 60_000).toISOString());
});

it('refuses a number that is not E.164 at the contract, before the ledger is asked', async () => {
  const w = world();
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    for (const value of ['98000 00002', '+91 98000 00002', '']) {
      expect((await act({ view: 'phone', action: 'phone.set', value, revision, request_id: 'phone-request-11' })).status).toBe(400);
    }
    expect(w.sets).toEqual([]);
  });
});

it('with the switch off the number cannot be set', async () => {
  const w = world();
  await app('0', async ({ read, act }) => {
    const projection = appControlProjectionV1Schema.parse((await read()).body);
    expect(projection).toMatchObject({ data: { actions: [] } });
    expect((await act({ view: 'phone', action: 'phone.set', value: NEW, revision: projection.revision, request_id: 'phone-request-12' })).body).toMatchObject({ error: 'no_longer_eligible' });
    expect(w.sets).toEqual([]);
  });
});

it('after a number change lists no send while the ledger still spaces codes, and says until when', async () => {
  const w = world();
  const retry = Math.floor(Date.now() / 1000) + 45;
  Object.assign(w.ledger, { phone: NEW, challenge: { state: 'expired', expires_at: 1, retry_at: retry, checks_left: 0 } });
  await app('1', async ({ read }) => {
    const projection = appControlProjectionV1Schema.parse((await read()).body);
    expect(projection).toMatchObject({ data: { phone: NEW, challenge: { state: 'expired', retry_at: retry, checks_left: 0 }, actions: ['phone.set'] } });
  });
});

it('a change of number that unlinked chats from the old number says so, and clears the WhatsApp chat the owner DO holds', async () => {
  const w = world();
  w.ledger.linked = ['imessage', 'whatsapp'];
  await app('1', async ({ read, act }) => {
    const { revision } = appControlProjectionV1Schema.parse((await read()).body);
    const set = await act({ view: 'phone', action: 'phone.set', value: NEW, revision, request_id: 'phone-request-13' });
    expect(appControlResultV1Schema.parse(set.body).receipt).toEqual(APP_PHONE_SET_RECEIPTS_V1.set_unlinked);
    expect(whatsappUnlinks).toBe(1);
  });
});

it('an iMessage-only unlink is the directory\'s alone, and a change with no links clears nothing', async () => {
  const w = world();
  w.ledger.linked = ['imessage'];
  await app('1', async ({ read, act }) => {
    const first = appControlProjectionV1Schema.parse((await read()).body);
    expect(appControlResultV1Schema.parse((await act({ view: 'phone', action: 'phone.set', value: NEW, revision: first.revision, request_id: 'phone-request-14' })).body).receipt)
      .toEqual(APP_PHONE_SET_RECEIPTS_V1.set_unlinked);
    const second = appControlProjectionV1Schema.parse((await read()).body);
    expect(appControlResultV1Schema.parse((await act({ view: 'phone', action: 'phone.set', value: PHONE, revision: second.revision, request_id: 'phone-request-15' })).body).receipt)
      .toEqual(APP_PHONE_SET_RECEIPTS_V1.set);
    expect(whatsappUnlinks).toBe(0);
  });
});

// iMessage proves a number when the owner sends their link code from it. reach: the address this owner texts (the shared one, or once
// enrolled their Photon number), whether Photon is in use and the owner can enroll, and the number enrolled; true is the shared
// address, false nothing. hint: the last characters of the handle their iMessage is linked from (an Apple ID email ends in letters).
// enrolls: what each Photon enrollment was asked for and answered.
let enrolls: string[] = [];
const imessage = (reach: boolean | 'unknown' | Partial<IMessageReach>, hint: string | null = null, enroll?: IMessageProof['enroll']): IMessageProof => ({
  read: async () => {
    if (reach === 'unknown') throw new Error('directory unreadable');
    const base: IMessageReach = { address: null, photon: false, enrollable: false, enrolled: null };
    return reach === true ? { ...base, address: 'woof@fixture.invalid' } : reach === false ? base : { ...base, ...reach };
  },
  hint: async () => hint,
  ...(enroll ? { enroll } : {}),
});
const photon = (answer: Awaited<ReturnType<NonNullable<IMessageProof['enroll']>>> = 'enrolled') => async (phone: string) => { enrolls.push(phone); return answer; };

it.each([
  ['0', false, [], []],
  ['1', false, ['phone.sms_send', 'phone.set'], ['sms']],
  ['0', true, ['phone.set'], ['imessage']],
  ['1', true, ['phone.sms_send', 'phone.set'], ['sms', 'imessage']],
] as const)('with texting %s and iMessage linking %s the number can be set where it can be proven, and only texting sends a code', async (on, linkable, actions, proof) => {
  world();
  await app(on, async ({ read }) => {
    expect(appControlProjectionV1Schema.parse((await read()).body)).toMatchObject({ data: { phone: PHONE, verified: false, actions, proof } });
  }, undefined, imessage(linkable));
});

it('with texting off and iMessage linking on, a new number is saved and no code is texted', async () => {
  const w = world();
  await app('0', async ({ read, act }) => {
    const projection = appControlProjectionV1Schema.parse((await read()).body);
    const set = appControlResultV1Schema.parse((await act({ view: 'phone', action: 'phone.set', value: NEW, revision: projection.revision, request_id: 'phone-request-30' })).body);
    expect(set.receipt).toEqual(APP_PHONE_SET_RECEIPTS_V1.set);
    expect(w.ledger.phone).toBe(NEW);
    const after = appControlProjectionV1Schema.parse((await read()).body);
    expect(after).toMatchObject({ data: { phone: NEW, sms: false, actions: ['phone.set'] } });
    expect((await act({ view: 'phone', action: 'phone.sms_send', revision: after.revision, request_id: 'phone-request-31' })).body).toMatchObject({ error: 'no_longer_eligible' });
    expect(w.twilio).toEqual([]);
  }, undefined, imessage(true));
});

it('reads iMessage linking it cannot confirm as off, and still answers the phone view', async () => {
  world();
  await app('0', async ({ read }) => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(appControlProjectionV1Schema.parse(response.body)).toMatchObject({ data: { actions: [], proof: [] } });
  }, undefined, imessage('unknown'));
});

it.each([
  [null, 'none'], ['.com', 'email'], ['d.me', 'email'], ['0001', 'number'], ['9999', 'other_number'],
] as const)('says how the linked iMessage relates to the number on file (hint %s: %s), never the handle itself', async (hint, from) => {
  world();
  await app('0', async ({ read }) => {
    const response = await read();
    expect(appControlProjectionV1Schema.parse(response.body)).toMatchObject({ data: { imessage_from: from } });
    if (hint && !PHONE.endsWith(hint)) expect(JSON.stringify(response.body)).not.toContain(hint);
  }, undefined, imessage(true, hint));
});

it('re-checks at act time that the number can be proven, so neither texting nor iMessage means no number is set', async () => {
  const w = world();
  const act: Parameters<typeof phoneControlAct>[2] = { action: 'phone.set', id: '', value: NEW };
  expect(await phoneControlAct(phoneEnv('0'), 'owner-app-phone', act, {}, async () => {}, imessage(false))).toEqual(APP_PHONE_SET_RECEIPTS_V1.unavailable);
  expect(await phoneControlAct(phoneEnv('0'), 'owner-app-phone', act, {}, async () => {}, imessage('unknown'))).toEqual(APP_PHONE_SET_RECEIPTS_V1.unavailable);
  expect(w.sets).toEqual([]);
  expect(await phoneControlAct(phoneEnv('0'), 'owner-app-phone', act, {}, async () => {}, imessage(true))).toEqual(APP_PHONE_SET_RECEIPTS_V1.set);
  expect(w.sets).toHaveLength(1);
});

describe('iMessage set-up where Waldo\'s iMessage runs on Photon', () => {
  const unenrolled = { photon: true, enrollable: true };
  it('offers setting the number and setting it up for iMessage, with no texting, to an owner not enrolled yet', async () => {
    world();
    await app('0', async ({ read }) => {
      expect(appControlProjectionV1Schema.parse((await read()).body)).toMatchObject({ data: { actions: ['phone.set', 'imessage.enroll'], proof: ['imessage'] } });
    }, undefined, imessage(unenrolled, null, photon()));
  });
  it('enrolls the number on file at the owner\'s tap, and nothing else', async () => {
    const w = world();
    enrolls = [];
    await app('0', async ({ read, act }) => {
      const projection = appControlProjectionV1Schema.parse((await read()).body);
      const result = appControlResultV1Schema.parse((await act({ view: 'phone', action: 'imessage.enroll', revision: projection.revision, request_id: 'phone-request-40' })).body);
      expect(result.receipt).toEqual(APP_IMESSAGE_ENROLL_RECEIPTS_V1.enrolled);
      expect(enrolls).toEqual([PHONE]);
      expect(w.twilio).toEqual([]);
    }, undefined, imessage(unenrolled, null, photon()));
  });
  it('is not offered once the number on file is enrolled, without Photon, without a number, or once proven', async () => {
    for (const [reach, ledger] of [
      [{ photon: true, enrollable: true, address: '+15550000001', enrolled: PHONE }, {}],
      [true, {}],
      [unenrolled, { phone: null }],
      [unenrolled, { verified: true }],
    ] as const) {
      const w = world();
      Object.assign(w.ledger, ledger);
      await app('0', async ({ read }) => {
        expect(appControlProjectionV1Schema.parse((await read()).body).data).not.toMatchObject({ actions: expect.arrayContaining(['imessage.enroll']) });
      }, undefined, imessage(reach, null, photon()));
    }
  });
  it('offers it again for a new number, once the enrolled one changed', async () => {
    world();
    await app('0', async ({ read }) => {
      expect(appControlProjectionV1Schema.parse((await read()).body)).toMatchObject({ data: { actions: ['phone.set', 'imessage.enroll'] } });
    }, undefined, imessage({ photon: true, enrollable: true, address: '+15550000001', enrolled: NEW }, null, photon()));
  });
  it('is never offered where the host cannot enroll, as on the console', async () => {
    world();
    await app('0', async ({ read }) => {
      expect(appControlProjectionV1Schema.parse((await read()).body)).toMatchObject({ data: { actions: ['phone.set'], proof: ['imessage'] } });
    }, undefined, imessage(unenrolled));
  });
  it.each([
    ['phone_taken', APP_IMESSAGE_ENROLL_RECEIPTS_V1.phone_taken], ['refused', APP_IMESSAGE_ENROLL_RECEIPTS_V1.unavailable],
    ['photon_disconnected', APP_IMESSAGE_ENROLL_RECEIPTS_V1.unavailable], ['disabled', APP_IMESSAGE_ENROLL_RECEIPTS_V1.unavailable],
    ['invalid', APP_IMESSAGE_ENROLL_RECEIPTS_V1.invalid], ['throttled', APP_IMESSAGE_ENROLL_RECEIPTS_V1.throttled], ['unknown', APP_IMESSAGE_ENROLL_RECEIPTS_V1.unknown],
  ] as const)('answers a failed enrollment (%s) with its fixed receipt, never repeating the number', async (answer, receipt) => {
    world();
    await app('0', async ({ read, act }) => {
      const projection = appControlProjectionV1Schema.parse((await read()).body);
      const body = (await act({ view: 'phone', action: 'imessage.enroll', revision: projection.revision, request_id: `phone-request-${answer}` })).body;
      expect(appControlResultV1Schema.parse(body).receipt).toEqual(receipt);
      expect(JSON.stringify(body)).not.toContain(PHONE.slice(1));
    }, undefined, imessage(unenrolled, null, photon(answer)));
  });
  it('answers an enrollment that threw as unconfirmed, never as enrolled', async () => {
    world();
    await app('0', async ({ read, act }) => {
      const projection = appControlProjectionV1Schema.parse((await read()).body);
      const body = (await act({ view: 'phone', action: 'imessage.enroll', revision: projection.revision, request_id: 'phone-request-threw' })).body;
      expect(appControlResultV1Schema.parse(body).receipt).toEqual(APP_IMESSAGE_ENROLL_RECEIPTS_V1.unknown);
    }, undefined, imessage(unenrolled, null, async () => { throw new Error('photon unreachable'); }));
  });
  it('needs a recent email code, since it sends the number to Photon', async () => {
    world();
    enrolls = [];
    await app('0', async ({ read, act }) => {
      const projection = appControlProjectionV1Schema.parse((await read()).body);
      expect(await act({ view: 'phone', action: 'imessage.enroll', revision: projection.revision, request_id: 'phone-request-41' })).toMatchObject({ status: 403, body: { error: 'step_up_required' } });
      expect(enrolls).toEqual([]);
    }, new Date(Date.now() - 3 * 60 * 60_000).toISOString(), imessage(unenrolled, null, photon()));
  });
});

// WhatsApp as a way to prove the number: offered where the server can link it, only to a build that reads controls revision 12.
// offered: whether this server can link WhatsApp for the owner; hint: the last characters of the number their WhatsApp is linked from.
const whatsappOf = (offered: boolean | 'unknown', hint: string | null = null, revision: number | null = APP_CONTROLS_WHATSAPP_PROOF_REVISION) => ({
  proof: { offered: async () => { if (offered === 'unknown') throw new Error('directory unreadable'); return offered; }, hint: async () => hint } satisfies WhatsAppProof, revision });

describe('WhatsApp as a way to prove the number', () => {
  it.each([
    ['0', [], ['whatsapp']],
    ['1', ['phone.sms_send', 'phone.set'], ['sms', 'whatsapp']],
  ] as const)('with texting %s it is offered beside the other ways, and needs no number set first', async (on, actions, proof) => {
    world();
    await app(on, async ({ read }) => {
      expect(appControlProjectionV1Schema.parse((await read()).body)).toMatchObject({ data: { actions, proof } });
    }, undefined, imessage(false), whatsappOf(true));
  });

  it('comes after iMessage in the list of ways, and sets a number where iMessage can prove it', async () => {
    world();
    await app('1', async ({ read }) => {
      expect(appControlProjectionV1Schema.parse((await read()).body)).toMatchObject({ data: { proof: ['sms', 'imessage', 'whatsapp'] } });
    }, undefined, imessage(true), whatsappOf(true));
  });

  it.each([[11], [1], [null]])('is never named to a build below controls revision 12 (%s), which cannot read it', async revision => {
    world();
    await app('1', async ({ read }) => {
      const body = (await read()).body;
      expect(appControlProjectionV1Schema.parse(body)).toMatchObject({ data: { proof: ['sms'] } });
      expect(body.data).not.toHaveProperty('whatsapp_from');
    }, undefined, imessage(false), whatsappOf(true, '0001', revision));
  });

  it.each([[false], ['unknown']] as const)('is left out where this server cannot link WhatsApp or cannot say (%s), and the view still answers', async offered => {
    world();
    await app('1', async ({ read }) => {
      const response = await read();
      expect(response.status).toBe(200);
      const parsed = appControlProjectionV1Schema.parse(response.body);
      expect(parsed).toMatchObject({ data: { proof: ['sms'] } });
      expect(parsed.data).not.toHaveProperty('whatsapp_from');
    }, undefined, imessage(false), whatsappOf(offered, '0001'));
  });

  it.each([
    [null, 'none'], ['0001', 'number'], ['9999', 'other_number'],
  ] as const)('says how the linked WhatsApp relates to the number on file (hint %s: %s), never the number it is linked from', async (hint, from) => {
    world();
    await app('0', async ({ read }) => {
      const response = await read();
      expect(appControlProjectionV1Schema.parse(response.body)).toMatchObject({ data: { whatsapp_from: from } });
      if (hint && !PHONE.endsWith(hint)) expect(JSON.stringify(response.body)).not.toContain(hint);
    }, undefined, imessage(false), whatsappOf(true, hint));
  });

  it('gives no relation when the directory cannot say how WhatsApp is linked', async () => {
    world();
    await app('0', async ({ read }) => {
      const parsed = appControlProjectionV1Schema.parse((await read()).body);
      expect(parsed).toMatchObject({ data: { proof: ['whatsapp'] } });
      expect(parsed.data).not.toHaveProperty('whatsapp_from');
    }, undefined, imessage(false), { proof: { offered: async () => true, hint: async () => { throw new Error('directory unreadable'); } }, revision: APP_CONTROLS_WHATSAPP_PROOF_REVISION });
  });

  it('reads the same at read and act time, so an action taken on a revision 12 read is not stale', async () => {
    const w = world();
    await app('1', async ({ read, act }) => {
      const projection = appControlProjectionV1Schema.parse((await read()).body);
      const sent = appControlResultV1Schema.parse((await act({ view: 'phone', action: 'phone.sms_send', revision: projection.revision, request_id: 'phone-request-wa1' })).body);
      expect(sent.receipt.state).toBe('recorded');
      expect(w.twilio).toHaveLength(1);
    }, undefined, imessage(false), whatsappOf(true));
  });
});
