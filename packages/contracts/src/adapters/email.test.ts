// Owning ADR: ADR-0027 (EmailProvider drafts extension); the ADR-0018 always-confirm rule and
// ADR-0024 Scribe sanitisation ride it.
// Invariants under test: the two-provider tuple; EmailDraft is a body-free reference
// (strictObject makes a body key unparseable); create_draft requires the 5-min-bucket
// idempotency key; send_draft requires the user confirmation token (drafts-only semantics —
// no autonomous send at any autonomy level); the metadata summary is aggregate-only; the DO
// drafts row stores recipient_count and never recipients or body; every runtime boundary
// parses as the core/error AdapterResult envelope with success under the data key.
// Failure modes caught: a body field smuggled into the persisted draft reference or the DO
// row, a send path that no longer demands the confirmation token, dedup/token-TTL constant
// drift from the ADR-pinned values, recipient addresses leaking into the runtime row, and
// envelope drift (success without data, error without a coded cause).
import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../core/error';
import type { CreateDraftArgs, CreateDraftData, EmailProvider, SendDraftArgs } from './email';
import {
  createDraftArgsSchema,
  createDraftResultSchema,
  deleteDraftResultSchema,
  EMAIL_DRAFT_POLICY,
  emailDraftPolicySchema,
  emailDraftRecordSchema,
  emailDraftSchema,
  emailMetadataArgsSchema,
  emailMetadataSummarySchema,
  emailProviderNameSchema,
  listDraftsArgsSchema,
  sendDraftArgsSchema,
  sendDraftResultSchema,
} from './email';

const key = 'b'.repeat(64);

const minimalDraft = {
  draft_id: 'r-123abc',
  subject: 'Boundary for Thursday',
  to: ['sam@example.com'],
  created_at: '2026-05-23T09:00:00Z',
};

const fullDraft = {
  ...minimalDraft,
  thread_id: 't-9',
  message_id: 'm-9',
  cc: ['lee@example.com'],
  bcc: ['self@example.com'],
  send_url: 'https://mail.google.com/mail/u/0/#drafts?compose=r-123abc',
};

const baseCreate = {
  to: ['sam@example.com'],
  subject: 'Boundary for Thursday',
  body_markdown: 'Keeping Thursday evening clear — can we move our sync?',
  idempotency_key: key,
};

const baseSummary = {
  message_count: 240,
  after_hours_ratio: 0.3,
  thread_depth_avg: 2.4,
  sender_domains: ['example.com'],
};

const baseRecord = {
  draft_id: 'r-123abc',
  provider: 'gmail',
  created_at: 1_748_000_000_000,
  sent_at: null,
  recipient_count: 1,
  idempotency_key: key,
};

describe('emailProviderName', () => {
  it('is exactly the two providers, in order', () => {
    expect(emailProviderNameSchema.options).toEqual(['gmail', 'outlook_graph']);
  });

  it('rejects an unknown provider', () => {
    expect(emailProviderNameSchema.safeParse('imap').success).toBe(false);
  });
});

describe('emailDraft — the body-free reference', () => {
  it('accepts a minimal draft and a draft with every optional field', () => {
    expect(emailDraftSchema.safeParse(minimalDraft).success).toBe(true);
    expect(emailDraftSchema.safeParse(fullDraft).success).toBe(true);
  });

  it('key set is exactly the contract fields, in order — no body key exists', () => {
    expect(Object.keys(emailDraftSchema.shape)).toEqual([
      'draft_id',
      'thread_id',
      'message_id',
      'subject',
      'to',
      'cc',
      'bcc',
      'created_at',
      'send_url',
    ]);
  });

  it('rejects a draft carrying a body or body_markdown field — the privacy wall is structural', () => {
    expect(emailDraftSchema.safeParse({ ...fullDraft, body: 'hello' }).success).toBe(false);
    expect(emailDraftSchema.safeParse({ ...fullDraft, body_markdown: 'hello' }).success).toBe(
      false,
    );
  });

  it('rejects an empty recipient list and an empty subject', () => {
    expect(emailDraftSchema.safeParse({ ...minimalDraft, to: [] }).success).toBe(false);
    expect(emailDraftSchema.safeParse({ ...minimalDraft, subject: '' }).success).toBe(false);
  });

  it('rejects a non-ISO8601 created_at and a non-url send_url', () => {
    expect(emailDraftSchema.safeParse({ ...minimalDraft, created_at: 'today' }).success).toBe(
      false,
    );
    expect(emailDraftSchema.safeParse({ ...fullDraft, send_url: 'open drafts' }).success).toBe(
      false,
    );
  });
});

