import { describe, expect, it } from 'vitest';
import { GOOGLE_METHODS, googleClient } from '../src/connectors/google';

// Every address, subject and event here is synthetic.
const app = { clientId: 'test', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;
const client = (route: Route) => {
  const urls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
    urls.push(url);
    return route(url, init) ?? Response.json({ error: { message: 'unexpected' } }, { status: 500 });
  }) as typeof fetch;
  return { urls, client: googleClient(app, { refresh_token: 'fixture' }, fetcher) };
};
const message = (id: string, labels: readonly string[], thread = `t-${id}`) => ({ id, threadId: thread, labelIds: labels });
const metadata = (url: URL) => {
  const id = url.pathname.split('/').pop()!;
  return Response.json({ id, threadId: `t-${id}`, snippet: `snippet ${id}`, internalDate: '1793000000000', payload: { headers: [{ name: 'From', value: `Sender ${id} <${id}@example.test>` }, { name: 'Subject', value: `Subject ${id}` }] } });
};

describe('mailDelta', () => {
  it('reads inbox history from the cursor: new primary inbox mail with metadata, and label changes, then the new history id', async () => {
    const { urls, client: google } = client((url) => {
      if (url.pathname.endsWith('/history')) {
        return url.searchParams.get('pageToken') === 'p2'
          ? Response.json({ historyId: '120', history: [{ id: '119', labelsRemoved: [{ message: message('m1', ['INBOX']), labelIds: ['UNREAD'] }] }] })
          : Response.json({ historyId: '118', nextPageToken: 'p2', history: [
            { id: '111', messagesAdded: [{ message: message('m1', ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL']) }] },
            { id: '112', messagesAdded: [{ message: message('promo', ['INBOX', 'CATEGORY_PROMOTIONS']) }, { message: message('sent', ['SENT']) }, { message: message('draft', ['DRAFT']) }] },
            { id: '113', labelsAdded: [{ message: message('m0', ['INBOX', 'STARRED']), labelIds: ['STARRED'] }], labelsRemoved: [{ message: message('m9', []), labelIds: ['INBOX'] }] },
          ] });
      }
      if (url.pathname.includes('/messages/')) return metadata(url);
      return undefined;
    });
    const delta = await google.mailDelta!('110', 20);
    expect(delta).toEqual({ state: 'delta', history_id: '120', left_out: 0,
      added: [{ id: 'm1', thread_id: 't-m1', from: 'Sender m1 <m1@example.test>', subject: 'Subject m1', snippet: 'snippet m1', at: new Date(1793000000000).toISOString() }],
      labels: [{ message_id: 'm0', thread_id: 't-m0', change: 'starred' }, { message_id: 'm9', thread_id: 't-m9', change: 'archived' }, { message_id: 'm1', thread_id: 't-m1', change: 'read' }] });
    const history = urls.find(url => url.pathname.endsWith('/history'))!;
    expect(history.searchParams.get('startHistoryId')).toBe('110');
    expect(history.searchParams.getAll('historyTypes').sort()).toEqual(['labelAdded', 'labelRemoved', 'messageAdded']);
    expect(urls.filter(url => url.pathname.includes('/messages/')).map(url => url.pathname.split('/').pop())).toEqual(['m1']);
  });

  it('caps the messages it opens and says how many it left out, while still moving to the newest history id', async () => {
    const { urls, client: google } = client((url) => {
      if (url.pathname.endsWith('/history')) return Response.json({ historyId: '300', history: [{ id: '201', messagesAdded: ['a', 'b', 'c'].map(id => ({ message: message(id, ['INBOX']) })) }] });
      if (url.pathname.includes('/messages/')) return metadata(url);
      return undefined;
    });
    const delta = await google.mailDelta!('200', 2);
    expect(delta).toMatchObject({ state: 'delta', history_id: '300', left_out: 1 });
    expect(delta.state === 'delta' && delta.added.map(item => item.id)).toEqual(['b', 'c']);
    expect(urls.filter(url => url.pathname.includes('/messages/'))).toHaveLength(2);
  });

  it('re-baselines on a cursor Google no longer knows (404): the profile history id, and no changes', async () => {
    const { client: google } = client((url) => {
      if (url.pathname.endsWith('/history')) return Response.json({ error: { code: 404, message: 'Requested entity was not found.' } }, { status: 404 });
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: 'owner@example.test', historyId: '999' });
      return undefined;
    });
    expect(await google.mailDelta!('1', 20)).toEqual({ state: 'rebased', history_id: '999' });
  });

  it('starts a mailbox with no cursor from its current history id', async () => {
    const { urls, client: google } = client((url) => url.pathname.endsWith('/profile') ? Response.json({ historyId: '42' }) : undefined);
    expect(await google.mailDelta!(null, 20)).toEqual({ state: 'rebased', history_id: '42' });
    expect(urls.map(url => url.pathname)).toEqual(['/gmail/v1/users/me/profile']);
  });

  it('fails closed on a malformed history page rather than moving the cursor', async () => {
    const { client: google } = client((url) => url.pathname.endsWith('/history') ? Response.json({ historyId: 'not-a-number', history: [] }) : undefined);
    await expect(google.mailDelta!('1', 20)).rejects.toThrow('invalid Gmail history');
  });
});

describe('calendarDelta', () => {
  const event = (id: string, extra: Record<string, unknown> = {}) => ({ id, etag: `"${id}-1"`, status: 'confirmed', summary: `Event ${id}`, created: '2026-11-01T08:00:00Z', updated: '2026-11-03T08:00:00Z',
    start: { dateTime: '2026-11-04T10:00:00Z' }, end: { dateTime: '2026-11-04T11:00:00Z' }, ...extra });

  it('reads changes since the sync token, unbounded in time, marking invites and recurring series', async () => {
    const { urls, client: google } = client((url) => url.pathname.endsWith('/events') ? Response.json({ kind: 'calendar#events', nextSyncToken: 'sync-2', items: [
      event('plain'),
      event('invite', { organizer: { email: 'host@example.test' }, attendees: [{ self: true, responseStatus: 'needsAction' }, { email: 'host@example.test', responseStatus: 'accepted' }] }),
      event('series', { recurrence: ['RRULE:FREQ=WEEKLY'] }),
      { id: 'gone', status: 'cancelled', etag: '"gone-2"' },
    ] }) : undefined);
    const delta = await google.calendarDelta!('team@group.example.test', 'sync-1', Date.parse('2026-11-02T00:00:00Z'));
    expect(delta.state).toBe('delta');
    if (delta.state !== 'delta') return;
    expect(delta.sync_token).toBe('sync-2');
    expect(delta.events.map(item => [item.id, item.status, item.invite ?? false, item.series ?? false, item.etag])).toEqual([
      ['plain', 'confirmed', false, false, '"plain-1"'], ['invite', 'confirmed', true, false, '"invite-1"'], ['series', 'confirmed', false, true, '"series-1"'], ['gone', 'cancelled', false, false, '"gone-2"']]);
    const read = urls[0]!;
    expect(read.pathname).toBe('/calendar/v3/calendars/team%40group.example.test/events');
    expect(read.searchParams.get('syncToken')).toBe('sync-1');
    expect(read.searchParams.has('timeMin')).toBe(false);
    expect(read.searchParams.get('showDeleted')).toBe('true');
    expect(read.searchParams.get('singleEvents')).toBe('false');
  });

  it('re-baselines from the window start on an invalid token (410), keeping the new token and returning no changes', async () => {
    const { urls, client: google } = client((url) => {
      if (url.searchParams.has('syncToken')) return Response.json({ error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.' } }, { status: 410 });
      return url.searchParams.get('pageToken') === 'more'
        ? Response.json({ kind: 'calendar#events', nextSyncToken: 'fresh', items: [event('b')] })
        : Response.json({ kind: 'calendar#events', nextPageToken: 'more', items: [event('a')] });
    });
    const from = Date.parse('2026-11-02T00:00:00Z');
    expect(await google.calendarDelta!('primary', 'stale', from)).toEqual({ state: 'rebased', sync_token: 'fresh' });
    expect(urls[1]!.searchParams.get('timeMin')).toBe(new Date(from).toISOString());
    expect(urls[1]!.searchParams.has('syncToken')).toBe(false);
  });

  it('starts a calendar with no token from a baseline, and gives up past the page cap rather than read without end', async () => {
    let pages = 0;
    const { client: google } = client(() => { pages += 1; return Response.json({ kind: 'calendar#events', nextPageToken: `p${pages}`, items: [] }); });
    expect(await google.calendarDelta!('primary', null, Date.parse('2026-11-02T00:00:00Z'))).toEqual({ state: 'capped' });
    expect(pages).toBe(8);
  });

  it('is reachable through the connector proxy', () => {
    expect(GOOGLE_METHODS).toEqual(expect.arrayContaining(['mailDelta', 'calendarDelta']));
  });
});
