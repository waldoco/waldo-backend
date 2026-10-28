import type { RunEffectScope } from './run-effect-scope';
import type { InboundPart } from './owner-inbound-turn';
import { llmRequestSchema, type ToolName, type LLMAttachment } from '@waldo/contracts';
import type { TurnTimer } from './owner-turn-types';
import type { turnControl } from './turn-control';
import type { ReplyStream } from '../conversation/reply-stream';
import type { OwnerContextCapability } from '../context-composer/owner-turn';

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
  // The message as the surface received it, which admission compares with the admitted input.
  text: string;
  // Who wrote what: the message's own parts, then any the host added for its media (a note, a transcript).
  parts: readonly InboundPart[];
  replyTo?: ReplyContext;
  attachment?: LLMAttachment;
  attachments?: readonly LLMAttachment[];
  attachmentRefs?: readonly Readonly<{ reference: string; sourceMessageId: string; filename: string; mimeType: string; byteLength: number; sha256: string; caption?: string; kind: string; nativeVoice: boolean }>[];
  messageRef?: Readonly<{ id: string; conversationRef: string; bridgeRef?: string; accountRef?: string; partIndex?: number; threadOriginatorId?: string }>;
  service?: string;
  // Set by the channel host. When false, memory write tools are not admitted on this turn. Nightly consolidation and history indexing are separate and unaffected.
  memoryWrites?: boolean;
  runScope?: RunEffectScope;
  // Set by a channel that shows the reply while it is written; absent, the reply is delivered whole as before.
  replyStream?: ReplyStream;
}>;
export type OwnerResponder = Readonly<{
  respond(turn: OwnerTurnEnvelope, time: TurnTimer): Promise<string>;
  chooseReaction(turn: OwnerTurnEnvelope): Promise<string | null>;
  remind(id: string, conversationRef: string, note: string, time: TurnTimer, surface?: string): Promise<string>;
  // `turnContext` reaches the model with `said` on this turn only; it is never stored with the conversation.
  // `ownerModel` runs the job on the model the owner's own turn uses (still clamped past the spend ceiling): for a job that
  // answers the owner's own message late, never for one Waldo starts itself.
  prompt(id: string, conversationRef: string, said: string, time: TurnTimer, surface?: string, toolNames?: readonly ToolName[], current?: () => Promise<void>, decision?: Readonly<{ name: string; schema: Record<string, unknown> }>, turnContext?: string, sourceTaint?: 'external', ownerModel?: boolean): Promise<string>;
  // done is false when the conversation was not consolidated and must be offered again.
  // policy.health false keeps no health notes from this pass, or from the migration.
  consolidate(trace: string, day: string, sides?: Readonly<{ owner: string; shared: string; waldo: string; ownerMessages: readonly Readonly<{ ref: string; text: string }>[] }>, policy?: Readonly<{ health: boolean }>): Promise<Readonly<{ done: boolean; detail: string }>>;
  // The model's reply over the day's calendar and mail changes (outside content), applied by the caller. Absent on fakes.
  sourceClaims?(trace: string, updates: string, policy?: Readonly<{ health: boolean }>): Promise<string>;
  migrate(trace: string, input: string, policy?: Readonly<{ health: boolean }>): Promise<string>;
  // With a gate, promote makes no model call when the memory it would read has the digest `last`, and hands the digest of
  // the memory it leaves to `promoted` once a promotion is applied.
  promote(trace: string, gate?: Readonly<{ last: string | undefined; promoted(digest: string): void }>): Promise<string>;
  // One welcome-build stage's structured answer; its input and output never reach a trace.
  welcome?(trace: string, stage: string, input: string): Promise<string>;
  planDay(trace: string, input: string): Promise<string>;
  // After a reply is delivered: compact the chain's older rows into one summary row when the last window dropped rows or
  // ran near its budget. Never throws; a failure is one content-free `compaction` hop. Inert while the switch is off.
  compactIfDue?(conversationRef: string): Promise<void>;
  // The same compaction as a post-run job, once the turn's run has settled: its own scope (deadline and fence) and an
  // admitted context naming the chain, so it never holds a turn open. Reads the chain from the store the context names.
  compactChain?(trace: string, context: OwnerContextCapability, scope: RunEffectScope): Promise<void>;
  // The model's raw answer naming a thread from its first exchange; the caller checks it against the contract. The scope
  // is the call's own: its deadline bounds every attempt and its signal aborts the request in flight.
  threadTitle(trace: string, exchange: string, scope: RunEffectScope): Promise<string>;
  // The model's raw answer writing one progress note for a turn still running; the scope is the note's own, as above.
  progressNote(trace: string, input: string, scope: RunEffectScope): Promise<string>;
  control: ReturnType<typeof turnControl>;
}>;

// Host-selected surface, never inferred from owner text or transport payload.
export const ownerTurnTrace = (surface: string, updateId: number): string => surface === 'telegram' ? `tg-${updateId}` : `${surface}-${updateId}`;

export const ownerTurnAttachments = (turn: Pick<OwnerTurnEnvelope, 'attachment' | 'attachments'>): readonly LLMAttachment[] | undefined => {
  if (turn.attachment !== undefined && turn.attachments !== undefined) throw new Error('ambiguous turn media');
  const attachments = turn.attachments ?? (turn.attachment ? [turn.attachment] : undefined);
  if (!attachments?.length) return undefined;
  return llmRequestSchema.shape.attachments.parse([...attachments]);
};