describe('emailDraftRecord — the DO drafts-table row', () => {
  it('column set is exactly the audit-safe residue: recipient_count, never recipients or body', () => {
    expect(Object.keys(emailDraftRecordSchema.shape)).toEqual([
      'draft_id',
      'provider',
      'created_at',
      'sent_at',
      'recipient_count',
      'idempotency_key',
    ]);
  });

  it('accepts an unsent row (sent_at null) and a sent row', () => {
    expect(emailDraftRecordSchema.safeParse(baseRecord).success).toBe(true);
    expect(
      emailDraftRecordSchema.safeParse({ ...baseRecord, sent_at: 1_748_000_300_000 }).success,
    ).toBe(true);
  });

  it('rejects a row carrying a recipient list or a body column', () => {
    expect(
      emailDraftRecordSchema.safeParse({ ...baseRecord, to: ['sam@example.com'] }).success,
    ).toBe(false);
    expect(emailDraftRecordSchema.safeParse({ ...baseRecord, body: 'hello' }).success).toBe(false);
  });

  it('rejects an ISO-string created_at — runtime rows carry epoch-ms ints', () => {
    expect(
      emailDraftRecordSchema.safeParse({ ...baseRecord, created_at: '2026-05-23T09:00:00Z' })
        .success,
    ).toBe(false);
  });
});

describe('emailMetadata', () => {
  it('args carry an ISO8601 date range; a non-ISO bound is rejected', () => {
    expect(
      emailMetadataArgsSchema.safeParse({
        date_range: { from: '2026-05-16T00:00:00Z', to: '2026-05-23T00:00:00Z' },
      }).success,
    ).toBe(true);
    expect(
      emailMetadataArgsSchema.safeParse({ date_range: { from: 'last week', to: 'now' } }).success,
    ).toBe(false);
  });

  it('summary is aggregate-only; a body-content field is rejected', () => {
    expect(emailMetadataSummarySchema.safeParse(baseSummary).success).toBe(true);
    expect(
      emailMetadataSummarySchema.safeParse({ ...baseSummary, body_preview: 'hello' }).success,
    ).toBe(false);
  });

  it('rejects an after_hours_ratio outside 0..1', () => {
    expect(
      emailMetadataSummarySchema.safeParse({ ...baseSummary, after_hours_ratio: 1.2 }).success,
    ).toBe(false);
  });
});

describe('createDraftArgs', () => {
  it('accepts a Scribe-sanitised draft request, with and without threading fields', () => {
    expect(createDraftArgsSchema.safeParse(baseCreate).success).toBe(true);
    expect(
      createDraftArgsSchema.safeParse({
        ...baseCreate,
        reply_to_thread_id: 't-9',
        in_reply_to_message_id: 'm-9',
      }).success,
    ).toBe(true);
  });

  it('rejects a create missing idempotency_key — undeduped draft creation is contract drift', () => {
    const unkeyed: Record<string, unknown> = { ...baseCreate };
    delete unkeyed['idempotency_key'];
    expect(createDraftArgsSchema.safeParse(unkeyed).success).toBe(false);
    // @ts-expect-error idempotency_key is required on every create (ADR-0027 dedup formula)
    const bad: CreateDraftArgs = { to: ['sam@example.com'], subject: 'x', body_markdown: 'y' };
    void bad;
  });

  it('rejects an empty recipient list', () => {
    expect(createDraftArgsSchema.safeParse({ ...baseCreate, to: [] }).success).toBe(false);
  });
});

