import { b64url, consentState, googleConsentUrl, type GoogleApp } from './google';

// One record per consent attempt, kept in the owner's Durable Object: a single-use nonce (the OAuth
// state), its PKCE verifier and its outcome. The callback settles a record once; a repeat callback
// for the same attempt (browsers and in-app webviews reload) replays that outcome and never
// exchanges the single-use code again. Callers serialize start and finish per owner.
export const CONSENT_TTL_MS = 15 * 60_000;
const KEEP_SETTLED_MS = 24 * 60 * 60_000;

export type ConsentGrant = Readonly<{ email?: string; scopes?: readonly string[] | null }>;
export type ConsentOutcome =
  | Readonly<{ kind: 'linked'; email: string | null; scopes: readonly string[] }>
  | Readonly<{ kind: 'denied' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'failed'; reason: string }>;

export type ConsentFlow = Readonly<{
  // Set when the attempt was minted from a /c/<ticket> connect session (S3): the session's ticket hash.
  session?: string;
  expires: number;
  verifier: string;
  redirect_uri: string;
  settled?: ConsentOutcome;
  settled_at?: number;
}>;

export type ConsentStore = Readonly<{
  read(): Promise<Record<string, ConsentFlow>>;
  write(flows: Record<string, ConsentFlow>): Promise<void>;
}>;

export type ConsentDeps = Readonly<{
  store: ConsentStore;
  now(): number;
  random?: (bytes: number) => Uint8Array;
}>;

const randomBytes = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));
const challengeFor = async (verifier: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

const prune = (flows: Record<string, ConsentFlow>, now: number) =>
  Object.fromEntries(Object.entries(flows).filter(([, flow]) => (flow.settled ? (flow.settled_at ?? 0) + KEEP_SETTLED_MS : flow.expires) > now));

export async function startConsent(deps: ConsentDeps, app: GoogleApp, secret: string, owner: string, session?: string): Promise<Readonly<{ url: string; nonce: string }>> {
  const random = deps.random ?? randomBytes;
  const nonce = b64url(random(32));
  const verifier = b64url(random(32));
  const now = deps.now();
  const flows = prune(await deps.store.read(), now);
  await deps.store.write({ ...flows, [nonce]: { expires: now + CONSENT_TTL_MS, verifier, redirect_uri: app.redirectUri, ...(session ? { session } : {}) } });
  return { url: googleConsentUrl(app, await consentState(secret, owner, nonce), await challengeFor(verifier)), nonce };
}

export type ConsentCallback = Readonly<{ nonce: string; code?: string | null; error?: string | null }>;
export type ConsentExchange = (code: string, verifier: string, redirectUri: string) => Promise<ConsentGrant | null>;

// fresh is true only for the call that settled the attempt; a replayed callback gets fresh false,
// so the owner is told once.
export async function finishConsent(
  deps: ConsentDeps, input: ConsentCallback, exchange: ConsentExchange,
): Promise<Readonly<{ outcome: ConsentOutcome; fresh: boolean }>> {
  const now = deps.now();
  const flows = await deps.store.read();
  const flow = flows[input.nonce];
  if (!flow) return { outcome: { kind: 'invalid' }, fresh: false };
  if (flow.settled) return { outcome: flow.settled, fresh: false };
  // Re-read before writing: the exchange awaits the network, and another attempt may have started meanwhile.
  const settle = async (outcome: ConsentOutcome) => {
    await deps.store.write(prune({ ...(await deps.store.read()), [input.nonce]: { ...flow, settled: outcome, settled_at: now } }, now));
    return outcome;
  };
  if (flow.expires <= now) return { outcome: await settle({ kind: 'expired' }), fresh: true };
  if (input.error) return { outcome: await settle({ kind: 'denied' }), fresh: true };
  if (!input.code) return { outcome: { kind: 'invalid' }, fresh: false };
  try {
    const grant = await exchange(input.code, flow.verifier, flow.redirect_uri);
    if (!grant) return { outcome: await settle({ kind: 'failed', reason: 'no account returned' }), fresh: true };
    return { outcome: await settle({ kind: 'linked', email: grant.email ?? null, scopes: [...(grant.scopes ?? [])] }), fresh: true };
  } catch (error) {
    return { outcome: await settle({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) }), fresh: true };
  }
}
