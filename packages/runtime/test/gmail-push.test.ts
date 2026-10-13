import { describe, expect, it, vi } from 'vitest';
import { gmailPush, gmailWatchDue, GMAIL_WATCH_URL, parseGmailPush, startGmailWatch, verifyPushToken } from '../src/connectors/google-push';

const AUD = 'https://w.test/events/gmail';
const SA = 'waldo-gmail-push@waldo-dev.iam.gserviceaccount.com';
const b64url = (bytes: ArrayBuffer | Uint8Array | string) => btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const NOW = 1_760_000_000;
const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key = pair.privateKey) => {
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${body}.${b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body)))}`;
};
const good = { iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true, iat: NOW - 10, exp: NOW + 3000 };
const keys = async (kid: string) => kid === 'k1' ? pair.publicKey : null;
const verify = (token: string) => verifyPushToken(token, { audience: AUD, serviceAccount: SA, now: NOW, keys });

describe('Pub/Sub push token', () => {
  it('accepts a token Google signed for this endpoint and this service account', async () => {
    expect(await verify(await sign(good))).toBe(true);
    expect(await verify(await sign({ ...good, iss: 'accounts.google.com' }))).toBe(true);
  });
  it.each([
    ['another audience', { ...good, aud: 'https://w.test/events/elsewhere' }],
    ['another service account', { ...good, email: 'attacker@evil-project.iam.gserviceaccount.com' }],
    ['an unverified email', { ...good, email_verified: false }],
    ['an expired token', { ...good, exp: NOW - 1 }],
    ['a token from the future', { ...good, iat: NOW + 600 }],
    ['another issuer', { ...good, iss: 'https://evil.test' }],
  ])('refuses %s', async (_name, claims) => {
    expect(await verify(await sign(claims))).toBe(false);
  });
  it('refuses a token signed by another key, an unknown key id, alg none, and garbage', async () => {
    expect(await verify(await sign(good, undefined, other.privateKey))).toBe(false);
    expect(await verify(await sign(good, { alg: 'RS256', kid: 'k2' }))).toBe(false);
    expect(await verify(`${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64url(JSON.stringify(good))}.`)).toBe(false);
    for (const token of ['', 'a.b', 'a.b.c', 'x'.repeat(10_000)]) expect(await verify(token)).toBe(false);
  });
});

describe('Pub/Sub Gmail message', () => {
  const body = (data: unknown, messageId = '123') => JSON.stringify({ message: { data: b64url(JSON.stringify(data)), messageId }, subscription: 'projects/p/subscriptions/s' });
  it('reads the mailbox and history id', () => {
    expect(parseGmailPush(body({ emailAddress: 'Sam@Example.com', historyId: 98765432101 }))).toEqual({ account: 'sam@example.com', historyId: '98765432101' });
  });
  it.each([body({ emailAddress: 'not an address', historyId: 1 }), body({ emailAddress: 'a@b.co' }), body({ emailAddress: 'a@b.co', historyId: 'x' }), '{}', 'not json', JSON.stringify({ message: { data: '!!!' } })])('refuses %j', (raw) => {
    expect(parseGmailPush(raw)).toBeNull();
  });
});

describe('Gmail watch', () => {
  it('watches the inbox into the topic and reads back the history point', async () => {
    const fetcher = vi.fn(async () => Response.json({ historyId: '555', expiration: '1760600000000' }));
    expect(await startGmailWatch(fetcher as unknown as typeof fetch, 'ya29.t', 'projects/waldo-dev/topics/waldo-gmail-push')).toEqual({ historyId: '555', expiration: 1760600000000 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GMAIL_WATCH_URL);
    expect(JSON.parse(String(init.body))).toEqual({ topicName: 'projects/waldo-dev/topics/waldo-gmail-push', labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' });
  });
  it('asks a failing cert endpoint at most once a minute', async () => {
    vi.resetModules();
    const { googlePushKeys: fresh } = await import('../src/connectors/google-push');
    const fetcher = vi.fn(async () => new Response('unavailable', { status: 503 }));
    let now = 10_000_000;
    const keys = fresh(fetcher as unknown as typeof fetch, () => now);
    expect(await keys('kid-1')).toBeNull();
    now += 30_000;
    expect(await keys('kid-1')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 31_000;
    await keys('kid-1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('renews daily, a day before expiry, and six hours after a failure', () => {
    const DAY = 86_400_000;
    expect(gmailWatchDue(null, 0)).toBe(true);
    expect(gmailWatchDue({ startedAt: 0, expiration: 7 * DAY }, DAY - 1)).toBe(false);
    expect(gmailWatchDue({ startedAt: 0, expiration: 7 * DAY }, DAY)).toBe(true);
    expect(gmailWatchDue({ failedAt: 0 }, 5 * 3_600_000)).toBe(false);
    expect(gmailWatchDue({ failedAt: 0 }, 6 * 3_600_000)).toBe(true);
  });
  it('is off until the owner names the Google Cloud project', () => {
    expect(gmailPush('')).toBeNull();
    expect(gmailPush('waldo-dev')).toEqual({ topic: 'projects/waldo-dev/topics/waldo-gmail-push', serviceAccount: 'waldo-gmail-push@waldo-dev.iam.gserviceaccount.com' });
  });
});
