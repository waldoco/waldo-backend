import { describe, expect, it } from 'vitest';
import * as appParts from '../app/parts';
import { waldoCardSchema } from '../ui/card';
import {
  approvalActionV1Schema,
  approvalKindV1Schema,
  QUICK_REPLY_LABEL_MAX_CHARS,
  QUICK_REPLY_MAX_CHOICES,
  REPLY_FALLBACK_MAX_CHARS,
  REPLY_TEXT_MAX_CHARS,
  replyCardPartV1Schema,
  replyEnvelopeV1Schema,
  replyPartV1Schema,
} from './reply-parts';
import * as runtimeParts from './reply-parts';

const digest = `sha256:${'a'.repeat(64)}`;
const fallback_text = 'Open Waldo to see this.';
const parts = {
  text: { type: 'text', text: 'Moved your 3pm to 4pm.' },
  card: { type: 'card', card: { kind: 'context_card', card_id: 'card-01', data: { source_refs: ['src-1'] } }, fallback_text },
  approval: {
    type: 'approval', approval_id: 'p1234abcd', kind: 'calendar_change',
    review: 'Move "Design review" to Fri 11 Oct, 16:00 to 17:00. You asked to push it back.',
    payload_digest: digest, actions: ['approve', 'edit', 'skip'], expires_at: 1_760_000_000_000, fallback_text,
  },
  quick_replies: { type: 'quick_replies', choices: [{ id: 'later', label: 'Later today' }, { id: 'tomorrow', label: 'Tomorrow' }], fallback_text },
  chart_series: {
    type: 'chart_series', title: 'Meetings per day', unit: 'meetings',
    series: [{ label: 'This week', points: [{ t: 1_760_000_000_000, v: 4 }, { t: 1_760_086_400_000, v: 6 }] }],
    alt_text: 'Meetings rose from 4 to 6 between Monday and Tuesday.', fallback_text,
  },
  file: { type: 'file', file_ref: 'file:7f3a', name: 'agenda.pdf', mime: 'application/pdf', bytes: 20480, sha256: 'b'.repeat(64), fallback_text },
  artifact: { type: 'artifact', artifact_id: 'art:plan-01', revision: 2, fallback_text },
  voice: { type: 'voice', audio_ref: 'audio:91c2', transcript: 'Your 4pm is confirmed.', fallback_text },
} as const;
const envelope = {
  reply_id: 'reply-0001', principal_ref: `prn_${'c'.repeat(32)}`, conversation_ref: 'owner:main',
  origin: 'turn', visibility: 'shared', custody: 'durable', parts: [parts.text],
} as const;

