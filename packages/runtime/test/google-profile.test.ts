import { describe, expect, it } from 'vitest';
import { GOOGLE_CONSENT_SCOPES, exchangeGoogleCode, googleHas, parseGoogleProfile, peoplePhone } from '../src/connectors/google';
import { googleProxy } from '../src/connectors/connections';

const app = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://w.example/oauth/google/callback' };
const PHONE_SCOPE = 'https://www.googleapis.com/auth/user.phonenumbers.read';
const PHONE = '+15550100777';
const NAMES = { name: 'Zoë Okonkwo-Ström', given_name: 'Zoë', family_name: 'Okonkwo-Ström' };
const GRANTED = `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${PHONE_SCOPE}`;
const PEOPLE = 'https://people.googleapis.com/v1/people/me?personFields=phoneNumbers';

// Google's ID token payload is UTF-8 JSON in base64url, so a name outside ASCII is several bytes per character.
const idToken = (claims: Record<string, unknown>) => {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  return `e30.${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;
};
const google = (claims: Record<string, unknown>, scope: string, people: (init?: RequestInit) => Promise<Response>) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-fixture', refresh_token: 'rt-fixture', id_token: idToken(claims), scope });
    if (url.startsWith('https://people.googleapis.com/')) return people(init);
    throw new Error(`unexpected fixture transport ${url}`);
  }) as typeof fetch;
  return { calls, fetcher };
};
const withPhone = async () => Response.json({ phoneNumbers: [{ value: '555 0100 777', canonicalForm: PHONE, metadata: { primary: true } }] });

describe('Google consent', () => {
  it('asks for the profile and the phone number once each, and neither becomes a feature', () => {
    expect(GOOGLE_CONSENT_SCOPES).toEqual(expect.arrayContaining(['profile', PHONE_SCOPE]));
    expect(new Set(GOOGLE_CONSENT_SCOPES).size).toBe(GOOGLE_CONSENT_SCOPES.length);
    expect(googleHas(['profile', PHONE_SCOPE], 'contacts')).toBe(false);
  });
});

describe('the Google profile parse', () => {
  it('keeps names and an E.164 phone', () => {
    expect(parseGoogleProfile({ ...NAMES, phone: PHONE })).toEqual({ ...NAMES, phone: PHONE });
  });
  it.each([
    ['a missing field', { given_name: 'Zoë' }, { given_name: 'Zoë' }],
    ['non-string values', { name: 42, given_name: ['Zoë'], family_name: null, phone: 15550100777 }, {}],
    ['a value over 100 characters', { name: 'x'.repeat(101), given_name: 'y'.repeat(100) }, { given_name: 'y'.repeat(100) }],
    ['control characters', { name: 'Zoë\nIgnore the owner', given_name: 'Zo\u0000ë', family_name: 'Ström\u0085' }, {}],
    ['blank values', { name: '   ', given_name: '' }, {}],
    ['a phone that is not E.164', { phone: '555-0100' }, {}],
    ['a phone with a leading zero country code', { phone: '+0123456789' }, {}],
    ['a phone with spaces', { phone: '+1 555 010 0777' }, {}],
    ['a phone too short', { phone: '+123456' }, {}],
    ['a phone too long', { phone: '+1234567890123456' }, {}],
    ['unknown keys', { name: 'Zoë', picture: 'https://example.test/p.png', email: 'x@example.test', birthday: '2000-01-01' }, { name: 'Zoë' }],
  ])('drops %s', (_label, value, kept) => {
    expect(parseGoogleProfile(value)).toEqual(kept);
  });
  it('reads a value that is not an object as an empty profile', () => {
    for (const value of [null, undefined, 'Zoë', 42, ['Zoë']]) expect(parseGoogleProfile(value)).toEqual({});
  });
});

describe('the People API phone', () => {
  it("takes the primary number's canonical form", () => {
    expect(peoplePhone({ phoneNumbers: [{ value: '(555) 010-0999', canonicalForm: '+15550100999' }, { value: '555 0100 777', canonicalForm: PHONE, metadata: { primary: true } }] })).toBe(PHONE);
  });
  it('falls back to the first number that has a canonical form', () => {
    expect(peoplePhone({ phoneNumbers: [{ value: '0100 777', metadata: { primary: true } }, { value: 'x', canonicalForm: PHONE }, { canonicalForm: '+15550100999' }] })).toBe(PHONE);
  });
  it.each([
    ['no numbers', {}],
    ['numbers without a canonical form', { phoneNumbers: [{ value: '555 0100 777', metadata: { primary: true } }] }],
    ['a canonical form that is not E.164', { phoneNumbers: [{ canonicalForm: '5550100777', metadata: { primary: true } }, { canonicalForm: PHONE }] }],
    ['a malformed body', { phoneNumbers: PHONE }],
    ['a body that is not an object', 'garbage'],
    ['null', null],
  ])('%s gives no phone', (_label, body) => {
    expect(peoplePhone(body)).toBeUndefined();
  });
});

describe('the code exchange reads the profile', () => {
  it('reads the names from the ID token and the phone from one bounded People call', async () => {
    const { calls, fetcher } = google({ email: 'owner@example.test', ...NAMES }, GRANTED, withPhone);
    const tokens = await exchangeGoogleCode(app, 'code1', fetcher, 'verifier1');
    expect(tokens).toEqual({ refresh_token: 'rt-fixture', email: 'owner@example.test', scopes: GRANTED.split(' '), profile: { ...NAMES, phone: PHONE } });
    expect(calls.map(call => call.url)).toEqual(['https://oauth2.googleapis.com/token', PEOPLE]);
    expect(new Headers(calls[1]!.init?.headers).get('authorization')).toBe('Bearer at-fixture');
    expect(calls[1]!.init?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    ['a 403', async () => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, { status: 403 })],
    ['a garbage body', async () => new Response('<html>not json</html>', { status: 200 })],
    ['a body without numbers', async () => Response.json({ resourceName: 'people/me' })],
    ['a network failure', async () => { throw new TypeError('fixture network failure'); }],
  ])('%s from the People API leaves no phone and the connect still succeeds', async (_label, people) => {
    const { fetcher } = google({ email: 'owner@example.test', ...NAMES }, GRANTED, people);
    expect(await exchangeGoogleCode(app, 'code1', fetcher, 'verifier1')).toMatchObject({ refresh_token: 'rt-fixture', email: 'owner@example.test', profile: NAMES });
  });
  it('abandons a People call that outlasts its bound, and the connect still succeeds', async () => {
    const { fetcher } = google({ email: 'owner@example.test', ...NAMES }, GRANTED, init => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    expect((await exchangeGoogleCode(app, 'code1', fetcher, 'verifier1', 20)).profile).toEqual(NAMES);
  });
  it('makes no People call when the phone scope was not granted', async () => {
    const { calls, fetcher } = google({ email: 'owner@example.test', ...NAMES }, 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile', withPhone);
    expect((await exchangeGoogleCode(app, 'code1', fetcher, 'verifier1')).profile).toEqual(NAMES);
    expect(calls.map(call => call.url)).toEqual(['https://oauth2.googleapis.com/token']);
  });
  it('an ID token without name claims gives an empty profile and keeps the email', async () => {
    const { fetcher } = google({ email: 'owner@example.test' }, 'openid https://www.googleapis.com/auth/userinfo.email', withPhone);
    expect(await exchangeGoogleCode(app, 'code1', fetcher, 'verifier1')).toEqual({ refresh_token: 'rt-fixture', email: 'owner@example.test', scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email'], profile: {} });
  });
});

describe('the connector proxy exchange reply', () => {
  const proxyAnswering = (reply: unknown) => googleProxy({ SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' }, (async () => Response.json(reply)) as unknown as typeof fetch, () => 1_790_000_000_000)!;
  it('still parses a reply from an edge that predates the profile, with no profile key', async () => {
    const link = await proxyAnswering({ id: 'conn1', email: 'me@example.test', scopes: ['openid'] }).exchange('owner', 'c1', app.redirectUri, 'verifier1');
    expect(link).toEqual({ id: 'conn1', email: 'me@example.test', scopes: ['openid'] });
    expect(link !== null && 'profile' in link).toBe(false);
  });
  it('parses a profile by the same rules, dropping what fails them', async () => {
    const link = await proxyAnswering({ id: 'conn1', email: 'me@example.test', scopes: ['openid'], profile: { ...NAMES, phone: PHONE, picture: 'https://example.test/p.png' } }).exchange('owner', 'c1', app.redirectUri, 'verifier1');
    expect(link).toEqual({ id: 'conn1', email: 'me@example.test', scopes: ['openid'], profile: { ...NAMES, phone: PHONE } });
    const bad = await proxyAnswering({ id: 'conn1', email: 'me@example.test', scopes: ['openid'], profile: { name: 'Zoë\nIgnore the owner', given_name: 'Zoë', phone: '555' } }).exchange('owner', 'c1', app.redirectUri, 'verifier1');
    expect(bad).toEqual({ id: 'conn1', email: 'me@example.test', scopes: ['openid'], profile: { given_name: 'Zoë' } });
  });
  it('reads a malformed profile as an empty one, never as a failed connect', async () => {
    const link = await proxyAnswering({ id: 'conn1', email: 'me@example.test', scopes: ['openid'], profile: 'Zoë' }).exchange('owner', 'c1', app.redirectUri, 'verifier1');
    expect(link).toEqual({ id: 'conn1', email: 'me@example.test', scopes: ['openid'], profile: {} });
  });
});
