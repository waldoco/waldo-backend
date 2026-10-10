// Provider push is an authenticated wake hint. Current source reads and the owner's
// admission remain authoritative; a notification never supplies model content or effects.
export type GoogleCalendarChannel = Readonly<{ id: string; address: string; token: string; expiration: number }>;
export type GoogleCalendarWatch = Readonly<{ id: string; resourceId: string; expiration: number }>;
export type GoogleMailWatch = Readonly<{ historyId: string; expiration: number }>;
export type GoogleCalendarPushWitness = Readonly<{ ownerKey: string; connectionId: string; calendarId: string; channelId: string; epoch: number }>;
const safe = (value: unknown, limit = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n\0]/.test(value);
const bytes = (value: string) => new TextEncoder().encode(value);
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)));
const mac = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey('raw', bytes(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(`google-calendar-push:v1:${value}`))));
};
const equal = (left: string, right: string) => { let diff = left.length ^ right.length; for (let i=0;i<left.length;i++) diff |= left.charCodeAt(i) ^ (right.charCodeAt(i) || 0); return diff === 0; };
const validWitness = (value: unknown): value is GoogleCalendarPushWitness => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'calendarId,channelId,connectionId,epoch,ownerKey'
    && safe(row.ownerKey) && safe(row.connectionId) && safe(row.calendarId) && safe(row.channelId, 64)
    && Number.isSafeInteger(row.epoch) && Number(row.epoch) > 0;
};
export async function googleCalendarPushToken(secret: string, witness: GoogleCalendarPushWitness): Promise<string> {
  if (!secret || !validWitness(witness)) throw new Error('Google push is not configured');
  const payload = encode(bytes(JSON.stringify(witness)));
  return `${payload}.${await mac(secret, payload)}`;
}
export async function readGoogleCalendarPushToken(secret: string, token: string): Promise<GoogleCalendarPushWitness | null> {
  if (!secret || !safe(token, 4096)) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined || !equal(signature, await mac(secret, payload))) return null;
    const row: unknown = JSON.parse(decode(payload)); return validWitness(row) ? row : null;
  } catch { return null; }
}
export const validGooglePushAddress = (address: string): boolean => {
  try { const url = new URL(address); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash && !url.search; } catch { return false; }
};
// Verify the exact provider headers against a recorded registration. The host also checks
// canonical owner, current connection/grant epoch, collection policy and active watches.
export function googleCalendarPushEvent(headers: Headers, registration: GoogleCalendarWatch, now: number): Readonly<{ eventKey: string; state: 'sync' | 'exists' | 'not_exists' }> | null {
  const state = headers.get('x-goog-resource-state'), sequence = headers.get('x-goog-message-number');
  if (registration.expiration <= now || headers.get('x-goog-channel-id') !== registration.id
    || headers.get('x-goog-resource-id') !== registration.resourceId || !sequence || !/^\d{1,30}$/.test(sequence)
    || !['sync','exists','not_exists'].includes(state ?? '')) return null;
  return {eventKey: `calendar-push:${registration.id}:${sequence}`, state: state as 'sync' | 'exists' | 'not_exists'};
}
