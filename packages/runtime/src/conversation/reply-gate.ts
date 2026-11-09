import { sanitiseResultSchema, type SanitiseInput, type SanitiseResult } from '@waldo/contracts';
import { guardArtifactLinks } from './artifact-link-guard';
import { redactSecretUrls } from '../channels/egress-guard';
import { holdsIn } from '../memory/forget-guard';
import type { LLMGatewayAdapter } from '../llm/provider';
import type { ReplyCheck, ReplyStream } from './reply-stream';

// How far behind the newest token released text stays: longer than any span a delivery rewrite matches (a postal address,
// a phone number, a key=value secret, a health reading), so a match still being written cannot start inside it.
export const RELEASE_HOLD_BACK = 256;

type Sanitise = (input: SanitiseInput) => SanitiseResult | Promise<SanitiseResult>;

// Every deterministic rewrite between the model's final text and the owner, applied to the text so far:
// - PostLLMCall: canary_leak_check and scribe_sanitise at owner_reply (hooks/registry.ts);
// - the tool loop's artifact-link guard (no receipt is known here, so any artifact link stops the stream);
// - the turn's held and forgotten topics (owner-turn's converse redaction and held-topic filters);
// - secret-URL redaction (listener, final outbox, egress caller);
// - an armoured key block, which the scribe redacts whole only once its end marker arrives.
export const replyGate = (input: Readonly<{ sanitise?: Sanitise; canaries: readonly string[]; topics: readonly string[] }>): ReplyCheck => {
  const held = holdsIn(input.topics);
  const longest = input.topics.reduce((most, topic) => Math.max(most, topic.length), 0);
  const holdBack = Math.max(RELEASE_HOLD_BACK, longest * 4);
  return async (text) => {
    const lower = text.toLowerCase();
    if (input.canaries.some((token) => lower.includes(token.toLowerCase()))) return { ok: false, reason: 'canary' };
    if (text.includes('-----BEGIN')) return { ok: false, reason: 'armoured_block' };
    if (guardArtifactLinks(text, new Set()) !== text) return { ok: false, reason: 'artifact_link' };
    if (redactSecretUrls(text).count > 0) return { ok: false, reason: 'secret_url' };
    if (held(text)) return { ok: false, reason: 'held_topic' };
    if (!input.sanitise) return { ok: false, reason: 'no_sanitiser' };
    let result: SanitiseResult;
    try {
      result = sanitiseResultSchema.parse(await input.sanitise({ payload: { text }, destination: 'owner_reply', source_taint: null, canary_tokens: [...input.canaries] }));
    } catch {
      return { ok: false, reason: 'scribe_denied' };
    }
    if (!result.ok || result.source_taint !== null) return { ok: false, reason: 'scribe_denied' };
    const payload = result.payload as { text?: unknown } | null;
    return payload !== null && typeof payload === 'object' && payload.text === text ? { ok: true, holdBack } : { ok: false, reason: 'scribe_rewrite' };
  };
};

// A gateway whose final-answer text feeds the turn's reply stream. Each call begins afresh; a failed call, or one that
// called tools, withdraws what it showed, so a fallback's answer replaces it whole.
export const withReplyStream = (gateway: LLMGatewayAdapter, stream: ReplyStream | undefined, check: () => ReplyCheck): LLMGatewayAdapter => stream === undefined ? gateway : {
  complete: async (input) => {
    stream.begin(check());
    try {
      const result = await gateway.complete({ ...input, stream: stream.deltas });
      if (!result.ok || result.data.tool_calls?.length) stream.withdraw();
      return result;
    } catch (error) {
      stream.withdraw();
      throw error;
    }
  },
};
