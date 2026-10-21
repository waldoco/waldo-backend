import type { BrowserLoginState } from '@waldo/contracts';

// The owner signs in through a live view of the errand's browser; Waldo never sees or types the credentials.
// While the owner may be typing, no engine run, screenshot or page read happens on that browser. Once the owner says
// they are done, exactly one read confirms the intended account before automation resumes.
export type BrowserLoginEvent =
  | Readonly<{ type: 'owner_opened' }>
  | Readonly<{ type: 'owner_done' }>
  | Readonly<{ type: 'confirmed'; signedIn: boolean }>
  | Readonly<{ type: 'cancel' }>;

const TERMINAL: ReadonlySet<BrowserLoginState> = new Set(['signed_in', 'failed', 'expired', 'cancelled']);

export class BrowserLoginTransitionError extends Error {
  constructor(from: BrowserLoginState, event: BrowserLoginEvent['type'] | 'expire') { super(`browser login cannot ${event} from ${from}`); }
}

export const loginTerminal = (state: BrowserLoginState): boolean => TERMINAL.has(state);

// Page reads, screenshots and agent runs are paused from the request until the owner hands control back.
export const loginPausesAutomation = (state: BrowserLoginState): boolean => state === 'requested' || state === 'owner_in_control';

export function nextLoginState(state: BrowserLoginState, event: BrowserLoginEvent, now: number, expiresAt: number): BrowserLoginState {
  if (TERMINAL.has(state)) throw new BrowserLoginTransitionError(state, event.type);
  if (event.type === 'cancel') return 'cancelled';
  // A late completion never revives an expired handoff: the owner starts a fresh one.
  if (now >= expiresAt) return 'expired';
  if (event.type === 'owner_opened' && state === 'requested') return 'owner_in_control';
  if (event.type === 'owner_done' && (state === 'requested' || state === 'owner_in_control')) return 'owner_done';
  if (event.type === 'confirmed' && state === 'owner_done') return event.signedIn ? 'signed_in' : 'failed';
  throw new BrowserLoginTransitionError(state, event.type);
}

export function expireLogin(state: BrowserLoginState, now: number, expiresAt: number): BrowserLoginState {
  return !TERMINAL.has(state) && now >= expiresAt ? 'expired' : state;
}
