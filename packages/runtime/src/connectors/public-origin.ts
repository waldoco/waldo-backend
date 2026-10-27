// The origin Waldo puts in what it issues or registers: OAuth callbacks, the Telegram webhook, Calendar watch addresses,
// console and file links. Each owner object stores the origin its last request carried and re-points the Telegram
// webhook when it changes, so while two hosts serve one Worker a request through the other host would move them back.
// One configured origin per environment stops that. Unset (tests, local runs, previews) it is the request's own origin.
// Flows that must finish on the host they started on (console sign-in, Photon start, the MCP client metadata document,
// the Gmail push audience) keep the request's origin and never read this.
export type PublicOriginEnv = Readonly<{ WALDO_PUBLIC_ORIGIN?: string }>;

export const configuredPublicOrigin = (env: PublicOriginEnv): string | null => {
  const configured = env.WALDO_PUBLIC_ORIGIN;
  if (!configured) return null;
  let parsed: URL | null = null;
  try { parsed = new URL(configured); } catch { /* refused below */ }
  if (parsed?.protocol !== 'https:' || parsed.origin !== configured) throw new Error('WALDO_PUBLIC_ORIGIN must be a bare https origin');
  return configured;
};

export const publicOrigin = (env: PublicOriginEnv, requestUrl: string | URL): string =>
  configuredPublicOrigin(env) ?? new URL(requestUrl).origin;
