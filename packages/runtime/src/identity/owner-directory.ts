export type OwnerRoute = Readonly<{ doName: string; subject: string; timezone: string | null }>;

export type OwnerDirectoryEnv = Readonly<{
  SUPABASE_PROJECT_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  WALDO_ROUTER_HMAC_SECRET?: string;
  WALDO_OWNER_TELEGRAM_ID?: string;
  WALDO_OWNER_TIMEZONE?: string;
}>;

// Providers with a presence row: telegram (numeric chat id), whatsapp (E.164 digits).
export type PresenceProvider = 'telegram' | 'whatsapp';

export type OwnerDirectory = Readonly<{
  byPresence(provider: PresenceProvider, subject: string): Promise<OwnerRoute | null>;
  redeem(provider: PresenceProvider, subject: string, code: string): Promise<OwnerRoute | null>;
}>;

type RouteRow = { do_name: string; subject: string; timezone: string | null };

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
});
// WhatsApp has no single-owner env fallback: routing a phone number requires a real presence row,
// so the directory-backed path is the only one (deployOwner answers telegram only).

// The runtime holds no service-role key (ADR-0052): it calls signed database functions with the publishable key.
export const signedRpc = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()) => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  if (!base || !key || !secret) return null;
  return async (fn: string, message: string, args: Record<string, string>): Promise<unknown> => {
    const at = Math.floor(now() / 1000);
    const response = await fetcher(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, 'content-profile': 'waldo', 'content-type': 'application/json' },
      body: JSON.stringify({ ...args, p_at: at, p_sig: await routerSignature(secret, at, message) }),
    });
    if (!response.ok) throw new Error(`owner directory ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };
};

export const ownerDirectory = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): OwnerDirectory => {
  const call = signedRpc(env, fetcher, now);
  if (!call) return deployOwner(env);
  const byPresence = async (provider: PresenceProvider, subject: string): Promise<OwnerRoute | null> => {
    const [row] = (await call('route_presence', `route.${provider}.${subject}`, { p_provider: provider, p_subject: subject })) as RouteRow[];
    return row ? { doName: row.do_name, subject: row.subject, timezone: row.timezone } : null;
  };
  return {
    byPresence,
    redeem: async (provider, subject, code) => {
      const hash = await linkCodeHash(code);
      const owner = await call('redeem_link', `redeem.${hash}.${provider}.${subject}`, { p_code_hash: hash, p_provider: provider, p_subject: subject });
      return owner ? byPresence(provider, subject) : null;
    },
  };
};
