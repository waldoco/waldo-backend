import type { LLMAttachment } from '@waldo/contracts';
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
}>;
export const REPLY_QUOTE_LIMIT = 2048;

export type OwnerTurnEnvelope = Readonly<{
  traceId: string;
  conversationRef: string;
  surface: string;
  text: string;
  mediaNote?: string;
  replyTo?: ReplyContext;
  attachment?: LLMAttachment;
  // Set by the channel host. When false, this turn skips its immediate memory write. Nightly consolidation and history indexing are separate and unaffected.
  memoryWrites?: boolean;
}>;
export type OwnerResponder = Readonly<{
  respond(turn: OwnerTurnEnvelope, time: TurnTimer): Promise<string>;
  chooseReaction(turn: OwnerTurnEnvelope): Promise<string | null>;
  remind(id: string, conversationRef: string, note: string, time: TurnTimer, surface?: string): Promise<string>;
  prompt(id: string, conversationRef: string, said: string, time: TurnTimer, surface?: string): Promise<string>;
  consolidate(trace: string, day: string, sides?: { owner: string; waldo: string }): Promise<string>;
  migrate(trace: string, input: string): Promise<string>;
  promote(trace: string): Promise<string>;
  planDay(trace: string, input: string): Promise<string>;
  control: ReturnType<typeof turnControl>;
}>;

// Host-selected surface, never inferred from owner text or transport payload.
export const ownerTurnTrace = (surface: string, updateId: number): string => surface === 'telegram' ? `tg-${updateId}` : `${surface}-${updateId}`;
