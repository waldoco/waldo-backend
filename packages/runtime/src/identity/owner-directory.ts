import { withRequestTimeout } from './request-timeout';
import { ownerTraceIdentity, type OwnerTraceIdentity } from '../observability/owner-trace-identity';

export type OwnerRoute = Readonly<{ doName: string; subject: string; timezone: string | null; traceIdentity?: OwnerTraceIdentity }>;

export type OwnerDirectoryEnv = Readonly<{
  SUPABASE_PROJECT_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  WALDO_ROUTER_HMAC_SECRET?: string;
  WALDO_OWNER_TELEGRAM_ID?: string;
  WALDO_OWNER_TIMEZONE?: string;
}>;

// Providers with a presence row: telegram (numeric chat id), whatsapp (E.164 digits).
export type PresenceProvider = 'telegram' | 'whatsapp';
export type PresenceLookupProvider = PresenceProvider | 'imessage';

/** claimed: the subject is live under another owner, so nothing changed and the code was not spent. */
export type RedemptionOutcome = { kind: 'redeemed' | 'rejected' | 'claimed' | 'uncertain' };
export type OwnerDirectory = Readonly<{
  redeemHashed?(provider: PresenceLookupProvider, subject: string, hash: string): Promise<RedemptionOutcome>;
  byPresence(provider: PresenceLookupProvider, subject: string): Promise<OwnerRoute | null>;
  redeem(provider: PresenceLookupProvider, subject: string, code: string): Promise<OwnerRoute | null>;
}>;

type RouteRow = { do_name: string; subject: string; timezone: string | null; owner_id?: string; owner_email?: string | null };

export const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const linkCodeHash = async (code: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.trim().toUpperCase())));

export const routerSignature = async (secret: string, at: number, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${at}.${message}`)));
};

// Until the Supabase project exists, the single deploy-configured owner is the whole directory.
const deployOwner = (env: OwnerDirectoryEnv): OwnerDirectory => ({
  byPresence: async (provider, subject) =>
    provider === 'telegram' && env.WALDO_OWNER_TELEGRAM_ID && subject === env.WALDO_OWNER_TELEGRAM_ID
      ? { doName: subject, subject, timezone: env.WALDO_OWNER_TIMEZONE ?? null }
      : null,
  redeem: async () => null,
  redeemHashed: async () => ({ kind: 'rejected' }),
});
// WhatsApp has no single-owner env fallback: routing a phone number requires a real presence row,
// so the directory-backed path is the only one (deployOwner answers telegram only).

/** A refused directory call, with the PostgreSQL code and message PostgREST reported, when it reported them. */
export class OwnerDirectoryError extends Error {
  constructor(readonly status: number, readonly sqlState: string | null, readonly dbMessage: string | null) { super(`owner directory ${status}`); }
}
/** redeem_link_code's own refusal; any other unique_violation (an index race) stays uncertain. */
const CLAIMED_ELSEWHERE = 'presence already linked to another owner';

// The runtime holds no service-role key (ADR-0052): it calls signed database functions with the publishable key.
export const signedRpc = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()) => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  if (!base || !key || !secret) return null;
  return async (fn: string, message: string, args: Record<string, string | number>): Promise<unknown> => {
    const at = Math.floor(now() / 1000);
    return withRequestTimeout(async signal => {
      const signature = await routerSignature(secret, at, message);
      signal.throwIfAborted();
      const response = await fetcher(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST', signal,
        headers: { apikey: key, 'content-profile': 'waldo', 'content-type': 'application/json' },
        body: JSON.stringify({ ...args, p_at: at, p_sig: signature }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const { code, message } = body && typeof body === 'object' ? body as { code?: unknown; message?: unknown } : {};
        throw new OwnerDirectoryError(response.status, typeof code === 'string' ? code : null, typeof message === 'string' ? message : null);
      }
      return response.json();
    });
  };
};

export const ownerDirectory = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): OwnerDirectory => {
  const call = signedRpc(env, fetcher, now);
  if (!call) return deployOwner(env);
  const byPresence = async (provider: PresenceLookupProvider, subject: string): Promise<OwnerRoute | null> => {
    const [row] = (await call('route_presence', `route.${provider}.${subject}`, { p_provider: provider, p_subject: subject })) as RouteRow[];
    if (!row) return null;
    const traceIdentity = ownerTraceIdentity(row);
    return { doName: row.do_name, subject: row.subject, timezone: row.timezone, ...(traceIdentity ? { traceIdentity } : {}) };
  };
  return {
    byPresence,
    // A route lookup is intentionally separate. A successful redemption with a
    // missing/lost route read must never be relabeled as an invalid code.
    redeemHashed: async (provider, subject, hash) => {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid link hash');
      try {
        const result = await call('redeem_link', `redeem.${hash}.${provider}.${subject}`, { p_code_hash: hash, p_provider: provider, p_subject: subject });
        return { kind: result === null ? 'rejected' : typeof result === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result) ? 'redeemed' : 'uncertain' };
      } catch (error) {
        const claimed = error instanceof OwnerDirectoryError && error.sqlState === '23505' && error.dbMessage === CLAIMED_ELSEWHERE;
        return { kind: claimed ? 'claimed' : 'uncertain' };
      }
    },
    redeem: async (provider, subject, code) => {
      const hash = await linkCodeHash(code);
      const owner = await call('redeem_link', `redeem.${hash}.${provider}.${subject}`, { p_code_hash: hash, p_provider: provider, p_subject: subject });
      return owner ? byPresence(provider, subject) : null;
    },
  };
};
