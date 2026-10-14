import { ownerWords, type InboundPart } from '../../src/channels/owner-inbound-turn';

// A fixture turn whose whole text the owner typed, as most tests send: it carries that text as one owner part.
export const ownerTyped = <T extends Readonly<{ text: string }>>(turn: T): T & Readonly<{ parts: readonly InboundPart[] }> =>
  ({ ...turn, parts: ownerWords(turn.text) });