describe('sendDraftArgs — the user-tap-only path', () => {
  it('accepts a draft_id with its confirmation token', () => {
    expect(
      sendDraftArgsSchema.safeParse({ draft_id: 'r-123abc', user_confirmation_token: 'hmac-tok' })
        .success,
    ).toBe(true);
  });

  it('rejects a send missing user_confirmation_token — no token, no send', () => {
    expect(sendDraftArgsSchema.safeParse({ draft_id: 'r-123abc' }).success).toBe(false);
    // @ts-expect-error the confirmation token is required: send is never a model-invocable path
    const bad: SendDraftArgs = { draft_id: 'r-123abc' };
    void bad;
  });
});

describe('listDraftsArgs', () => {
  it('accepts an optional positive limit and rejects a non-positive one', () => {
    expect(listDraftsArgsSchema.safeParse({}).success).toBe(true);
    expect(listDraftsArgsSchema.safeParse({ limit: 10 }).success).toBe(true);
    expect(listDraftsArgsSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('EMAIL_DRAFT_POLICY', () => {
  it('pins the ADR values: 5-min hash bucket, 24h dedup window, 5-min token TTL', () => {
    expect(emailDraftPolicySchema.safeParse(EMAIL_DRAFT_POLICY).success).toBe(true);
    expect(EMAIL_DRAFT_POLICY.hash_bucket_minutes).toBe(5);
    expect(EMAIL_DRAFT_POLICY.dedup_window_hours).toBe(24);
    expect(EMAIL_DRAFT_POLICY.confirmation_token_ttl_minutes).toBe(5);
  });
});

describe('adapter results — envelope conformance', () => {
  it('create_draft success parses and is the AdapterResult shape from core/error', () => {
    const result = createDraftResultSchema.parse({ ok: true, data: { draft: fullDraft } });
    // Statically pins the envelope: renaming the data key breaks this assignment.
    const typed: AdapterResult<CreateDraftData> = result;
    expect(typed.ok).toBe(true);
  });

  it('a coded failure parses; success without data does not', () => {
    expect(
      createDraftResultSchema.safeParse({
        ok: false,
        error: 'sanitisation failed',
        code: 'invalid_args',
      }).success,
    ).toBe(true);
    expect(createDraftResultSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it('rejects an error without a code and a code outside the seven-literal union', () => {
    expect(sendDraftResultSchema.safeParse({ ok: false, error: 'x' }).success).toBe(false);
    expect(
      sendDraftResultSchema.safeParse({ ok: false, error: 'x', code: 'token_expired' }).success,
    ).toBe(false);
  });

  it('delete_draft success carries the empty ack payload; send_draft returns a message_id', () => {
    expect(deleteDraftResultSchema.safeParse({ ok: true, data: {} }).success).toBe(true);
    expect(
      deleteDraftResultSchema.safeParse({ ok: true, data: { deleted: true } }).success,
    ).toBe(false);
    expect(
      sendDraftResultSchema.safeParse({ ok: true, data: { message_id: 'm-10' } }).success,
    ).toBe(true);
  });
});

describe('EmailProvider seam — fake provider', () => {
  it('is satisfiable by a pure fake; an expired token resolves a coded failure, never a send', async () => {
    const draft = emailDraftSchema.parse(fullDraft);
    const provider: EmailProvider = {
      provider: 'gmail',
      get_metadata: async () => ({ ok: true, data: { summary: baseSummary } }),
      create_draft: async () => ({ ok: true, data: { draft } }),
      list_drafts: async () => ({ ok: true, data: { drafts: [draft] } }),
      delete_draft: async () => ({ ok: true, data: {} }),
      send_draft: async () => ({
        ok: false,
        error: 'confirmation token expired',
        code: 'auth_failed',
      }),
    };
    const created = await provider.create_draft(createDraftArgsSchema.parse(baseCreate));
    expect(created).toEqual({ ok: true, data: { draft } });
    await expect(
      provider.send_draft({ draft_id: draft.draft_id, user_confirmation_token: 'stale-tok' }),
    ).resolves.toEqual({ ok: false, error: 'confirmation token expired', code: 'auth_failed' });
  });
});
