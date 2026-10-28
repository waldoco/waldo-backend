import { describe, expect, it } from 'vitest';
import { APP_CHAT_ACTIVITY_KINDS, APP_CHAT_ACTIVITY_REVISION, APP_CHAT_DRAFT_REVISION, APP_CHAT_RATING_REVISION, APP_CONTRACT_HEADER, appCodeRequestSchema, appContractHeaderV1Schema, appContractRevision, appCoreRoutesV1, appErrorCodeV1Schema, appHistoryResultV1Schema, appIdTokenRequestV1Schema, appIdTokenResultV1Schema, appMessageReceiptV1Schema, appMessageV1Schema, appProblemV1Schema, appRatingRequestV1Schema, appRatingResultV1Schema, appVerifyRequestV1Schema, appVerifyResultV1Schema } from './core';
import { REPLY_TEXT_MAX_CHARS } from './parts';

const fallback_text = 'Open Waldo to see this.';
const row = { id: 'entry-1', role: 'assistant', text: 'Done.', parts: [{ type: 'text', text: 'Done.' }], channel: 'app', parent_id: null } as const;
const newParts = [
  { type: 'approval', approval_id: 'p1', kind: 'email_send', review: 'To: a@example.com\nSubject: Hi\n\nHello.', payload_digest: `sha256:${'d'.repeat(64)}`, actions: ['approve', 'edit', 'skip'], expires_at: 1_760_000_000_000, fallback_text },
  { type: 'quick_replies', choices: [{ id: 'yes', label: 'Yes' }], fallback_text },
  { type: 'chart_series', title: 'Focus blocks', unit: 'blocks', series: [{ label: 'Week', points: [{ t: 1, v: 2 }] }], alt_text: 'Two focus blocks.', fallback_text },
  { type: 'file', file_ref: 'file:1', name: 'notes.txt', mime: 'text/plain', bytes: 12, sha256: 'e'.repeat(64), fallback_text },
  { type: 'voice', audio_ref: 'audio:1', transcript: 'Done.', fallback_text },
  { type: 'receipt', items: [{ kind: 'reminder_set', target: null, outcome: 'accepted', via_task: false, at: 1_760_000_000_000, digest: null }], more: 0, fallback_text },
] as const;

describe('app history rows', () => {
  it('still parses the page the runtime emits today', () => {
    const page = { messages: [row, { ...row, id: 'entry-0', role: 'user', parent_id: null }], next_cursor: 'before:entry-0' };
    expect(appHistoryResultV1Schema.safeParse(page).success).toBe(true);
    expect(appMessageV1Schema.safeParse({ ...row, parts: [{ type: 'operation', operation_id: 'op', state: 'running', message: 'Working' }] }).success).toBe(true);
    expect(appMessageV1Schema.safeParse({ ...row, parts: [{ type: 'artifact', artifact_id: 'a', revision: 1, title: 'Plan', download_path: '/x' }] }).success).toBe(true);
  });

  it('accepts the new reply part types alongside plain row text', () => {
    expect(appMessageV1Schema.safeParse({ ...row, parts: [row.parts[0], ...newParts] }).success).toBe(true);
  });

  it('requires fallback_text on every new part, keeps one artifact shape and carries no card part', () => {
    for (const part of newParts) {
      const { fallback_text: _dropped, ...bare } = part;
      expect(appMessageV1Schema.safeParse({ ...row, parts: [bare] }).success).toBe(false);
    }
    expect(appMessageV1Schema.safeParse({ ...row, parts: [{ type: 'artifact', artifact_id: 'art:1', revision: 1, fallback_text }] }).success).toBe(false);
    expect(appMessageV1Schema.safeParse({ ...row, parts: [{ type: 'ui_part', fallback_text }] }).success).toBe(false);
    const card = { type: 'card', card: { kind: 'brief_card', card_id: 'card-1', data: { source_refs: ['src-1'], variant: 'morning' } }, fallback_text };
    expect(appMessageV1Schema.safeParse({ ...row, parts: [card] }).success).toBe(false);
  });

  it('carries visibility as an optional closed field and keeps text required', () => {
    expect(appMessageV1Schema.safeParse({ ...row, visibility: 'shared' }).success).toBe(true);
    expect(appMessageV1Schema.safeParse({ ...row, visibility: 'app_only' }).success).toBe(true);
    expect(appMessageV1Schema.safeParse({ ...row, visibility: 'public' }).success).toBe(false);
    const { text: _text, ...textless } = row;
    expect(appMessageV1Schema.safeParse(textless).success).toBe(false);
    expect(appMessageV1Schema.safeParse({ ...row, surface: 'app' }).success).toBe(false);
  });
});

