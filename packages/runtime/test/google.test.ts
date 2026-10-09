import { describe, expect, it } from 'vitest';
import { GoogleError, b64url, buildMime, consentState, exchangeGoogleCode, googleClient, googleConsentUrl, readConsentState, sha256Hex } from '../src/connectors/google';
import { connectServiceHandler, googleHandlers, type GoogleAccess } from '../src/tools/live/google';

const app = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://w.example/oauth/google/callback' };
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-23T08:00:00Z') };

const fakeFetch = (calls: { url: string; init?: RequestInit }[]) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
  if (url.includes('/calendar/v3/')) return Response.json({ kind:'calendar#events', items: [
    { id: 'e1', summary: 'Gym', description: '  Leg day  ', start: { dateTime: '2026-09-23T18:00:00+05:30' }, end: { dateTime: '2026-09-23T19:00:00+05:30' } },
    { id: 'e2', status: 'cancelled', start: { date: '2026-09-23' }, end: { date: '2026-09-24' } },
    { id: 'e3', summary: 'Declined sync', attendees: [{ self: true, responseStatus: 'declined' }, {}], start: { dateTime: '2026-09-23T20:00:00+05:30' }, end: { dateTime: '2026-09-23T20:30:00+05:30' } },
  ] });
  if (url.includes('/gmail/v1/users/me/drafts')) return Response.json({ id: 'd1', message: { id: 'm1', threadId: 't1' } });
  if (url.includes('tasks.googleapis.com/tasks/v1/users/@me/lists')) return Response.json({ kind: 'tasks#taskLists', items: [{ id: '@default', title: 'Tasks' }] });
  if (url.includes('tasks.googleapis.com/tasks/v1/lists/%40default/tasks') || url.includes('tasks.googleapis.com/tasks/v1/lists/@default/tasks')) return Response.json({ kind: 'tasks#tasks', items: [
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
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/presentations.readonly',
    ]);
    // Read-only Workspace set only: no write, file or contacts scope.
    expect(scopes.join(' ')).not.toMatch(/drive\.file|auth\/drive |auth\/documents |auth\/spreadsheets |auth\/presentations |contacts|gmail\.modify/);
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
  const proposals = { propose: async () => 'proposal:1', proposeSendEmail: async () => 'proposal:1', record: () => undefined };
  it('returns typed receipt outcomes for email proposals without claiming a Gmail send', async () => {
    const google: GoogleAccess = { client: async () => ({} as never) };
    const args = { to: ['a@example.test'], subject: 'Hello', body_markdown: 'Body' };
    const good = googleHandlers(google, { ...proposals, proposeSendEmail: async () => 'p1' }, clock).find((tool) => tool.name === 'send_email')!;
    const receipt = await good.handle(args as never);
    expect(receipt).toMatchObject({ ok: true, data: { proposal_id: 'p1', sent: false, status: expect.stringContaining('review card') } });
    const uncertain = googleHandlers(google, { ...proposals, proposeSendEmail: async () => { throw new Error('telegram timeout'); } }, clock).find((tool) => tool.name === 'send_email')!;
    const failed = await uncertain.handle(args as never);
    expect(failed).toMatchObject({ ok: false, code: 'transient', source_taint: 'external', error: expect.stringContaining('No email was sent') });
    expect(JSON.stringify(failed)).not.toContain('telegram timeout');
    const seen: { message_id: string; dedupe_key?: string }[] = [];
    const desk = { ...proposals, proposeSendEmail: async (payload: { message_id: string; dedupe_key?: string }) => { seen.push(payload); return 'p1'; } };
    const handler = googleHandlers(google, desk, clock).find((tool) => tool.name === 'send_email')!;
    const ctx = { authenticatedUserId: 'owner-42', turnId: 'tg-123' } as never;
    await handler.handle(args as never, ctx);
    await handler.handle(args as never, ctx);
    expect(seen[0]!.dedupe_key).toBe(seen[1]!.dedupe_key);
    expect(seen[0]!.message_id).not.toBe(seen[1]!.message_id);
    await handler.handle(args as never, { authenticatedUserId: 'owner-42', turnId: 'tg-124' } as never);
    expect(seen[2]!.dedupe_key).not.toBe(seen[1]!.dedupe_key);
  });

  it('reports a typed connect intent when Google is not connected, and never hands the model a URL', async () => {
    const google: GoogleAccess = { client: async () => null };
    const query = googleHandlers(google, proposals, clock).find(h=>h.name==='query_calendar');
    const result = await query!.handle({ include_declined: false, limit: 20 } as never);
    expect(result).toMatchObject({
      ok: false, code: 'auth_failed',
      error: expect.stringContaining('connect button'),
      connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: 'calendar' },
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|state=|accounts\.google/);
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
          return [{ id: 'm1', from: 'a@b.c', subject: 'hi', snippet: 'snip', at: '2026-09-23T07:00:00.000Z' }];
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
    expect(clock.now().getTime() - seen[0]!).toBe(24 * 60 * 60 * 1000);
  });

  it('get_communication falls back to the unpaged read when the connector proxy predates mailPage (404 unknown operation), and says so', async () => {
    const google: GoogleAccess = {
      client: async () => ({
        events: async () => [],
        mailPage: async () => { throw new GoogleError(404, 'unknown operation'); },
        newMail: async () => [{ id: 'm1', from: 'a@b.c', subject: 'hi', snippet: 'snip', at: '2026-09-23T07:00:00.000Z' }],
        draft: async () => ({}),
      } as never),
    };
    const comms = googleHandlers(google, proposals, clock).find((h) => h.name === 'get_communication')!;
    const result = await comms.handle({} as never);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const data = result.data as { messages: unknown[]; query: unknown; query_note: string; coverage: { pagination: string; complete: boolean; degraded: string } };
    expect(data.messages).toHaveLength(1);
    expect(data.coverage.degraded).toBe('proxy_without_mailPage');
    expect(data.query).toBeNull();
    expect(data.query_note).toBe('legacy_since_filter_no_gmail_query');
    expect(data.coverage.pagination).toBe('unknown_not_returned_by_adapter');
    expect(data.coverage.complete).toBe(false);
  });

  it('get_communication still surfaces other mailPage errors and cursor requests without a fallback', async () => {
    const mk = (err: Error): GoogleAccess => ({ client: async () => ({ events: async () => [], mailPage: async () => { throw err; }, newMail: async () => [], draft: async () => ({}) } as never) });
    const run = (g: GoogleAccess, args: object) => googleHandlers(g, proposals, clock).find((h) => h.name === 'get_communication')!.handle(args as never);
    expect(await run(mk(new GoogleError(500, 'boom')), {})).toMatchObject({ ok: false });
    expect(await run(mk(new GoogleError(404, 'unknown operation')), { page_token: 'x' })).toMatchObject({ ok: false });
  });

  it('E1: verification artifacts in mail are quarantined before the result reaches model context; ordinary mail flows', async () => {
    const google: GoogleAccess = {
      client: async () => ({
        events: async () => [],
        newMail: async () => [
          { id: 'm-otp', from: 'google-no-reply@accounts.google.com', subject: '123456 is your Google verification code', snippet: 'Enter 123456 to continue', at: '2026-09-23T07:00:00.000Z' },
          { id: 'm-reset', from: 'no-reply@example.com', subject: 'Reset your password', snippet: 'Open https://app.example.com/auth/v1/verify?token=pkce_LIVESECRET&type=recovery to choose a new one', at: '2026-09-23T07:01:00.000Z' },
          { id: 'm-receipt', from: 'receipts@amazon.com', subject: 'Your receipt from Amazon #112-3948572-1849561', snippet: 'Order total $12.34, arriving Thursday', at: '2026-09-23T07:02:00.000Z' },
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

  it('requires a connected calendar account before preparing a proposal', async () => {
    const google: GoogleAccess = { client: async () => null };
    const propose = googleHandlers(google, proposals, clock).find((h) => h.name === 'propose_calendar_change')!;
    expect(await propose.handle({ action: 'cancel', event_id: 'e1', reason: 'double booked' } as never)).toMatchObject({ ok: false, code: 'auth_failed' });
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
      if (url.includes('/messages/sent1?')) return Response.json({id:'sent1',threadId:'t1',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:'<m1@waldo-send>'}]}});
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const client = googleClient(app, { refresh_token: 'rt' }, f);
    const raw = 'xJ7';
    expect(await client.sendRaw(raw, 't1')).toEqual({ message_id: 'sent1', thread_id: 't1' });
    const sendCall = calls.find((c) => c.url.includes('/messages/send'))!;
    expect(JSON.parse(String(sendCall.init!.body))).toEqual({ raw: 'xJ7', threadId: 't1' });
    expect(await client.findSentByMessageId('<m1@waldo-send>', 't1')).toEqual({ message_id: 'sent1', thread_id:'t1', rfc822_message_id:'<m1@waldo-send>', label_ids:['SENT'] });
    // Regression: the approved bytes are base64url MIME (google 400 'Base64 decoding failed'
    // when unencoded MIME text crosses messages/send). The tool binds exactly these bytes.
    const wire = b64url(new TextEncoder().encode(buildMime({ to: ['a@x.test'], subject: 'Hi', body: 'b', messageId: '<m2@waldo-send>' })));
    expect(await client.sendRaw(wire)).toEqual({ message_id: 'sent1', thread_id: 't1' });
    const wireCall = calls.filter((c) => c.url.includes('/messages/send')).at(-1)!;
    const posted = JSON.parse(String(wireCall.init!.body)) as { raw: string };
    expect(posted.raw).toBe(wire);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(wire.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    expect(decoded).toContain('Subject: Hi');
    expect(decoded).toContain('Message-ID: <m2@waldo-send>');
    const findCall = calls.find((c) => c.url.includes('/messages?'))!;
    expect(decodeURIComponent(findCall.url.replace(/\+/g, ' '))).toContain('in:sent rfc822msgid:m1@waldo-send');
  });
});

describe('get_tasks', () => {
  it('client lists default-list tasks, maps status, and filters done items unless asked', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = googleClient(app, { refresh_token: 'rt' }, fakeFetch(calls));
    const open = await client.tasks('todo', 20);
    expect(open.map((task) => task.id)).toEqual(['t1', 't2']);
    expect(open[0]).toMatchObject({ title: 'Buy stamps', status: 'todo' });
    expect(open[1]).toMatchObject({ due: '2026-09-30T00:00:00Z' });
    expect(calls.at(-1)!.url).toContain('showCompleted=false');
    const done = await client.tasks('done', 20);
    expect(done.map((task) => ({ id: task.id, status: task.status }))).toEqual([{ id: 't3', status: 'done' }]);
    expect(calls.at(-1)!.url).toContain('showCompleted=true');
    const all = await client.tasks('all', 20);
    expect(all.map((task) => task.id)).toEqual(['t1', 't2', 't3']);
  });

  it('handler is registered, returns tasks, and notes the in-progress mapping honestly', async () => {
    const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => {} };
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
    const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => {} };
    const access: GoogleAccess = { client: async () => null };
    const handler = googleHandlers(access, desk, clock).find((h) => h.name === 'get_tasks')!;
    const result = await handler.handle({ status: 'todo', limit: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'auth_failed', connect: { feature: 'tasks', reason: 'not_connected' } });
  });
});

