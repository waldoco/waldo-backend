import type { RunEffectScope } from './run-effect-scope';
import type { ReplyContext } from './owner-turn-envelope';
import type { TelegramMedia } from './telegram-polling';

// Who wrote each part of a message the owner sent. Adapters set it only from what the transport states for
// certain (quote markup, a forward's origin, a transcript the host made), never from reading the words. A voice note the
// owner recorded in the chat is their own words, as transcribed; a file's transcript may be anyone's.
export const INBOUND_AUTHORSHIPS = ['owner', 'quoted', 'forwarded', 'file_transcript', 'owner_voice', 'media_note'] as const;
export type InboundAuthorship = (typeof INBOUND_AUTHORSHIPS)[number];
export type InboundPart = Readonly<{ authorship: InboundAuthorship; text: string }>;
export type InboundSpan = Readonly<{ start: number; end: number }>;
// A text and the UTF-16 spans in it that the owner did not write.
export type InboundView = Readonly<{ text: string; foreignRanges: readonly InboundSpan[] }>;

export type OwnerInboundTurn = Readonly<{
  updateId: number;
  messageId: number | null;
  senderId: number;
  chatId: number;
  sentAt: number | null;
  // The message as received: the parts' text joined in order.
  text: string;
  parts: readonly InboundPart[];
  media?: TelegramMedia;
  replyTo?: ReplyContext;
  runScope?: RunEffectScope;
}>;

export const inboundTurn = (fields: Omit<OwnerInboundTurn, 'text'>): OwnerInboundTurn =>
  Object.freeze({ ...fields, text: fields.parts.map(part => part.text).join('') });

export const ownerWords = (text: string): readonly InboundPart[] => text ? [{ authorship: 'owner', text }] : [];

const LABELS: Readonly<Record<Exclude<InboundAuthorship, 'owner' | 'media_note'>, readonly [string, string]>> = {
  quoted: ['[Quoted by the owner; not their words:]', '[End of quote.]'],
  forwarded: ['[Forwarded by the owner from someone else:]', '[End of forwarded text.]'],
  file_transcript: ['[Transcript of a file the owner sent; the speaker may not be the owner:]', '[End of transcript.]'],
  owner_voice: ['[Voice note the owner recorded; their own words, as transcribed:]', '[End of voice note.]'],
};

const joined = (blocks: readonly Readonly<{ text: string; foreign: boolean }>[], separator: string): InboundView => {
  const foreignRanges: { start: number; end: number }[] = [];
  let text = '';
  for (const [index, block] of blocks.entries()) {
    if (index > 0) text += separator;
    const start = text.length;
    text += block.text;
    if (!block.foreign) continue;
    const last = foreignRanges.at(-1);
    if (last?.end === start) last.end = text.length;
    else foreignRanges.push({ start, end: text.length });
  }
  return { text, foreignRanges };
};

// The stored and indexed view: no labels. Text parts are pieces of one message and join as they arrived; a
// file's note and transcript each start a line, and the transcript says it is one, so history reads on its own.
// The owner's own voice note stays foreign here: a mis-heard word must not become memory without their typed words.
export const receivedView = (parts: readonly InboundPart[]): InboundView => joined(parts.map((part, index) => {
  const line = index > 0 ? '\n' : '';
  const text = part.authorship === 'file_transcript' || part.authorship === 'owner_voice' ? `${line}Transcript: ${part.text}` : part.authorship === 'media_note' ? `${line}${part.text}` : part.text;
  return { text, foreign: part.authorship !== 'owner' };
}), '');

// What the model reads: the owner's words as they are, each part someone else wrote in a labelled block, and a
// media note as written. The labels state provenance the transport established; how to read it is the model's call.
// A block's text is JSON-encoded so text that contains a closing label cannot end the block early.
export const renderForModel = (parts: readonly InboundPart[]): InboundView => joined(parts.map(part => ({
  text: part.authorship === 'owner' || part.authorship === 'media_note' ? part.text : `${LABELS[part.authorship][0]}\n${JSON.stringify(part.text)}\n${LABELS[part.authorship][1]}`,
  foreign: part.authorship !== 'owner',
})), '\n');