describe('app problem envelope', () => {
  it('parses every error body the app routes emit today', () => {
    const today = [
      { error: 'unavailable' }, { error: 'conflict' }, { error: 'capacity' }, { error: 'method_not_allowed' },
      { error: 'invalid_query' }, { error: 'invalid_action' }, { error: 'request_id_required' }, { error: 'request_reused' },
      { error: 'not_found' }, { error: 'receipt_not_found' }, { error: 'receipt_unavailable' }, { error: 'projection_unavailable' },
      { error: 'receipt_capacity', message: 'This session has reached its change limit. Sign in again after this session expires; existing receipts remain available.' },
      { error: 'stale_read', message: 'These records changed. Refresh and review again before applying a change.' },
      { error: 'no_longer_eligible', message: 'This action is no longer available. Refresh the records.' },
    ];
    for (const body of today) expect(appProblemV1Schema.safeParse(body).success).toBe(true);
  });

  it('adds an optional closed code to non-generic errors only', () => {
    expect(appErrorCodeV1Schema.options).toEqual(['client_message_id_reused', 'inbox_full', 'request_reused', 'stale_read', 'no_longer_eligible', 'receipt_capacity', 'step_up_required']);
    expect(appProblemV1Schema.safeParse({ error: 'conflict', code: 'client_message_id_reused' }).success).toBe(true);
    expect(appProblemV1Schema.safeParse({ error: 'step_up_required', code: 'step_up_required' }).success).toBe(true);
    expect(appProblemV1Schema.safeParse({ error: 'stale_read', code: 'stale_read', message: 'Refresh.' }).success).toBe(true);
    expect(appProblemV1Schema.safeParse({ error: 'unavailable', code: 'inbox_full' }).success).toBe(false);
    expect(appProblemV1Schema.safeParse({ error: 'conflict', code: 'approval_superseded' }).success).toBe(false);
    expect(appProblemV1Schema.safeParse({ error: 'conflict', detail: 'stack' }).success).toBe(false);
  });
});

describe('app sign-in requests', () => {
  const requests = [[appCodeRequestSchema, { email: 'new@example.test' }], [appVerifyRequestV1Schema, { email: 'new@example.test', code: '123456' }]] as const;

  it('accept an optional 20-character invite code from the console invite alphabet', () => {
    for (const [schema, body] of requests) {
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.safeParse({ ...body, invite: 'ABCDEFGHJKMNPQRSTUVW' }).success).toBe(true);
      expect(schema.safeParse({ ...body, invite: 'XYZ23456789ABCDEFGHJ' }).success).toBe(true);
    }
  });

  it('verify accepts an optional phone in E.164, the number a new member joins with; nothing else is a phone', () => {
    const body = { email: 'new@example.test', code: '123456', invite: 'ABCDEFGHJKMNPQRSTUVW' };
    expect(appVerifyRequestV1Schema.safeParse({ ...body, phone: '+919876543210' }).success).toBe(true);
    for (const phone of ['919876543210', '+91 98765 43210', '+0123456789', '+123456', '+1234567890123456', '', null, 9198765432])
      expect({ phone, ok: appVerifyRequestV1Schema.safeParse({ ...body, phone }).success }).toEqual({ phone, ok: false });
    expect(appCodeRequestSchema.safeParse({ email: 'new@example.test', phone: '+919876543210' }).success).toBe(false);
  });

  it('refuse an invite code outside that alphabet or length; the app upper-cases and trims before sending', () => {
    for (const [schema, body] of requests)
      for (const invite of ['abcdefghjkmnpqrstuvw', 'ABCDEFGHJKMNPQRSTUV', 'ABCDEFGHJKMNPQRSTUVWX', 'IBCDEFGHJKMNPQRSTUVW', 'OBCDEFGHJKMNPQRSTUVW', '0BCDEFGHJKMNPQRSTUVW', '1BCDEFGHJKMNPQRSTUVW', ' ABCDEFGHJKMNPQRSTUVW', '', null])
        expect({ invite, ok: schema.safeParse({ ...body, invite }).success }).toEqual({ invite, ok: false });
  });
});

