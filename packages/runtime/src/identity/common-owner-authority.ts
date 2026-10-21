import { signedRpc, type OwnerDirectoryEnv, type PresenceProvider } from './owner-directory';

// Private directory evidence. A transport subject or model argument never supplies owner authority.
export type CommonOwnerAuthority = Readonly<{
  custodyDigest: string; kind: 'verified_message_presence'; ownerId: string; authenticatedSubjectRef: string;
  directoryOwnerId: string; authenticatedUserId: string; doName: string;
  presenceId: string; provider: PresenceProvider; subject: string;
  stateVersion: number; admissionRevision: string;
}>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const rejected = () => new Error('common owner authority rejected');
const unavailable = () => new Error('common owner authority unavailable');
const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2,'0')).join('');
export function commonOwnerAuthority(env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = Date.now) {
  // Bound decoded source bytes as well as request latency; this RPC has no free-form content.
  const rpc = signedRpc(env, async (input, init) => {
    const signal = init?.signal;
    if (!signal) throw unavailable();
    const response = await fetcher(input, { ...init, signal });
    if (!response.body) return response;
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
    const cancel = () => { void reader.cancel(); }; signal.addEventListener('abort', cancel, { once:true });
    try { for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
      if (length > 4096) throw unavailable(); parts.push(part.value); } }
    finally { signal.removeEventListener('abort',cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part,offset); offset += part.byteLength; }
    return new Response(bytes, { status:response.status, headers:response.headers });
  }, now);
  const resolve = async (provider: PresenceProvider, subject: string, doName: string): Promise<CommonOwnerAuthority | null> => {
    if (!rpc) throw unavailable();
    if (!['telegram','whatsapp'].includes(provider) || !/^\d{1,32}$/.test(subject) || !doName || doName.length > 240) throw rejected();
    const locator = JSON.stringify([provider,subject,doName]);
    const value = await rpc('common_owner_authority', `common.owner.${locator}`, { p_provider:provider, p_subject:subject, p_do_name:doName, p_locator:locator });
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw rejected();
    const row = value as Record<string,unknown>;
    if (Object.getOwnPropertyNames(row).sort().join(',') !== 'admission_revision,auth_user_id,do_name,owner_id,presence_id,provider,state_version,subject'
      || [row.owner_id,row.auth_user_id,row.presence_id].some(id => typeof id !== 'string' || !uuid.test(id))
      || row.provider !== provider || row.subject !== subject || row.do_name !== doName
      || typeof row.state_version !== 'number' || !Number.isSafeInteger(row.state_version) || row.state_version < 0
      || typeof row.admission_revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.admission_revision)
      || BigInt(row.admission_revision) > 9223372036854775807n) throw rejected();
    const authenticatedUserId = (row.auth_user_id as string).toLowerCase();
    const digest = await sha256(authenticatedUserId);
    const custodyDigest = await sha256(JSON.stringify([row.owner_id,row.auth_user_id,row.do_name,row.presence_id,row.provider,row.subject,row.state_version,row.admission_revision]));
    return Object.freeze({ custodyDigest, kind:'verified_message_presence', ownerId:`owner_${digest}`, authenticatedSubjectRef:`supabase_subject_${digest}`,
      authenticatedUserId, directoryOwnerId:(row.owner_id as string).toLowerCase(), doName,
      presenceId:(row.presence_id as string).toLowerCase(), provider, subject,
      stateVersion:row.state_version, admissionRevision:row.admission_revision });
  };
  const assertCurrent = async (admitted: CommonOwnerAuthority) => {
    const current = await resolve(admitted.provider,admitted.subject,admitted.doName);
    if (!current || Object.keys(admitted).some(key => admitted[key as keyof CommonOwnerAuthority] !== current[key as keyof CommonOwnerAuthority])) throw rejected();
  };
  return { resolve, assertCurrent };
}
