import type { LLMAttachment } from '@waldo/contracts';
import type { TurnTimer } from './owner-turn-types';
import type { turnControl } from './turn-control';

// Auth and provider parsing happen in adapters. This is the admitted content
// boundary consumed by the conversation, memory and tool loop.
export type OwnerTurnEnvelope = Readonly<{
  traceId: string;
  conversationRef: string;
  surface: string;
  text: string;
  mediaNote?: string;
  attachment?: LLMAttachment;
  // Authenticated host control, never inferred from owner prose or provider payload.
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
