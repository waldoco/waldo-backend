import { hex, signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';

// Refresh tokens live in Supabase Vault. The Durable Object keeps only the connection id and reads the
// token back through a signed call when it needs a fresh access token.
export type ConnectionVault = Readonly<{
  store(doName: string, account: string, scopes: readonly string[], token: string): Promise<string | null>;
  secret(doName: string, id: string): Promise<string | null>;
  health(doName: string, id: string, error: string): Promise<boolean>;
  revoke(doName: string, id: string): Promise<boolean>;
}>;

const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const connectionVault = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): ConnectionVault | null => {
  const rpc = signedRpc(env, fetcher, now);
  if (!rpc) return null;
  return {
    async store(doName, account, scopes, token) {
      const [address, granted] = [account.trim().toLowerCase(), scopes.join(' ')];
      return (await rpc('connection_store', `connstore.${doName}.google.${address}.${granted}.${await sha256(token)}`,
        { p_do_name: doName, p_provider: 'google', p_account: address, p_scopes: granted, p_secret: token })) as string | null;
    },
    secret: async (doName, id) => (await rpc('connection_secret', `connsecret.${doName}.${id}`, { p_do_name: doName, p_connection: id })) as string | null,
    health: async (doName, id, error) => (await rpc('connection_health', `connhealth.${doName}.${id}.${error}`, { p_do_name: doName, p_connection: id, p_error: error })) === true,
    revoke: async (doName, id) => (await rpc('connection_revoke', `connrevoke.${doName}.${id}`, { p_do_name: doName, p_connection: id })) === true,
  };
};
