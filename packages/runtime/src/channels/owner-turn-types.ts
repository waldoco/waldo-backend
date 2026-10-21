import type { SystemSection, TurnContextShape, TurnEvent, TurnText } from '@waldo/contracts';

// The runtime's per-hop turn record is the contracts TurnEvent (schema v9); these aliases keep the runtime's names.
export type { SystemSection, TurnText };
export type ContextShape = TurnContextShape;
export type TurnLogEntry = TurnEvent;
export type TurnTimer = <T>(hop: string, work: () => Promise<T>) => Promise<T>;
