import { describe, expect, it } from 'vitest';
import { consentState, exchangeGoogleCode, googleClient, googleConsentUrl, readConsentState } from '../src/connectors/google';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';

const app = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://w.example/oauth/google/callback' };
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-23T08:00:00Z') };

const fakeFetch = (calls: { url: string; init?: RequestInit }[]) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
  if (url.includes('/calendar/v3/')) return Response.json({ items: [
    { id: 'e1', summary: 'Gym', description: '  Leg day  ', start: { dateTime: '2026-09-23T18:00:00+05:30' }, end: { dateTime: '2026-09-23T19:00:00+05:30' } },
    { id: 'e2', status: 'cancelled', start: { date: '2026-09-23' }, end: { date: '2026-09-24' } },
    { id: 'e3', summary: 'Declined sync', attendees: [{ self: true, responseStatus: 'declined' }, {}], start: { dateTime: '2026-09-23T20:00:00+05:30' }, end: { dateTime: '2026-09-23T20:30:00+05:30' } },
  ] });
  if (url.includes('/gmail/v1/users/me/drafts')) return Response.json({ id: 'd1', message: { id: 'm1', threadId: 't1' } });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

describe('google oauth state', () => {
  it('binds the owner and a one-time nonce; a foreign secret or an edited owner, nonce or MAC fails', async () => {
    const state = await consentState('s', '42', 'nonce1');
    expect(await readConsentState('s', state)).toEqual({ owner: '42', nonce: 'nonce1' });
    expect(await readConsentState('other', state)).toBeNull();
    expect(await readConsentState('s', state.replace('42.', '43.'))).toBeNull();
    expect(await readConsentState('s', state.replace('nonce1', 'nonce2'))).toBeNull();
    expect(await readConsentState('s', state.slice(0, -8))).toBeNull();
    expect(await readConsentState('s', '')).toBeNull();
  });

  it('asks once for the combined set - calendar, mail and tasks - offline, adding to what was granted', () => {
    const url = new URL(googleConsentUrl(app, 'st', 'challenge'));
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual([
      'openid', 'email',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/tasks',
    ]);
    expect(scopes.join(' ')).not.toMatch(/drive|documents|spreadsheets|presentations|contacts|gmail\.modify/);
    expect(url.searchParams.get('redirect_uri')).toBe(app.redirectUri);
  });
});

describe('google client', () => {
  it('exchanges the code with its PKCE verifier and the exact redirect URI', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tokenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ access_token: 'at', refresh_token: 'rt', scope: 'openid email' });
    }) as typeof fetch;
    expect(await exchangeGoogleCode(app, 'code1', tokenFetch, 'verifier1')).toMatchObject({ refresh_token: 'rt', scopes: ['openid', 'email'] });
    const body = new URLSearchParams(String(calls[0]!.init!.body));
    expect(body.get('code_verifier')).toBe('verifier1');
    expect(body.get('redirect_uri')).toBe(app.redirectUri);
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('reads events without cancelled or declined ones', async () => {
    const calls: { url: string }[] = [];
    const events = await googleClient(app, { refresh_token: 'rt' }, fakeFetch(calls)).events('2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z', 20, false);
    expect(events).toEqual([{ id: 'e1', title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false, description: 'Leg day' }]);
    expect(calls[1]!.url).toContain('singleEvents=true');
  });

  it('saves a draft and strips header line breaks', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const draft = await googleClient(app, { refresh_token: 'rt' }, fakeFetch(calls)).draft({ to: ['a@example.com'], subject: 'Hi\r\nBcc: x@evil.test', body: 'Body' });
    expect(draft).toEqual({ draft_id: 'd1', message_id: 'm1', thread_id: 't1' });
    const raw = (JSON.parse(String(calls[1]!.init!.body)) as { message: { raw: string } }).message.raw;
    const mime = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    expect(mime).toContain('Subject: Hi Bcc: x@evil.test\r\n');
    expect(mime).not.toContain('\r\nBcc:');
  });
});

describe('google tools', () => {
  const proposals = { propose: async () => 'proposal:1', record: () => undefined };
  it('send the connect link as a button when Google is not connected, and never hand the model the URL', async () => {
    const sent: string[] = [];
    const google: GoogleAccess = { client: async () => null, connectUrl: async () => 'https://accounts.google.com/x?state=s1' };
    const [query] = googleHandlers(google, proposals, clock, async (url) => (sent.push(url), true));
    const result = await query!.handle({ include_declined: false, limit: 20 } as never);
    expect(result).toMatchObject({ ok: false, code: 'auth_failed', error: expect.stringContaining('connect button was sent') });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=|accounts\.google/);
    expect(sent).toEqual(['https://accounts.google.com/x?state=s1']);
  });

  it('without a working button channel the URL still never reaches the model', async () => {
    const google: GoogleAccess = { client: async () => null, connectUrl: async () => 'https://accounts.google.com/x?state=s1' };
    for (const deliver of [undefined, async () => false]) {
      const [query] = googleHandlers(google, proposals, clock, deliver);
      const result = await query!.handle({ include_declined: false, limit: 20 } as never);
      expect(result).toMatchObject({ ok: false, code: 'auth_failed', error: expect.stringContaining('could not be sent') });
      expect(JSON.stringify(result)).not.toMatch(/https?:|state=/);
    }
  });

  it('propose a calendar change without applying it', async () => {
    const google: GoogleAccess = { client: async () => null, connectUrl: async () => null };
    const [, propose] = googleHandlers(google, proposals, clock);
    expect(await propose!.handle({ action: 'cancel', event_id: 'e1', reason: 'double booked' } as never)).toMatchObject({ ok: true, data: { proposal_id: 'proposal:1', applied: false } });
  });
});