describe('app sign-in with an Apple or Google identity token', () => {
  const apple = { provider: 'apple', id_token: 'fixture-header.fixture-payload.fixture-signature', nonce: 'raw-nonce-0123456789abcdef', request_id: 'signin-0001' } as const;
  const google = { provider: 'google', id_token: 'fixture-header.fixture-payload.fixture-signature', nonce: 'raw-nonce-0123456789abcdef', request_id: 'signin-0002' } as const;

  it('accepts the fixture requests and answers, and adds the route without touching /auth/verify', async () => {
    const fixture = (await import('./fixtures/app-auth-id-token.v1.json')).default;
    for (const request of fixture.requests) expect(appIdTokenRequestV1Schema.safeParse(request).success).toBe(true);
    for (const response of fixture.responses) expect(appIdTokenResultV1Schema.safeParse(response).success).toBe(true);
    for (const refusal of fixture.refusals) expect(appProblemV1Schema.safeParse(refusal.body).success && refusal.body.error === 'unavailable').toBe(true);
    for (const response of fixture.responses) expect(appVerifyResultV1Schema.safeParse(response).success).toBe(response.state !== 'confirm_with_email_code');
    const route = appCoreRoutesV1.find(entry => entry.path === '/app/v1/auth/id_token');
    expect(route).toMatchObject({ method: 'POST', request: appIdTokenRequestV1Schema, response: appIdTokenResultV1Schema, authenticated: false, success_status: 200 });
  });

  it('takes an invite and an E.164 phone exactly as /auth/verify does', () => {
    expect(appIdTokenRequestV1Schema.safeParse({ ...google, invite: 'ABCDEFGHJKMNPQRSTUVW', phone: '+919876543210' }).success).toBe(true);
    for (const invalid of [{ ...google, invite: 'abcdefghjkmnpqrstuvw' }, { ...google, phone: '919876543210' }, { ...apple, phone: '' }])
      expect(appIdTokenRequestV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('takes Apple\'s one-time authorization code from Apple only', () => {
    const code = 'c0ffee0123456789abcdef.0.fixture.code-value_01';
    expect(appIdTokenRequestV1Schema.safeParse({ ...apple, authorization_code: code }).success).toBe(true);
    for (const invalid of [{ ...google, authorization_code: code }, { ...apple, authorization_code: 'short' }, { ...apple, authorization_code: 'has spaces in the code value' }, { ...apple, authorization_code: 'c'.repeat(1025) }])
      expect(appIdTokenRequestV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('requires a nonce from both providers', () => {
    for (const request of [apple, google]) {
      const { nonce: _nonce, ...bare } = request;
      expect(appIdTokenRequestV1Schema.safeParse(bare).success).toBe(false);
      expect(appIdTokenRequestV1Schema.safeParse(request).success).toBe(true);
    }
  });

  it('answers a new identity on an existing owner with an email-code confirm whose link /auth/verify takes back', () => {
    const confirm = { state: 'confirm_with_email_code', email: 'member@example.test', link: 'sealed-fixture-payload.0123456789abcdef' };
    expect(appIdTokenResultV1Schema.safeParse(confirm).success).toBe(true);
    for (const invalid of [{ ...confirm, link: undefined }, { ...confirm, email: 'not-an-email' }, { ...confirm, credential: 'x'.repeat(20) }])
      expect(appIdTokenResultV1Schema.safeParse(invalid).success).toBe(false);
    const verify = { email: 'member@example.test', code: '123456' };
    expect(appVerifyRequestV1Schema.safeParse({ ...verify, link: confirm.link }).success).toBe(true);
    expect(appVerifyRequestV1Schema.safeParse({ ...verify, link: 'short' }).success).toBe(false);
    expect(appVerifyResultV1Schema.safeParse(confirm).success).toBe(false);
  });

  it('refuses another provider, a token that is not a compact JWT, an unsafe nonce, a bad request id and unknown keys', () => {
    for (const invalid of [
      { ...google, provider: 'facebook' }, { ...google, provider: 'Apple' }, { ...google, id_token: 'not-a-jwt' }, { ...google, id_token: 'a.b.c.d' },
      { ...google, id_token: `a.${'b'.repeat(8192)}.c` }, { ...google, id_token: 'a b.c.d' }, { ...apple, nonce: 'short' }, { ...apple, nonce: 'has spaces in the nonce value' },
      { ...apple, nonce: 'n'.repeat(129) }, { ...google, request_id: 'short' }, { ...google, request_id: undefined }, { ...google, email: 'someone@example.test' },
      { ...google, client_id: 'web-client' }, { ...google, issuer: 'https://accounts.google.com' },
    ]) expect({ invalid, ok: appIdTokenRequestV1Schema.safeParse(invalid).success }).toEqual({ invalid, ok: false });
  });
});

describe('message times, cancel and ratings', () => {
  const message = { id: 'entry-1-reply', role: 'assistant', text: 'Done.', parts: [{ type: 'text', text: 'Done.' }], channel: 'app', parent_id: 'entry-1' };
  it('carries an optional stored time on history rows', () => {
    for (const valid of [message, { ...message, created_at: 1_791_700_000_000 }, { ...message, created_at: 0 }]) expect(appMessageV1Schema.safeParse(valid).success).toBe(true);
    for (const invalid of [{ ...message, created_at: -1 }, { ...message, created_at: 1.5 }, { ...message, created_at: '2026-10-11T07:30:00Z' }, { ...message, created_at: null }])
      expect(appMessageV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('rates with up, down or null, by request id', () => {
    for (const rating of ['up', 'down', null]) expect(appRatingRequestV1Schema.safeParse({ request_id: 'rating-0001', rating }).success).toBe(true);
    expect(appRatingResultV1Schema.safeParse({ request_id: 'rating-0001', message_id: 'entry-1-reply', rating: 'up' }).success).toBe(true);
    for (const invalid of [{ request_id: 'rating-0001', rating: 'meh' }, { request_id: 'short', rating: 'up' }, { request_id: 'rating-0001' }, { request_id: 'rating-0001', rating: 'up', note: 'x' }])
      expect(appRatingRequestV1Schema.safeParse(invalid).success).toBe(false);
    for (const invalid of [{ request_id: 'rating-0001', message_id: '', rating: 'up' }, { request_id: 'rating-0001', message_id: 'x'.repeat(257), rating: null }, { request_id: 'rating-0001', message_id: 'entry-1', rating: 'up', recorded: true }])
      expect(appRatingResultV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('adds the main cancel and rating routes and leaves the receipt and send result unchanged', () => {
    const routes = appCoreRoutesV1.map(route => `${route.method} ${route.path}`);
    expect(routes).toContain('POST /app/v1/chat/main/messages/{client_message_id}/cancel');
    expect(routes).toContain('PUT /app/v1/chat/main/messages/{message_id}/rating');
    expect(appMessageReceiptV1Schema.safeParse({ accepted: true, message_id: 'm', state: 'completed', closed_reason: 'cancelled', effects_unconfirmed: true }).success).toBe(true);
    expect(appMessageReceiptV1Schema.safeParse({ accepted: true, message_id: 'm', state: 'completed', steps: [] }).success).toBe(false);
  });
});

describe('chat revision 2: the reply draft on a running receipt', () => {
  const running = { accepted: true, message_id: 'm', state: 'running' } as const;
  it('is declared by chat=2 and absent from revision 1', () => {
    expect(APP_CHAT_DRAFT_REVISION).toBe(2);
    expect(appContractRevision('chat=2', 'chat')).toBe(APP_CHAT_DRAFT_REVISION);
    for (const header of [null, 'chat=1', 'approvals=2']) expect(appContractRevision(header, 'chat')).toBeLessThan(APP_CHAT_DRAFT_REVISION);
  });

  it('accepts a non-empty draft up to the reply text bound', () => {
    for (const draft of ['Here is the plan', 'x'.repeat(REPLY_TEXT_MAX_CHARS)]) expect(appMessageReceiptV1Schema.safeParse({ ...running, draft }).success).toBe(true);
    expect(appMessageReceiptV1Schema.safeParse(running).success).toBe(true);
  });

  it('rejects an empty, oversized or non-string draft', () => {
    for (const draft of ['', 'x'.repeat(REPLY_TEXT_MAX_CHARS + 1), 42, null, ['Here']]) expect([draft, appMessageReceiptV1Schema.safeParse({ ...running, draft }).success]).toEqual([draft, false]);
  });
});

describe('chat revision 3: what a running turn is doing, on its receipt', () => {
  const running = { accepted: true, message_id: 'm', state: 'running' } as const;
  it('is declared by chat=3, which still reads the draft, and absent from revision 2, older and unparsed headers', () => {
    expect(APP_CHAT_ACTIVITY_REVISION).toBe(3);
    expect(appContractRevision('chat=3', 'chat')).toBe(APP_CHAT_ACTIVITY_REVISION);
    expect(appContractRevision('approvals=3,chat=3', 'chat')).toBeGreaterThanOrEqual(APP_CHAT_DRAFT_REVISION);
    for (const header of [null, 'chat=1', 'chat=2', 'approvals=3', 'chat=three', 'chat=3,chat=3', 'chat=03', 'chat=3;x'])
      expect([header, appContractRevision(header, 'chat') < APP_CHAT_ACTIVITY_REVISION]).toEqual([header, true]);
  });

  it('accepts each kind of the closed vocabulary with the time it began, beside a draft or alone', () => {
    expect(APP_CHAT_ACTIVITY_KINDS).toContain('mail');
    expect(APP_CHAT_ACTIVITY_KINDS).toContain('working');
    for (const kind of APP_CHAT_ACTIVITY_KINDS) expect(appMessageReceiptV1Schema.safeParse({ ...running, activity: { kind, since: 1_761_400_000_000 } }).success).toBe(true);
    expect(appMessageReceiptV1Schema.safeParse({ ...running, draft: 'Here', activity: { kind: 'mail', since: 0 } }).success).toBe(true);
    expect(appMessageReceiptV1Schema.safeParse(running).success).toBe(true);
  });

  it('rejects an unknown kind, free text, an extra key, a bad time or a bare string', () => {
    for (const activity of [
      { kind: 'gmail', since: 1 }, { kind: 'Searching alice@example.com', since: 1 }, { kind: 'mail', since: 1, tool: 'search_communication' },
      { kind: 'mail', since: -1 }, { kind: 'mail', since: 1.5 }, { kind: 'mail' }, { since: 1 }, 'mail', null,
    ]) expect([activity, appMessageReceiptV1Schema.safeParse({ ...running, activity }).success]).toEqual([activity, false]);
  });
});

describe('the contract revisions a build declares', () => {
  it('reads distinct name=revision pairs, keeping names this backend does not know', () => {
    expect(APP_CONTRACT_HEADER).toBe('x-waldo-app-contract');
    expect(appContractHeaderV1Schema.parse('approvals=2')).toEqual({ approvals: 2 });
    expect(appContractHeaderV1Schema.parse('approvals=2,threads_v=13')).toEqual({ approvals: 2, threads_v: 13 });
  });

  it('rejects a value that is not distinct name=revision pairs', () => {
    for (const value of ['', 'approvals', 'approvals=0', 'approvals=02', 'approvals=10000', 'Approvals=2', 'approvals=2,approvals=3', 'approvals=2, threads=1', 'approvals=2,', '__proto__=1', 'x'.repeat(513)]) {
      expect([value, appContractHeaderV1Schema.safeParse(value).success]).toEqual([value, false]);
    }
  });

  it('reads revision 1 when the header is absent, malformed or leaves the contract out', () => {
    expect(appContractRevision('approvals=2', 'approvals')).toBe(2);
    for (const header of [null, undefined, 'approvals=x', 'threads=4']) expect([header, appContractRevision(header, 'approvals')]).toEqual([header, 1]);
  });
});

describe('chat revision 6: a history row carries its rating', () => {
  it('is revision 6', () => expect(APP_CHAT_RATING_REVISION).toBe(6));
  it('parses a reply rated up or down, and a row without one', () => {
    expect(appMessageV1Schema.safeParse({ ...row, rating: 'up' }).success).toBe(true);
    expect(appMessageV1Schema.safeParse({ ...row, rating: 'down' }).success).toBe(true);
    expect(appMessageV1Schema.safeParse(row).success).toBe(true);
  });
  it('refuses any other rating, and a cleared rating as null (an unrated row leaves the key out)', () => {
    for (const rating of ['sideways', '', null, 1]) expect(appMessageV1Schema.safeParse({ ...row, rating }).success).toBe(false);
  });
});
