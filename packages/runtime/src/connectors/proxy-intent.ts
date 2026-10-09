// Host-only approval/invocation identity. Caller content is never an authority key.
// readOnly: a host-derived read identity. It never pins a route (no durable row per read); effects keep full custody.
export type ProxyIntent = Readonly<{ id: string; requireRoute?: boolean; readOnly?: boolean }>;
export type IntentClaim = Readonly<{ state: 'new' | 'pending' | 'conflict' } | { state: 'done'; result: unknown }>;
export type IntentLedger = Readonly<{
  claim(id: string, digest: string): Promise<IntentClaim | null>;
  store(id: string, result: unknown): Promise<boolean>;
}>;
export class ProxyIntentError extends Error {
  constructor(public readonly code: 'intent_required' | 'intent_conflict' | 'intent_pending' | 'intent_unavailable') { super(code); }
}
export const proxyIntentDigest = async (payload: unknown): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))].map(v=>v.toString(16).padStart(2,'0')).join('');
// An uncertain dispatch, or store failure after dispatch, stays pending. It is NOT
// a failure receipt proving no effect. There is no transparent provider retry.
export const executeProxyIntent = async (intent: ProxyIntent | undefined, payload: unknown, ledger: IntentLedger, dispatch: () => Promise<unknown>): Promise<unknown> => {
  if(!intent || typeof intent.id!=='string' || !/^[a-zA-Z0-9:_-]{1,240}$/.test(intent.id))throw new ProxyIntentError('intent_required');
  const digest=await proxyIntentDigest(payload);
  let claim:IntentClaim|null;
  try{claim=await ledger.claim(intent.id,digest);}catch{throw new ProxyIntentError('intent_unavailable');}
  if(!claim)throw new ProxyIntentError('intent_unavailable');
  if(claim.state==='conflict')throw new ProxyIntentError('intent_conflict');
  if(claim.state==='pending')throw new ProxyIntentError('intent_pending');
  if(claim.state==='done')return claim.result;
  if(claim.state!=='new')throw new ProxyIntentError('intent_unavailable');
  let result:unknown;
  try{result=await dispatch();}catch{throw new ProxyIntentError('intent_pending');}
  try{if(!await ledger.store(intent.id,result))throw new ProxyIntentError('intent_pending');}catch{throw new ProxyIntentError('intent_pending');}
  return result;
};
