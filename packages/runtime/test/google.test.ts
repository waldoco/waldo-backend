import { describe, expect, it } from 'vitest';
import { buildMime, consentState, exchangeGoogleCode, googleClient, googleConsentUrl, googleServes, readConsentState, sha256Hex, b64url } from '../src/connectors/google';
import { connectServiceHandler, googleHandlers, type GoogleAccess } from '../src/tools/live/google';

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
  if (url.includes('tasks.googleapis.com/tasks/v1/lists/@default/tasks')) return Response.json({ items: [
    { id: 't1', title: 'Buy stamps', status: 'needsAction', updated: '2026-09-23T06:00:00Z' },
    { id: 't2', title: 'Pay rent', status: 'needsAction', due: '2026-09-30T00:00:00Z', updated: '2026-09-22T06:00:00Z' },
    { id: 't3', title: 'Renew license', status: 'completed', updated: '2026-09-21T06:00:00Z' },
  ] });
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

describe('googleServes (verified scopes or reconsent)', () => {
  it('legacy null scopes never serve a feature; empty and partial verified scopes fail closed', () => {
    // A legacy row with scopes null must route to reconsent: the proxy scope gate denies
    // every call on it, so runtime selection must not pick it on blanket trust.
    expect(googleServes(null, 'mail')).toBe(false);
    expect(googleServes(null, 'calendar')).toBe(false);
    expect(googleServes([], 'calendar')).toBe(false);
    expect(googleServes(['https://www.googleapis.com/auth/calendar.readonly'], 'mail')).toBe(false);
  });

  it('verified scopes serve their feature', () => {
    // Real granted scope sets (as stored after a verified exchange).
    expect(googleServes(['https://www.googleapis.com/auth/calendar.events'], 'calendar')).toBe(true);
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
    const page = await googleClient(app, { refresh_token: 'rt' }, fakeFetch(calls)).events('2026-09-23T00:00:00Z', '2026-09-24T00:00:00Z', 20, false);
    expect(page.items).toEqual([{ id: 'e1', title: 'Gym', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T19:00:00+05:30', all_day: false, description: 'Leg day' }]);
    expect(page.complete).toBe(true);
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
  const proposals = { propose: async () => 'proposal:1', proposeSendEmail: async () => ({ ok: true as const, id: 'proposal:1', reused: null }), record: () => undefined };
  it('reports a typed connect intent when Google is not connected, and never hands the model a URL', async () => {
    const google: GoogleAccess = { client: async () => null };
    const [query] = googleHandlers(google, proposals, clock);
    const result = await query!.handle({ include_declined: false, limit: 20 } as never, { authenticatedUserId: 'owner-1', session: { rate_limit_window: { started_at: 0 } } } as never);
    expect(result).toMatchObject({
      ok: false, code: 'auth_failed',
      error: expect.stringContaining('connect button'),
      connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: 'calendar' },
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=|accounts\.google/);
  });

  it('read handlers thread the authenticated turn trace into the connector client', async () => {
    const calls: { feature?: string; sendIntent?: string; correlation?: string }[] = [];
    const google: GoogleAccess = {
      client: (async (feature?: string, sendIntent?: string, correlation?: string) => {
        calls.push({ feature, sendIntent, correlation });
        return { events: async () => [] };
      }) as never,
    };
    const [query] = googleHandlers(google, proposals, clock);
    await query!.handle({ include_declined: false, limit: 5 } as never, { trace: 'tg-904957571', authenticatedUserId: 'owner-1', session: { rate_limit_window: { started_at: 0 } } } as never);
    expect(calls).toEqual([{ feature: 'calendar', sendIntent: undefined, correlation: 'tg-904957571' }]);
  });

  it('connect_service reports the typed intent too; already-connected stays ok', async () => {
    const down = connectServiceHandler({ client: async () => null });
    const off = await down.handle({ service: 'google' } as never, {} as never);
    expect(off).toMatchObject({
      ok: false, code: 'auth_failed',
      connect: { status: 'auth_required', service: 'google', reason: 'not_connected' },
    });
    expect(JSON.stringify(off)).not.toMatch(/https?:|state=/);
    const up = connectServiceHandler({ client: async () => ({}) as never });
    expect(await up.handle({ service: 'google' } as never, {} as never)).toMatchObject({ ok: true, data: { connected: true } });
  });

  it('get_communication reads the inbox for the last 24h by default, tainted external', async () => {
    const seen: number[] = [];
    const google: GoogleAccess = {
      client: async () => ({
        events: async () => [],
        newMail: async (since: number, limit: number) => {
          seen.push(since);
          expect(limit).toBe(10);
          return [{ id: 'm1', from: 'a@b.c', subject: 'hi', snippet: 'snip', at: '2026-09-24T10:00:00.000Z' }];
        },
        draft: async () => ({}),
      } as never),
    };
    const comms = googleHandlers(google, proposals, clock).find((h) => h.name === 'get_communication')!;
    const result = await comms.handle({} as never);
    expect(result).toMatchObject({ ok: true, source_taint: 'external' });
    if (!result.ok) return;
    const data = result.data as { since: string; messages: unknown[] };
    expect(data.messages).toHaveLength(1);
    expect(Date.parse(data.since)).toBe(seen[0]);
    expect(Date.now() - seen[0]!).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000);
  });

  it('E1: verification artifacts in mail are quarantined before the result reaches model context; ordinary mail flows', async () => {
    const google: GoogleAccess = {
      client: async () => ({
        events: async () => [],
        newMail: async () => [
          { id: 'm-otp', from: 'google-no-reply@accounts.google.com', subject: '123456 is your Google verification code', snippet: 'Enter 123456 to continue', at: '2026-09-25T09:00:00.000Z' },
          { id: 'm-reset', from: 'no-reply@example.com', subject: 'Reset your password', snippet: 'Open https://app.example.com/auth/v1/verify?token=pkce_LIVESECRET&type=recovery to choose a new one', at: '2026-09-25T09:01:00.000Z' },
          { id: 'm-receipt', from: 'receipts@amazon.com', subject: 'Your receipt from Amazon #112-3948572-1849561', snippet: 'Order total $12.34, arriving Thursday', at: '2026-09-25T09:02:00.000Z' },
        ],
        draft: async () => ({}),
      } as never),
    };
    const comms = googleHandlers(google, proposals, clock).find((h) => h.name === 'get_communication')!;
    const result = await comms.handle({} as never);
    expect(result.ok).toBe(true);
    const json = JSON.stringify(result);
    // falsifier: the artifact strings appear NOWHERE in the model-visible result
    expect(json).not.toContain('123456');
    expect(json).not.toContain('pkce_LIVESECRET');
    // quarantined rows stay owner-findable: from/at/id survive, content becomes a typed marker
    const data = result.ok ? (result.data as { messages: { id: string; from: string; subject: string; snippet: string; quarantined?: string[] }[] }) : { messages: [] };
    const otp = data.messages.find((m) => m.id === 'm-otp')!;
    expect(otp.from).toBe('google-no-reply@accounts.google.com');
    expect(otp.subject).toContain('[quarantined:');
    expect(otp.quarantined).toEqual(['otp']);
    const reset = data.messages.find((m) => m.id === 'm-reset')!;
    expect(reset.quarantined).toEqual(['magic_link']);
    // the receipt passes through byte-identical
    const receipt = data.messages.find((m) => m.id === 'm-receipt')!;
    expect(receipt.subject).toBe('Your receipt from Amazon #112-3948572-1849561');
    expect(receipt.snippet).toBe('Order total $12.34, arriving Thursday');
    expect(receipt.quarantined).toBeUndefined();
  });

  it('get_communication honours an explicit date_range and never fabricates mail when unconnected', async () => {
    const google: GoogleAccess = { client: async () => null };
    const comms = googleHandlers(google, proposals, clock).find((h) => h.name === 'get_communication')!;
    const result = await comms.handle({ date_range: { from: '2026-09-20T00:00:00.000Z', to: '2026-09-24T00:00:00.000Z' } } as never);
    expect(result).toMatchObject({ ok: false, code: 'auth_failed' });
    expect(JSON.stringify(result)).not.toMatch(/https?:/);
  });

  it('propose a calendar change without applying it', async () => {
    const google: GoogleAccess = { client: async () => null };
    const propose = googleHandlers(google, proposals, clock).find((h) => h.name === 'propose_calendar_change')!;
    expect(await propose.handle({ action: 'cancel', event_id: 'e1', reason: 'double booked' } as never)).toMatchObject({ ok: true, data: { proposal_id: 'proposal:1', applied: false } });
  });
});

describe('gmail send rail bytes', () => {
  it('buildMime is canonical: fixed header order, CRLF, injected newlines stripped, Message-ID only when set', async () => {
    const mime = buildMime({ to: ['a@x.test', 'b@x.test'], cc: ['c@x.test'], subject: 'Hi\r\nBcc: evil@x.test', body: 'line1\nline2', messageId: '<m1@waldo-send>' });
    expect(mime).toBe('To: a@x.test, b@x.test\r\nCc: c@x.test\r\nSubject: Hi Bcc: evil@x.test\r\nMessage-ID: <m1@waldo-send>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nline1\nline2');
    const draftMime = buildMime({ to: ['a@x.test'], subject: 'Hi', body: 'b' });
    expect(draftMime).not.toContain('Message-ID');
    // digest is stable for identical bytes and flips on a single-byte change
    const d1 = await sha256Hex(mime);
    expect(await sha256Hex(mime)).toBe(d1);
    expect(await sha256Hex(mime.replace('line1', 'line2'))).not.toBe(d1);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sendRaw posts the exact approved bytes to messages/send; findSentByMessageId reconciles via rfc822msgid', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
      if (url.includes('/messages/send')) return Response.json({ id: 'sent1', threadId: 't1' });
      if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'sent1' }] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const client = googleClient(app, { refresh_token: 'rt' }, f);
    const raw = 'xJ7';
    expect(await client.sendRaw(raw, 't1')).toEqual({ message_id: 'sent1', thread_id: 't1' });
    const sendCall = calls.find((c) => c.url.includes('/messages/send'))!;
    // Gmail messages.send takes base64url MIME in Message.raw: the boundary encodes exactly once.
    expect(JSON.parse(String(sendCall.init!.body))).toEqual({ raw: b64url(new TextEncoder().encode(raw)), threadId: 't1' });
    expect(await client.findSentByMessageId('<m1@waldo-send>')).toBe(true);
    const findCall = calls.find((c) => c.url.includes('/messages?'))!;
    expect(decodeURIComponent(findCall.url.replace(/\+/g, ' '))).toContain('in:sent rfc822msgid:m1@waldo-send');
  });
});

describe('calendar pagination', () => {
  it('follows nextPageToken on a short page so the requested range is fully covered', async () => {
    const seen: string[] = [];
    const paged = ((url: string | URL) => {
      const u = String(url);
      seen.push(u);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(Response.json({ access_token: 'at' }));
      const token = new URL(u).searchParams.get('pageToken');
      if (token === null) return Promise.resolve(Response.json({
        items: [{ id: 'e1', summary: 'One', start: { dateTime: '2026-09-23T18:00:00+05:30' }, end: { dateTime: '2026-09-23T19:00:00+05:30' } }],
        nextPageToken: 'p2',
      }));
      return Promise.resolve(Response.json({
        items: [{ id: 'e2', summary: 'Two', start: { dateTime: '2026-09-23T20:00:00+05:30' }, end: { dateTime: '2026-09-23T21:00:00+05:30' } }],
      }));
    }) as typeof fetch;
    const client = googleClient(app, { refresh_token: 'rt' }, paged);
    const page = await client.events('2026-09-23T00:00:00+05:30', '2026-09-24T00:00:00+05:30', 20, false);
    expect(page.items.map((event) => event.id)).toEqual(['e1', 'e2']);
    expect(page.complete).toBe(true);
    expect(seen).toHaveLength(3); // token + page 1 + page 2
    expect(seen[2]).toContain('pageToken=p2');
  });

  it('keeps paging past declined/cancelled runs so matching events on later pages are found', async () => {
    // Owner review on #202: raw-page counting returned an apparently complete empty answer
    // while matching events sat on later pages. Filters apply BEFORE the limit is counted.
    const declined = (id: string) => ({ id, summary: 'Busy', status: 'confirmed', start: { dateTime: '2026-09-23T18:00:00+05:30' }, end: { dateTime: '2026-09-23T19:00:00+05:30' }, attendees: [{ self: true, responseStatus: 'declined' }] });
    const paged = ((url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(Response.json({ access_token: 'at' }));
      const token = new URL(u).searchParams.get('pageToken');
      if (token === null) return Promise.resolve(Response.json({ items: [declined('d1'), declined('d2')], nextPageToken: 'p2' }));
      return Promise.resolve(Response.json({
        items: [{ id: 'real1', summary: 'Dentist', status: 'confirmed', start: { dateTime: '2026-09-23T20:00:00+05:30' }, end: { dateTime: '2026-09-23T21:00:00+05:30' } }],
      }));
    }) as typeof fetch;
    const page = await googleClient(app, { refresh_token: 'rt' }, paged).events('2026-09-23T00:00:00+05:30', '2026-09-24T00:00:00+05:30', 20, false);
    expect(page.items.map((event) => event.id)).toEqual(['real1']);
    expect(page.complete).toBe(true);
  });

  it('marks coverage partial when the requested limit is reached but a next page exists', async () => {
    // Owner re-review on #202: hitting the requested limit with a nextPageToken still
    // outstanding means more matching events may exist - complete must be false.
    const event = (id: string) => ({ id, summary: 'Standup', status: 'confirmed', start: { dateTime: '2026-09-23T10:00:00+05:30' }, end: { dateTime: '2026-09-23T10:30:00+05:30' } });
    const full = ((url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(Response.json({ access_token: 'at' }));
      return Promise.resolve(Response.json({ items: [event('e1'), event('e2')], nextPageToken: 'p2' }));
    }) as typeof fetch;
    const page = await googleClient(app, { refresh_token: 'rt' }, full).events('2026-09-23T00:00:00+05:30', '2026-09-24T00:00:00+05:30', 2, false);
    expect(page.items.map((item) => item.id)).toEqual(['e1', 'e2']);
    expect(page.complete).toBe(false);
  });

  it('marks coverage partial when the page bound trips with more pages remaining', async () => {
    let fetches = 0;
    const endless = ((url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(Response.json({ access_token: 'at' }));
      fetches += 1;
      return Promise.resolve(Response.json({ items: [], nextPageToken: `p${fetches}` }));
    }) as typeof fetch;
    const page = await googleClient(app, { refresh_token: 'rt' }, endless).events('2026-09-23T00:00:00+05:30', '2026-09-24T00:00:00+05:30', 20, false);
    expect(page.items).toEqual([]);
    expect(page.complete).toBe(false);
  });
});

describe('get_tasks', () => {
  it('client lists default-list tasks, maps status, and filters done items unless asked', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = googleClient(app, { refresh_token: 'rt' }, fakeFetch(calls));
    const open = await client.tasks('todo', 20);
    expect(open.items.map((task) => task.id)).toEqual(['t1', 't2']);
    expect(open.complete).toBe(true);
    expect(open.items[0]).toMatchObject({ title: 'Buy stamps', status: 'todo' });
    expect(open.items[1]).toMatchObject({ due: '2026-09-30T00:00:00Z' });
    expect(calls.at(-1)!.url).toContain('showCompleted=false');
    expect(calls.at(-1)!.url).toContain('showHidden=false');
    const done = await client.tasks('done', 20);
    expect(done.items.map((task) => ({ id: task.id, status: task.status }))).toEqual([{ id: 't3', status: 'done' }]);
    // first-party completed tasks require BOTH flags (Google tasks.list semantics)
    expect(calls.at(-1)!.url).toContain('showCompleted=true');
    expect(calls.at(-1)!.url).toContain('showHidden=true');
    const all = await client.tasks('all', 20);
    expect(all.items.map((task) => task.id)).toEqual(['t1', 't2', 't3']);
    expect(calls.at(-1)!.url).toContain('showHidden=true');
  });

  it('keeps paging past filtered-out tasks so matching ones on later pages are found', async () => {
    // Owner review on #202: one filtered page is not the whole answer.
    const paged = ((url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(Response.json({ access_token: 'at' }));
      const token = new URL(u).searchParams.get('pageToken');
      if (token === null) return Promise.resolve(Response.json({ items: [{ id: 'c1', status: 'completed' }, { id: 'c2', status: 'completed' }], nextPageToken: 'p2' }));
      return Promise.resolve(Response.json({ items: [{ id: 'open1', status: 'needsAction', title: 'Call the bank' }] }));
    }) as typeof fetch;
    const page = await googleClient(app, { refresh_token: 'rt' }, paged).tasks('todo', 20);
    expect(page.items.map((task) => task.id)).toEqual(['open1']);
    expect(page.complete).toBe(true);
  });

  it('marks coverage partial when the requested limit is reached but a next page exists', async () => {
    // Owner re-review on #202: same rule as Calendar - limit reached with a live
    // nextPageToken means the answer is partial, not complete.
    const full = ((url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(Response.json({ access_token: 'at' }));
      return Promise.resolve(Response.json({ items: [{ id: 'k1', status: 'needsAction', title: 'One' }, { id: 'k2', status: 'needsAction', title: 'Two' }], nextPageToken: 'p2' }));
    }) as typeof fetch;
    const page = await googleClient(app, { refresh_token: 'rt' }, full).tasks('todo', 2);
    expect(page.items.map((task) => task.id)).toEqual(['k1', 'k2']);
    expect(page.complete).toBe(false);
  });

  it('handler is registered, returns tasks, and notes the in-progress mapping honestly', async () => {
    const desk = { propose: async () => 'p', proposeSendEmail: async () => ({ ok: true as const, id: 'p', reused: null }), record: () => {} };
    const access: GoogleAccess = { client: async () => googleClient(app, { refresh_token: 'rt' }, fakeFetch([])) };
    const handler = googleHandlers(access, desk, clock).find((h) => h.name === 'get_tasks');
    expect(handler).toBeDefined();
    const result = await handler!.handle({ status: 'todo', limit: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { tasks: readonly { id: string }[] }).tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const inProgress = await handler!.handle({ status: 'in_progress', limit: 20 });
    expect(inProgress.ok && JSON.stringify(inProgress.data)).toContain('no in-progress state');
  });

  it('handler returns the typed connect intent when Google is not connected', async () => {
    const desk = { propose: async () => 'p', proposeSendEmail: async () => ({ ok: true as const, id: 'p', reused: null }), record: () => {} };
    const access: GoogleAccess = { client: async () => null };
    const handler = googleHandlers(access, desk, clock).find((h) => h.name === 'get_tasks')!;
    const result = await handler.handle({ status: 'todo', limit: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'auth_failed', connect: { feature: 'tasks', reason: 'not_connected' } });
  });
});
