// The key that signs connector OAuth state (Google and MCP) and keys the browser binding every connect hop and callback
// checks (Google, MCP, WHOOP and Photon). It is its own secret so a connect never depends on, or shares a key with, a
// channel's webhook secret. There is no fallback to any other secret: without it, signing in to Google, MCP servers,
// WHOOP and Photon is off, and the first use in each isolate says so once.
export type OAuthStateEnv = Readonly<{ WALDO_OAUTH_STATE_SECRET?: string }>;

let warned = false;
export const oauthStateSecret = (env: OAuthStateEnv): string | null => {
  const secret = env.WALDO_OAUTH_STATE_SECRET;
  if (secret) return secret;
  if (!warned) {
    warned = true;
    console.warn(JSON.stringify({ event: 'oauth_state_secret_missing', effect: 'google_and_mcp_sign_in_off' }));
  }
  return null;
};
