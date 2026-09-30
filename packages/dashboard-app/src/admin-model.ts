export type AdminRecord = {
  csrf: string; as_of: string;
  current_issuer: { id: string; email: string | null; issued_count: number };
  owners: { id: string; email: string | null; state: string; presences: string[]; created_at: string; issued_count: number }[];
  invites: { id: string; email: string | null; issued_by: string | null; issuer_email: string | null; created_at: string; expires_at: string | null; used_at: string | null; revoked_at: string | null }[];
};
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nullable = (v: unknown) => v === null || typeof v === 'string';
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const time = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function readAdmin(v: unknown): AdminRecord {
  if (!obj(v) || typeof v.csrf !== 'string' || !time(v.as_of) || !obj(v.current_issuer) || typeof v.current_issuer.id !== 'string' || !nullable(v.current_issuer.email) || !count(v.current_issuer.issued_count) ||
    !Array.isArray(v.owners) || !v.owners.every(o => obj(o) && typeof o.id === 'string' && nullable(o.email) && typeof o.state === 'string' && time(o.created_at) && count(o.issued_count) && Array.isArray(o.presences) && o.presences.every(p => typeof p === 'string')) ||
    !Array.isArray(v.invites) || !v.invites.every(i => obj(i) && typeof i.id === 'string' && nullable(i.email) && nullable(i.issued_by) && nullable(i.issuer_email) && time(i.created_at) && [i.expires_at,i.used_at,i.revoked_at].every(t => t === null || time(t)))) throw new Error('The admin projection is unavailable or unsupported. Open the existing admin controls.');
  // Pick only read fields; raw invite codes never belong in this projection.
  return {csrf:v.csrf,as_of:v.as_of as string,current_issuer:{id:v.current_issuer.id,email:v.current_issuer.email as string|null,issued_count:v.current_issuer.issued_count as number},
    owners:v.owners.map(o=>({id:o.id,email:o.email,state:o.state,presences:o.presences,created_at:o.created_at,issued_count:o.issued_count})),
    invites:v.invites.map(i=>({id:i.id,email:i.email,issued_by:i.issued_by,issuer_email:i.issuer_email,created_at:i.created_at,expires_at:i.expires_at,used_at:i.used_at,revoked_at:i.revoked_at}))};
}
export function inviteStatus(i: AdminRecord['invites'][number], asOf: string) {
  return i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at && Date.parse(i.expires_at) <= Date.parse(asOf) ? 'expired' : 'open';
}
export const quota = (issued: number) => ({used:issued,remaining:Math.max(0,5-issued)});
export const pageRows = <T,>(rows: T[], page: number, size = 10) => {
  const pages=Math.max(1,Math.ceil(rows.length/size)); const current=Math.max(1,Math.min(page,pages));
  return {rows:rows.slice((current-1)*size,current*size),current,pages,total:rows.length};
};
export async function fetchAdmin(signal?: AbortSignal): Promise<AdminRecord | null> {
  const response=await fetch('/console/admin',{headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store',redirect:'error',signal});
  if(response.status===404)return null;
  if(!response.ok)throw new Error('Admin records are unavailable. Retry or open the existing admin controls.');
  return readAdmin(await response.json());
}
export async function submitInvite(data: AdminRecord, action: 'invite.create'|'invite.revoke', value: string) {
  let response: Response;
  try { response=await fetch('/console/action',{method:'POST',headers:{accept:'application/json'},credentials:'same-origin',cache:'no-store',redirect:'error',body:new URLSearchParams({csrf:data.csrf,action,[action==='invite.create'?'value':'id']:value})}); }
  catch { throw new Error('The action result is unavailable. Refresh records before retrying; a code cannot be recovered.'); }
  if(response.status===409)throw new Error('Not completed. Refresh records: the quota, recipient or invite state may have changed.');
  if(response.status===403)throw new Error('Not completed. Reload this page to renew the session before trying again.');
  if(!response.ok)throw new Error('The action result is unavailable. Refresh records before retrying; a code cannot be recovered.');
  let receipt: unknown;
  try { receipt=await response.json(); }
  catch { throw new Error('The receipt is unavailable. Refresh records before retrying; a code cannot be recovered.'); }
  if(!obj(receipt)||typeof receipt.message!=='string'||(action==='invite.create'&&typeof receipt.code!=='string'))throw new Error('The receipt is unavailable. Refresh records before retrying; a code cannot be recovered.');
  return {message:receipt.message,code:typeof receipt.code==='string'?receipt.code:null};
}
