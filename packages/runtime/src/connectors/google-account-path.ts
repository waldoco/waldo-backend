// Send-path custody gate (#202): a send (sendIntent set) must ride the connector-proxy
// idempotency claim/store AND Vault custody. A DO-local refresh_token client would bypass
// both, so a send on a local-token account first migrates the grant into the Vault ('adopt'),
// and a send with no proxy at all is refused. Reads keep the pre-existing local fallback.
export type GoogleClientPath =
  | Readonly<{ kind: 'direct' }> // read path: DO-local token fallback (no proxy configured)
  | Readonly<{ kind: 'vault' }> // proxy client on the stored connection id
  | Readonly<{ kind: 'adopt' }> // send path: migrate the local grant into Vault, then vault
  | Readonly<{ kind: 'reject_send' }> // send path with no proxy custody: refuse
  | Readonly<{ kind: 'unavailable' }>; // connection-id account with no proxy to serve it

export const googleClientPath = (
  account: Readonly<{ refresh_token?: string }>,
  sendIntent: string | undefined,
  vaultAvailable: boolean,
): GoogleClientPath => {
  if (account.refresh_token) {
    if (sendIntent === undefined) return { kind: 'direct' };
    return vaultAvailable ? { kind: 'adopt' } : { kind: 'reject_send' };
  }
  return vaultAvailable ? { kind: 'vault' } : { kind: 'unavailable' };
};
