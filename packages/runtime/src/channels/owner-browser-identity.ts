import { ClosedRunError } from './run-effect-scope';

// The physical owner host supplies this port after server admission. Model input
// and browser evidence cannot create or change an owner binding.
export type OwnerBrowserIdentity = Readonly<{
  snapshot(): string | null;
  assertCurrent(binding: string): Promise<void>;
  resolve(binding: string): Promise<Readonly<{ directoryOwnerId: string; custodyDigest: string }>>;
}>;
export type CanonicalBrowserOwner = Readonly<{ directoryOwnerId: string; doName: string }>;

// Surface/session revisions fence current execution in assertCurrent. They do
// not own browser state: a link change must not replace the owner's allowance,
// paid session, workspace or approval target.
export function canonicalOwnerBrowserIdentity(options: Readonly<{
  env: Readonly<{ TELEGRAM_OWNER_DO?: DurableObjectNamespace }>;
  storage: DurableObjectStorage;
  actualDoId: string;
  snapshot(): CanonicalBrowserOwner | null;
  assertCurrent(owner: CanonicalBrowserOwner): Promise<void>;
}>): OwnerBrowserIdentity {
  const snapshot = () => {
    const owner=options.snapshot();
    if (!owner || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.directoryOwnerId)
      || !owner.doName || owner.doName.length>240 || options.storage.kv.get('rights:owner-lock')
      || options.storage.kv.get('do_name')!==owner.doName
      || options.env.TELEGRAM_OWNER_DO?.idFromName(owner.doName).toString()!==options.actualDoId) return null;
    return JSON.stringify([owner.directoryOwnerId.toLowerCase(),owner.doName]);
  };
  const ownerAt = (binding: string): CanonicalBrowserOwner => {
    // Compare the host's canonical snapshot before parsing: an arbitrary tuple
    // can never name another physical owner's browser capability.
    if (!binding || snapshot()!==binding) throw new ClosedRunError();
    const [directoryOwnerId,doName]=JSON.parse(binding) as [string,string];
    return Object.freeze({directoryOwnerId,doName});
  };
  const assertCurrent=async(binding:string)=>{
    const owner=ownerAt(binding);
    await options.assertCurrent(owner);
    ownerAt(binding);
  };
  return {
    snapshot,assertCurrent,
    async resolve(binding) {
      const owner=ownerAt(binding);await assertCurrent(binding);
      const bytes=new TextEncoder().encode(JSON.stringify(['owner_browser_custody_v1',owner.directoryOwnerId,owner.doName,options.actualDoId]));
      const custodyDigest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      await assertCurrent(binding);
      return Object.freeze({directoryOwnerId:owner.directoryOwnerId,custodyDigest});
    },
  };
}