describe('replyPartV1', () => {
  it('reuses the app leaf schemas, so app and runtime share one representation', () => {
    for (const name of ['approvalIdV1Schema', 'approvalKindV1Schema', 'approvalActionV1Schema', 'payloadDigestV1Schema', 'replyVisibilityV1Schema',
      'replyApprovalPartV1Schema', 'replyQuickRepliesPartV1Schema', 'replyChartSeriesPartV1Schema', 'replyFilePartV1Schema', 'replyVoicePartV1Schema'] as const) {
      expect(runtimeParts[name]).toBe(appParts[name]);
    }
    expect(runtimeParts.REPLY_FALLBACK_MAX_CHARS).toBe(appParts.REPLY_FALLBACK_MAX_CHARS);
  });

  it('accepts one instance of every part type and nothing named ui_part', () => {
    for (const part of Object.values(parts)) expect(replyPartV1Schema.safeParse(part).success).toBe(true);
    expect(replyPartV1Schema.safeParse({ type: 'ui_part', component: 'Chart', props: {}, fallback_text }).success).toBe(false);
  });

  it('requires fallback_text on every non-text part, and it must fit one messaging-surface message', () => {
    for (const [type, part] of Object.entries(parts)) {
      if (type === 'text') continue;
      const { fallback_text: _dropped, ...bare } = part as Record<string, unknown>;
      expect(replyPartV1Schema.safeParse(bare).success).toBe(false);
      expect(replyPartV1Schema.safeParse({ ...part, fallback_text: '   ' }).success).toBe(false);
      expect(replyPartV1Schema.safeParse({ ...part, fallback_text: 'x'.repeat(REPLY_FALLBACK_MAX_CHARS + 1) }).success).toBe(false);
    }
  });

  it('is strict: an extra key on any part fails', () => {
    for (const part of Object.values(parts)) expect(replyPartV1Schema.safeParse({ ...part, owner: 'foreign' }).success).toBe(false);
  });

  it('bounds text and rejects blank text', () => {
    expect(replyPartV1Schema.safeParse({ type: 'text', text: 'x'.repeat(REPLY_TEXT_MAX_CHARS) }).success).toBe(true);
    expect(replyPartV1Schema.safeParse({ type: 'text', text: 'x'.repeat(REPLY_TEXT_MAX_CHARS + 1) }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ type: 'text', text: ' \n ' }).success).toBe(false);
  });

  it('carries the shared card contract unchanged', () => {
    expect(replyCardPartV1Schema.shape.card).toBe(waldoCardSchema);
    expect(replyPartV1Schema.safeParse({ ...parts.card, card: { kind: 'sleep', card_id: 'c', data: { source_refs: [] } } }).success).toBe(false);
  });

  it('approval parts name a desk kind, an exact digest, and only the desk decisions offered before an effect', () => {
    expect(approvalKindV1Schema.options).toEqual(['calendar_change', 'email_send', 'message_send', 'browser_submit', 'mcp_call', 'google_task_change']);
    expect(approvalActionV1Schema.options).toEqual(['approve', 'skip', 'edit', 'undo']);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, actions: ['skip'] }).success).toBe(true);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, actions: ['undo'] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, actions: [] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, actions: ['approve', 'approve'] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, kind: 'task_sources' }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, payload_digest: 'a'.repeat(64) }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, review: '' }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, expires_at: -1 }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.approval, expires_at: 1_760_000_000 }).success).toBe(false);
  });

  it('bounds quick replies: 1..10 unique ids, labels short enough for every surface', () => {
    const choices = Array.from({ length: QUICK_REPLY_MAX_CHOICES }, (_, i) => ({ id: `c${i}`, label: `Option ${i}` }));
    expect(replyPartV1Schema.safeParse({ ...parts.quick_replies, choices }).success).toBe(true);
    expect(replyPartV1Schema.safeParse({ ...parts.quick_replies, choices: [...choices, { id: 'extra', label: 'Extra' }] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.quick_replies, choices: [] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.quick_replies, choices: [{ id: 'a', label: 'One' }, { id: 'a', label: 'Two' }] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.quick_replies, choices: [{ id: 'a', label: 'x'.repeat(QUICK_REPLY_LABEL_MAX_CHARS + 1) }] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.quick_replies, choices: [{ id: 'has space', label: 'Ok' }] }).success).toBe(false);
  });

  it('bounds chart series and rejects non-finite values', () => {
    const series = [{ label: 'A', points: [{ t: 0, v: Number.POSITIVE_INFINITY }] }];
    expect(replyPartV1Schema.safeParse({ ...parts.chart_series, series }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.chart_series, series: [] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.chart_series, series: Array.from({ length: 9 }, () => parts.chart_series.series[0]) }).success).toBe(false);
    const tooMany = Array.from({ length: 501 }, (_, t) => ({ t, v: 1 }));
    expect(replyPartV1Schema.safeParse({ ...parts.chart_series, series: [{ label: 'A', points: tooMany }] }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.chart_series, alt_text: '' }).success).toBe(false);
  });

  it('files carry a content hash and a canonical mime type', () => {
    expect(replyPartV1Schema.safeParse({ ...parts.file, sha256: `sha256:${'b'.repeat(64)}` }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.file, mime: 'pdf' }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.file, bytes: -1 }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.file, file_ref: 'https://evil.example/x' }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.artifact, revision: 0 }).success).toBe(false);
    expect(replyPartV1Schema.safeParse({ ...parts.voice, transcript: '' }).success).toBe(false);
  });
});

describe('replyEnvelopeV1', () => {
  it('accepts a turn reply and a proactive app-only health reply', () => {
    expect(replyEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
    expect(replyEnvelopeV1Schema.safeParse({
      ...envelope, origin: 'proactive', visibility: 'app_only', custody: 'volatile_owner_health', urgency: 'high',
      anchor_entry_id: 'entry-42', parts: [parts.text, parts.chart_series],
    }).success).toBe(true);
  });

  it('needs at least one part, a scoped principal and closed routing vocabularies', () => {
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, parts: [] }).success).toBe(false);
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, parts: Array.from({ length: 17 }, () => parts.text) }).success).toBe(false);
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, principal_ref: 'telegram-12345' }).success).toBe(false);
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, visibility: 'public' }).success).toBe(false);
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, custody: 'journal' }).success).toBe(false);
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, origin: 'mirror' }).success).toBe(false);
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, urgency: 'urgent' }).success).toBe(false);
    expect(replyEnvelopeV1Schema.safeParse({ ...envelope, surface: 'telegram' }).success).toBe(false);
  });
});
