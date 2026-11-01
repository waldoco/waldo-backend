import { ClosedRunError } from '../channels/run-effect-scope';

// An owner who joined without an invite is held, spending nothing on models, until the owner object holds their accepted
// agreements and 18+ attestation; then it releases them in the directory, which also lets their link codes and messaging
// presences through. The directory's answer is cached in the owner object: only this object releases its owner, so a
// cached answer cannot go stale. A directory that cannot answer holds the owner for this call and is asked again next time.
export type OpenOwnerState = 'member' | 'held' | 'released';
export const OPEN_OWNER_STATE_KEY = 'open_owner_state';

type Call = (fn: string, message: string, args: Record<string, string>) => Promise<unknown>;
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
export type OpenOwnerHold = Readonly<{
  held(): Promise<boolean>;
  // Joined openly, from the cached answer; false until the directory has answered once.
  open(): boolean;
}>;

// A model call refused because the owner is held: like a closed run, it ends the work without a retry or a reply.
export class OwnerHeldError extends ClosedRunError {}

// call is null where no directory is configured, and doName undefined before the object is bound to an owner: neither
// can be an open owner, since an open owner exists only in the directory and first reaches its object through the app.
export const openOwnerHold = (deps: Readonly<{ kv: Kv; doName: () => string | undefined; call: Call | null; agreed: () => boolean }>): OpenOwnerHold => {
  const cached = () => deps.kv.get<OpenOwnerState>(OPEN_OWNER_STATE_KEY);
  return {
    open: () => cached() === 'held' || cached() === 'released',
    async held() {
      let state = cached();
      if (state === 'member' || state === 'released') return false;
      const doName = deps.doName();
      if (!deps.call || !doName) return false;
      try {
        if (state === undefined) {
          const answer = await deps.call('open_owner_state', `openowner.state.${doName}`, { p_do_name: doName });
          if (answer !== 'member' && answer !== 'held' && answer !== 'released') return true;
          state = answer;
        }
        if (state === 'held' && deps.agreed() && (await deps.call('release_open_owner', `openowner.release.${doName}`, { p_do_name: doName })) === true) state = 'released';
      } catch {
        console.error(JSON.stringify({ hop: 'open_owner_hold', ok: false, code: 'directory_unavailable' }));
        return true;
      }
      deps.kv.put(OPEN_OWNER_STATE_KEY, state);
      return state === 'held';
    },
  };
};
