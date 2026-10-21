import { describe, expect, it } from 'vitest';
import { APP_CONTRACT_HEADER, appCodeRequestSchema, appContractHeaderV1Schema, appContractRevision, appCoreRoutesV1, appErrorCodeV1Schema, appHistoryResultV1Schema, appMessageReceiptV1Schema, appMessageV1Schema, appProblemV1Schema, appRatingRequestV1Schema, appRatingResultV1Schema, appVerifyRequestV1Schema } from './core';

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
    expect(appErrorCodeV1Schema.options).toEqual(['client_message_id_reused', 'inbox_full', 'request_reused', 'stale_read', 'no_longer_eligible', 'receipt_capacity']);
    expect(appProblemV1Schema.safeParse({ error: 'conflict', code: 'client_message_id_reused' }).success).toBe(true);
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

  it('refuse an invite code outside that alphabet or length; the app upper-cases and trims before sending', () => {
    for (const [schema, body] of requests)
      for (const invite of ['abcdefghjkmnpqrstuvw', 'ABCDEFGHJKMNPQRSTUV', 'ABCDEFGHJKMNPQRSTUVWX', 'IBCDEFGHJKMNPQRSTUVW', 'OBCDEFGHJKMNPQRSTUVW', '0BCDEFGHJKMNPQRSTUVW', '1BCDEFGHJKMNPQRSTUVW', ' ABCDEFGHJKMNPQRSTUVW', '', null])
        expect({ invite, ok: schema.safeParse({ ...body, invite }).success }).toEqual({ invite, ok: false });
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
