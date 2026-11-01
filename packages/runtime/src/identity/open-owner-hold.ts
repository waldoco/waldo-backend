import { ClosedRunError } from '../channels/run-effect-scope';
import { routerSignature } from './owner-directory';

// An owner who joined without an invite is held, spending nothing on models, until their owner object holds their accepted
// agreements and 18+ attestation; then it releases them in the directory, which also lets their link codes and messaging
// presences through. Only such an owner's object carries the mark: the Worker sets it before any sign-in of theirs mints a
// credential, so every other owner object never asks the directory about it.
export type OpenOwnerMark = 'held' | 'released';
export const OPEN_OWNER_MARK_KEY = 'open_owner';
export const OPEN_OWNER_PATH = '/app/v1/internal/open-owner';
const HEADER = 'x-waldo-open-owner-sig';
const TIMEOUT_MS = 20_000;

type Call = (fn: string, message: string, args: Record<string, string>) => Promise<unknown>;
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
type OwnerNamespace = Readonly<{ idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } }>;
export type OpenOwnerHold = Readonly<{
  held(): Promise<boolean>;
  open(): boolean;
  // Sets the mark once; a released owner stays released.
  mark(): void;
}>;

// A model call refused because the owner is held: like a closed run, it ends the work without a retry or a reply.
export class OwnerHeldError extends ClosedRunError {}

// A release the directory cannot record keeps the owner held for this call; the next one asks again.
export const openOwnerHold = (deps: Readonly<{ kv: Kv; doName: () => string | undefined; call: Call | null; agreed: () => boolean }>): OpenOwnerHold => {
  const mark = () => deps.kv.get<OpenOwnerMark>(OPEN_OWNER_MARK_KEY);
  return {
    open: () => mark() !== undefined,
    mark: () => { if (mark() === undefined) deps.kv.put(OPEN_OWNER_MARK_KEY, 'held'); },
    async held() {
      if (mark() !== 'held') return false;
      const doName = deps.doName();
      if (!deps.agreed() || !deps.call || !doName) return true;
      try {
        if ((await deps.call('release_open_owner', `openowner.release.${doName}`, { p_do_name: doName })) !== true) return true;
      } catch {
        console.error(JSON.stringify({ hop: 'open_owner_hold', ok: false, code: 'release_unavailable' }));
        return true;
      }
      deps.kv.put(OPEN_OWNER_MARK_KEY, 'released');
      return false;
    },
  };
};

// Worker to owner object: "your owner joined openly". The router signature binds the owner; a replay sets a mark already set.
export const sendOpenOwnerMark = async (owners: OwnerNamespace, secret: string, doName: string): Promise<boolean> => {
  const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${OPEN_OWNER_PATH}`, {
    method: 'POST', headers: { 'x-waldo-do-name': doName, [HEADER]: await routerSignature(secret, 0, `openowner.mark.${doName}`) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  return response.ok;
};

export const verifiedOpenOwnerMark = async (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<boolean> => {
  const doName = request.headers.get('x-waldo-do-name') ?? '', given = request.headers.get(HEADER) ?? '';
  if (request.method !== 'POST' || !secret || !doName || !addressesThisObject(doName)) return false;
  const expected = new TextEncoder().encode(await routerSignature(secret, 0, `openowner.mark.${doName}`)), supplied = new TextEncoder().encode(given);
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (supplied[i] ?? 0);
  return diff === 0;
};

// Before a sign-in mints a credential, while OPEN_SIGNUP is "1": an owner the directory says joined openly has their object
// marked, so a join whose answer was lost is marked on the retry. False when that cannot be done; the sign-in then fails.
// With the flag off nothing is asked: every owner object marked earlier keeps its mark.
export const markOpenOwner = async (env: Readonly<{ OPEN_SIGNUP?: string; WALDO_ROUTER_HMAC_SECRET?: string }>,
  state: ((doName: string) => Promise<unknown>) | undefined, owners: OwnerNamespace | undefined, doName: string): Promise<boolean> => {
  if (env.OPEN_SIGNUP !== '1') return true;
  if (!state) return false;
  const answer = await state(doName);
  if (answer === 'member') return true;
  if ((answer !== 'held' && answer !== 'released') || !owners || !env.WALDO_ROUTER_HMAC_SECRET) return false;
  return sendOpenOwnerMark(owners, env.WALDO_ROUTER_HMAC_SECRET, doName);
};
