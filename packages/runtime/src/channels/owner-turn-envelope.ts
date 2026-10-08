import type { RunEffectScope } from './run-effect-scope';
import { llmRequestSchema, type ToolName, type LLMAttachment } from '@waldo/contracts';
import type { TurnTimer } from './owner-turn-types';
import type { turnControl } from './turn-control';

// Auth and provider parsing happen in adapters. This is the admitted content
// boundary consumed by the conversation, memory and tool loop.
// Provider identifiers are opaque strings. Observed author metadata never proves
// owner authority, even when its value matches the admitted sender.
export type ReplyContext = Readonly<{
  surface: string;
  messageId: string;
  conversationRef: string | null;
  authorId: string | null;
  authorIsBot: boolean | null;
  text: string;
  truncated: boolean;
  sourceTaint: 'external';
  // Transport-observed provenance, shown to the model as context. 'owner' and 'waldo' are set only for a
  // non-forwarded reply whose Telegram sender is the owner or the bot; anything else is 'other'.
  provenance?: Readonly<{ author: 'owner' | 'waldo' | 'other'; forwarded: boolean }>;
}>;
export const REPLY_QUOTE_LIMIT = 2048;

export type OwnerTurnEnvelope = Readonly<{
  traceId: string;
  conversationRef: string;
  surface: string;
  presentation?: import('../prompt/messaging-behavior').SurfacePresentation;
  text: string;
  // Host-parsed source markup; these ranges never supply task-transition evidence.
  sourceQuoteRanges?: readonly Readonly<{ start: number; end: number }>[];
  mediaNote?: string;
  replyTo?: ReplyContext;
  attachment?: LLMAttachment;
  attachments?: readonly LLMAttachment[];
  attachmentRefs?: readonly Readonly<{ reference: string; sourceMessageId: string; filename: string; mimeType: string; byteLength: number; sha256: string; caption?: string; kind: string; nativeVoice: boolean }>[];
  messageRef?: Readonly<{ id: string; conversationRef: string; bridgeRef?: string; accountRef?: string; partIndex?: number; threadOriginatorId?: string }>;
  service?: string;
  // Set by the channel host. When false, this turn skips its immediate memory write. Nightly consolidation and history indexing are separate and unaffected.
  memoryWrites?: boolean;
  runScope?: RunEffectScope;
}>;
export type OwnerResponder = Readonly<{
  respond(turn: OwnerTurnEnvelope, time: TurnTimer): Promise<string>;
  chooseReaction(turn: OwnerTurnEnvelope): Promise<string | null>;
  remind(id: string, conversationRef: string, note: string, time: TurnTimer, surface?: string): Promise<string>;
  prompt(id: string, conversationRef: string, said: string, time: TurnTimer, surface?: string, toolNames?: readonly ToolName[], current?: () => Promise<void>, decision?: Readonly<{ name: string; schema: Record<string, unknown> }>): Promise<string>;
  consolidate(trace: string, day: string, sides?: { owner: string; waldo: string }): Promise<string>;
  migrate(trace: string, input: string): Promise<string>;
  promote(trace: string): Promise<string>;
  planDay(trace: string, input: string): Promise<string>;
  control: ReturnType<typeof turnControl>;
}>;

// Host-selected surface, never inferred from owner text or transport payload.
export const ownerTurnTrace = (surface: string, updateId: number): string => surface === 'telegram' ? `tg-${updateId}` : `${surface}-${updateId}`;

export const ownerTurnAttachments = (turn: OwnerTurnEnvelope): readonly LLMAttachment[] | undefined => {
  if (turn.attachment !== undefined && turn.attachments !== undefined) throw new Error('ambiguous turn media');
  const attachments = turn.attachments ?? (turn.attachment ? [turn.attachment] : undefined);
  if (!attachments?.length) return undefined;
  return llmRequestSchema.shape.attachments.parse([...attachments]);
};
