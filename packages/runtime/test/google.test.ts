import { describe, expect, it } from 'vitest';
import { googleClient, googleConsentUrl, oauthState, verifyOauthState } from '../src/connectors/google';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';

const app = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://w.example/oauth/google/callback' };
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-23T08:00:00Z') };

const fakeFetch = (calls: { url: string; init?: RequestInit }[]) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
  if (url.includes('/calendar/v3/')) return Response.json({ items: [
    { id: 'e1', summary: 'Gym', start: { dateTime: '2026-09-23T18:00:00+05:30' }, end: { dateTime: '2026-09-23T19:00:00+05:30' } },
    { id: 'e2', status: 'cancelled', start: { date: '2026-09-23' }, end: { date: '2026-09-24' } },
    { id: 'e3', summary: 'Declined sync', attendees: [{ self: true, responseStatus: 'declined' }, {}], start: { dateTime: '2026-09-23T20:00:00+05:30' }, end: { dateTime: '2026-09-23T20:30:00+05:30' } },
  ] });
  if (url.includes('/gmail/v1/users/me/drafts')) return Response.json({ id: 'd1', message: { id: 'm1', threadId: 't1' } });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

describe('google oauth state', () => {
  it('binds the owner and expires', async () => {
    const state = await oauthState('s', '42', 1_000);
    expect(await verifyOauthState('s', state, 2_000)).toBe('42');
    expect(await verifyOauthState('other', state, 2_000)).toBeNull();
    expect(await verifyOauthState('s', state.replace('42.', '43.'), 2_000)).toBeNull();
    expect(await verifyOauthState('s', state, 1_000 + 16 * 60_000)).toBeNull();
  });

  it('asks for offline calendar and draft scopes only', () => {
    const url = new URL(googleConsentUrl(app, 'st'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.compose');
    expect(url.searchParams.get('redirect_uri')).toBe(app.redirectUri);
  });
});

describe('google client', () => {
  it('reads events without cancelled or declined ones', async () => {
    const calls: { url: string }[] = [];
    const events = await googleClient(app, { refresh_token: 'rt' }, fakeFetch(calls)).events('2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z', 20, false);
    expect(events).toEqual([{ id: 'e1', title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false }]);
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
  const proposals = { add: () => 'proposal:1' };
  it('return a connect link when Google is not connected', async () => {
    const google: GoogleAccess = { client: async () => null, connectUrl: async () => 'https://accounts.google.com/x' };
    const [query] = googleHandlers(google, proposals, clock);
    expect(await query!.handle({ include_declined: false, limit: 20 } as never)).toMatchObject({ ok: false, code: 'auth_failed', error: expect.stringContaining('https://accounts.google.com/x') });
  });

  it('propose a calendar change without applying it', async () => {
    const google: GoogleAccess = { client: async () => null, connectUrl: async () => null };
    const [, propose] = googleHandlers(google, proposals, clock);
    expect(await propose!.handle({ action: 'cancel', event_id: 'e1', reason: 'double booked' } as never)).toMatchObject({ ok: true, data: { proposal_id: 'proposal:1', applied: false } });
  });
});