describe('gmail search + thread read (A1)', () => {
  const b64 = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => {} };
  const mailFetcher = (calls: string[]) => (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
    if (url.includes('/gmail/v1/users/me/threads/t1')) return Response.json({ messages: [
      { id: 'm1', internalDate: '1759140000000', snippet: 'snip',
        payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'sam@example.com' }, { name: 'Subject', value: 'Dinner' }],
          parts: [{ mimeType: 'text/plain', body: { data: b64('Thursday works, 7pm.') } }, { mimeType: 'text/html', body: { data: b64('<p>ignored</p>') } }] } },
      { id: 'm2', internalDate: '1759143600000', snippet: 'code falls back',
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'noreply@example.com' }, { name: 'Subject', value: 'Sign in' }], body: { data: b64('Your login code is 123456.') } } },
    ] });
    if (url.includes('/gmail/v1/users/me/messages/m1?')) return Response.json({ threadId: 't1', snippet: 'snip', internalDate: '1759140000000', payload: { headers: [{ name: 'From', value: 'sam@example.com' }, { name: 'Subject', value: 'Dinner' }] } });
    if (url.includes('/gmail/v1/users/me/messages/m9?')) return Response.json({ threadId: 't9', snippet: 'G-654321 is your Google verification code', internalDate: '1759140000000', payload: { headers: [{ name: 'From', value: 'no-reply@google.com' }, { name: 'Subject', value: 'G-654321 is your Google verification code' }] } });
    if (url.includes('/gmail/v1/users/me/messages?')) return Response.json({ messages: [{ id: 'm1' }, { id: 'm9' }] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const access = (calls: string[]): GoogleAccess => ({ client: async () => googleClient(app, { refresh_token: 'rt' }, mailFetcher(calls)) });

  it('searchMail passes the q clauses through and returns thread ids for chaining into read_thread', async () => {
    const calls: string[] = [];
    const client = googleClient(app, { refresh_token: 'rt' }, mailFetcher(calls));
    const items = await client.searchMail('from:sam@example.com after:1759000000', 10);
    expect(items).toHaveLength(2);
    expect(items[0]!).toEqual({ id: 'm1', thread_id: 't1', from: 'sam@example.com', subject: 'Dinner', snippet: 'snip', at: new Date(1759140000000).toISOString() });
    const listUrl = decodeURIComponent(calls.find((u) => u.includes('messages?'))!).replace(/\+/g, ' ');
    expect(listUrl).toContain('q=from:sam@example.com after:1759000000');
    expect(listUrl).toContain('maxResults=10');
  });

  it('search_communication appends the date range as after:/before: and quarantines a verification artifact before model context', async () => {
    const calls: string[] = [];
    const handlers = googleHandlers(access(calls), desk, clock);
    const search = handlers.find((h) => h.name === 'search_communication')!;
    const result = await search.handle({ query: 'code', date_range: { from: '2026-09-28T00:00:00Z', to: '2026-09-30T00:00:00Z' }, limit: 10 } as never);
    expect(result.ok).toBe(true);
    const data = (result as { data: { messages: { id: string; subject: string; snippet: string; quarantined?: readonly string[] }[] } }).data;
    const normal = data.messages.find((m) => m.id === 'm1')!;
    expect(normal.subject).toBe('Dinner');
    expect(normal.quarantined).toBeUndefined();
    const otp = data.messages.find((m) => m.id === 'm9')!;
    expect(otp.subject).toContain('[quarantined: otp artifact');
    expect(otp.quarantined).toEqual(['otp']);
    expect(JSON.stringify(data)).not.toContain('654321');
    const listUrl = decodeURIComponent(calls.find((u) => u.includes('messages?'))!);
    expect(listUrl).toContain(`after:${Math.floor(Date.parse('2026-09-28T00:00:00Z') / 1000)}`);
    expect(listUrl).toContain(`before:${Math.floor(Date.parse('2026-09-30T00:00:00Z') / 1000)}`);
  });

  it('readThread decodes the text/plain body, falls back to the snippet, and caps at 32,000 chars', async () => {
    const client = googleClient(app, { refresh_token: 'rt' }, mailFetcher([]));
    const messages = await client.readThread('t1', 10);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.body).toBe('Thursday works, 7pm.');
    expect(messages[0]!.from).toBe('sam@example.com');
    const big = 'x'.repeat(33000);
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
      return Response.json({ messages: [{ id: 'm1', internalDate: '1759140000000', payload: { mimeType: 'text/plain', headers: [], body: { data: b64(big) } } }] });
    }) as typeof fetch;
    const [message] = await googleClient(app, { refresh_token: 'rt' }, fetcher).readThread('t1', 10);
    expect(message!.body).toHaveLength(32000);
  });

  it('read_thread quarantines a body carrying an OTP - the raw code never reaches the model', async () => {
    const handlers = googleHandlers(access([]), desk, clock);
    const read = handlers.find((h) => h.name === 'read_thread')!;
    const result = await read.handle({ thread_id: 't1', limit: 10 });
    expect(result.ok).toBe(true);
    const { messages } = (result as { data: { messages: { id: string; body: string; subject: string; quarantined?: readonly string[] }[] } }).data;
    expect(messages[0]!.body).toBe('Thursday works, 7pm.');
    expect(messages[1]!.quarantined).toEqual(['otp']);
    expect(messages[1]!.body).toContain('[quarantined: otp artifact');
    expect(messages[1]!.subject).toBe('Sign in');
    expect(JSON.stringify(messages)).not.toContain('123456');
  });

  it('owner-ruled OTP parity: read_thread relays the extracted code to the owner directly - never into model context', async () => {
    const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => {} };
    const access: GoogleAccess = { client: async () => googleClient(app, { refresh_token: 'rt' }, mailFetcher([])) };
    const relays: { from: string; artifacts: readonly { kind: string; value: string }[] }[] = [];
    const handlers = googleHandlers(access, desk, clock, async (from, artifacts) => { relays.push({ from, artifacts }); return true; });
    const read = handlers.find((h) => h.name === 'read_thread')!;
    const result = await read.handle({ thread_id: 't1', limit: 10 });
    expect(result.ok).toBe(true);
    expect(relays).toEqual([{ from: 'noreply@example.com', artifacts: [{ kind: 'otp', value: '123456' }] }]);
    const { messages } = (result as { data: { messages: { id: string; body: string; subject: string; quarantined?: readonly string[] }[] } }).data;
    expect(messages[0]!.body).toBe('Thursday works, 7pm.');
    expect(messages[1]!.quarantined).toEqual(['otp']);
    expect(messages[1]!.body).toContain('sent to the owner in a separate message');
    // falsifier: the relayed code appears NOWHERE in the model-visible result
    expect(JSON.stringify(messages)).not.toContain('123456');
  });

  it('a failed relay falls back to the source-app marker - never a false sent claim', async () => {
    const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => {} };
    const access: GoogleAccess = { client: async () => googleClient(app, { refresh_token: 'rt' }, mailFetcher([])) };
    const handlers = googleHandlers(access, desk, clock, async () => { throw new Error('telegram down'); });
    const read = handlers.find((h) => h.name === 'read_thread')!;
    const result = await read.handle({ thread_id: 't1', limit: 10 });
    expect(result.ok).toBe(true);
    const { messages } = (result as { data: { messages: { body: string }[] } }).data;
    expect(messages[1]!.body).toContain('[quarantined: otp artifact - view in the source app]');
    expect(JSON.stringify(messages)).not.toContain('123456');
  });

  it('both handlers return the typed connect intent (never a URL) when Google is not connected', async () => {
    const offline: GoogleAccess = { client: async () => null };
    const handlers = googleHandlers(offline, desk, clock);
    for (const [name, args] of [['search_communication', { query: 'x', limit: 10 }], ['read_thread', { thread_id: 't1', limit: 10 }]] as const) {
      const result = await handlers.find((h) => h.name === name)!.handle(args as never);
      expect(result).toMatchObject({ ok: false, code: 'auth_failed', source_taint: 'external', connect: { status: 'auth_required', service: 'google', reason: 'not_connected', feature: 'mail' } });
      expect(JSON.stringify(result)).not.toContain('http');
    }
  });
});
describe('Gmail provider pages',()=>{
 it('preserves opaque cursor and estimate, fetches metadata, and encodes bounded q',async()=>{
  const urls:string[]=[];
  const fetcher=(async(input:RequestInfo|URL)=>{const url=String(input);urls.push(url);
   if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'unit-token'});
   if(url.includes('/messages?'))return Response.json({messages:[{id:'m1'}],nextPageToken:'next+/=',resultSizeEstimate:9});
   return Response.json({threadId:'t1',snippet:'Notice',internalDate:'1790726401000',payload:{headers:[{name:'From',value:'notice@example.invalid'},{name:'Subject',value:'Notice'}]}});
  }) as typeof fetch;
  const page=await googleClient(app,{refresh_token:'unit-refresh'},fetcher).mailPage('in:inbox after:1790726400 before:1790812800',20,'first+/=');
  const request=new URL(urls.find(u=>u.includes('/messages?'))!);expect(request.searchParams.get('pageToken')).toBe('first+/=');expect(request.searchParams.get('q')).toContain('before:1790812800');
  expect(page).toMatchObject({next_page_token:'next+/=',result_size_estimate:9,messages:[{id:'m1',thread_id:'t1',from:'notice@example.invalid'}]});
 });
 it('rejects malformed page metadata rather than silently claiming last page',async()=>{
  for(const bad of [{nextPageToken:0},{nextPageToken:''},{resultSizeEstimate:-1},{messages:[{id:''}]}]){
   const fetcher=(async(input:RequestInfo|URL)=>String(input).includes('oauth2.googleapis.com')?Response.json({access_token:'unit-token'}):Response.json(bad)) as typeof fetch;
   await expect(googleClient(app,{refresh_token:'unit-refresh'},fetcher).mailPage('in:inbox',10)).rejects.toThrow('invalid Gmail page response');
  }
 });
});
it('rejects array provider page instead of an empty complete query',async()=>{
 const fetcher=(async(input:RequestInfo|URL)=>String(input).includes('oauth2.googleapis.com')?Response.json({access_token:'unit-token'}):Response.json([])) as typeof fetch;
 await expect(googleClient(app,{refresh_token:'unit-refresh'},fetcher).mailPage('in:inbox',10)).rejects.toThrow('invalid Gmail page response');
});


describe('Calendar mutation notification compatibility', () => {
  it.each([
    ['create', undefined], ['create', 'operation-marker'],
    ['move', undefined], ['move', 'operation-marker'],
    ['cancel', undefined], ['cancel', 'operation-marker'],
  ] as const)('%s with marker=%s preserves provider notification defaults and version fences', async (action, marker) => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const start = '2026-10-11T10:00:00Z', end = '2026-10-11T11:00:00Z';
    let current: Record<string, unknown> = { id: 'stable-event', summary: 'Synthetic meeting', start: { dateTime: start }, end: { dateTime: end }, etag: 'v2' };
    let deleted = false;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic' });
      calls.push({ url, init: init! });
      if (init?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
      if (deleted) return Response.json({ error: { message: 'gone' } }, { status: 404 });
      if (init?.body) {
        const body = JSON.parse(String(init.body));
        const endpoint = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
        current = { ...current, ...body, ...(body.start ? { start: endpoint(body.start) } : {}), ...(body.end ? { end: endpoint(body.end) } : {}) };
      }
      return Response.json(current);
    }) as typeof fetch;
    const client = googleClient(app, { refresh_token: 'synthetic' }, fetcher);
    if (action === 'create') await client.createEvent({ id: 'stable-event', title: 'Synthetic meeting', start, end, operationMarker: marker });
    else if (action === 'move') await client.moveEvent('stable-event', start, end, 'v1', marker);
    else await client.cancelEvent('stable-event', 'v1', marker);
    expect(calls).toHaveLength(2);
    expect(calls.filter(call => call.init.method)).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.searchParams.has('sendUpdates')).toBe(false);
    expect(url.searchParams.has('sendNotifications')).toBe(false);
    expect(url.pathname).toBe(`/calendar/v3/calendars/primary/events${action === 'create' ? '' : '/stable-event'}`);
    expect(init.method).toBe(action === 'create' ? 'POST' : action === 'cancel' && !marker ? 'DELETE' : 'PATCH');
    expect(new Headers(init.headers).get('if-match')).toBe(action === 'create' ? null : 'v1');
    if (init.method === 'DELETE') expect(init.body).toBeUndefined();
    else {
      const body = JSON.parse(String(init.body));
      expect(body.extendedProperties?.private?.waldoOperation).toBe(marker);
      if (action === 'create') expect(body.id).toBe('stable-event');
      if (action === 'cancel') expect(body).toEqual({ status: 'cancelled', extendedProperties: { private: { waldoOperation: marker } } });
      else expect(body).toMatchObject({ start: { dateTime: start, date: null }, end: { dateTime: end, date: null } });
    }
  });
});
