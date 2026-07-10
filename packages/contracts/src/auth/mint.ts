import { z } from 'zod';

// ADR-0066 mint contract: a dedicated Edge Function is the only signer of DO-side Supabase
// JWTs; the DO holds one exchange-only rotate-on-use mint key plus the current short-TTL
// RLS JWT. These shapes land contract-first. Deployment is SPIKE-GATED: no DO→Supabase
// data-plane read ships until the staging issuer spike confirms PostgREST accepts the
// dedicated ES256 issuer (valid signature, auth.uid() populated, role switch applied,
// custom iss accepted). Shapes and vocabulary only — no key material lives in contracts.

export const MINT_ISSUER =
  'https://oqcjjcytjvrckvylagsl.supabase.co/functions/v1/mint-agent-jwt';

// ADR-0066 §4 law: margin = 15-min handler wall-clock ceiling + 5-min skew, so a token
// that passes the pre-run check cannot expire inside one handler's ceiling.
export const MINT_JWT_TTL_MIN = 60;
export const MINT_REFRESH_MARGIN_MIN = 20;
export const MINT_NBF_BACKDATE_SECONDS = 60;
export const MINT_JWT_TTL_SECONDS = MINT_JWT_TTL_MIN * 60;

// Uniform on every bootstrap/refresh failure — the mint EF is not a user-existence or
// revocation oracle. A refresh 403 is terminal (degraded mode, no retry storm); the
// PostgREST 401 → refresh-once → retry-once path is a separate, non-terminal lane.
export const MINT_FAILURE_STATUS = 403;

// Compact JWS: exactly three dot-separated base64url segments, so a mint key or arbitrary
// string can never occupy a JWT-bearing field.
export const compactJwsSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

// The complete claim surface of a minted token (ADR-0066 §3). strictObject makes claim
// widening a parse failure: no email, no device identifiers, no health fields ever transit
// the credential layer. role is pinned to 'authenticated' — a service_role-shaped claim
// set is unrepresentable. iat/nbf/exp are RFC 7519 NumericDate epoch seconds, deliberately
// not the repo's epoch-ms convention: the token must verify against PostgREST unmodified.
export const mintClaimsSchema = z
  .strictObject({
    sub: z.string().min(1),
    role: z.literal('authenticated'),
    aud: z.literal('authenticated'),
    iss: z.literal(MINT_ISSUER),
    iat: z.int().nonnegative(),
    nbf: z.int().nonnegative(),
    exp: z.int().nonnegative(),
    actor: z.literal('do-agent'),
  })
  .refine((c) => c.exp === c.iat + MINT_JWT_TTL_SECONDS, {
    error: 'exp must equal iat + 60 minutes',
    path: ['exp'],
  })
  .refine((c) => c.nbf === c.iat - MINT_NBF_BACKDATE_SECONDS, {
    error: 'nbf must equal iat - 60 seconds',
    path: ['nbf'],
  });
export type MintClaims = z.infer<typeof mintClaimsSchema>;

// ES256 third-party issuer — the ratified path: the EF signs, Supabase trusts a registered
// HTTPS issuer whose public JWKS PostgREST fetches and caches. De-registering the key kills
// every DO-minted token fleet-wide within one JWKS cache-TTL window — bounded, not instant.
export const es256IssuerConfigSchema = z.strictObject({
  alg: z.literal('ES256'),
  issuer_url: z.url({ protocol: /^https$/ }),
  jwks_cache_ttl_seconds: z.int().positive(),
});
export type Es256IssuerConfig = z.infer<typeof es256IssuerConfigSchema>;

// HS256 signs with the project's legacy shared secret, which signs EVERY role — a
// compromised mint EF on this path can forge service_role (full RLS bypass). Audited
// contingency only; MUST NOT ship to production. The literal(true) acknowledgement makes
// an unmarked HS256 config unrepresentable, so it can never be a silent default.
export const hs256ContingencyConfigSchema = z.strictObject({
  alg: z.literal('HS256'),
  audited_contingency_only: z.literal(true),
});
export type Hs256ContingencyConfig = z.infer<typeof hs256ContingencyConfigSchema>;

export const mintSigningConfigSchema = z.discriminatedUnion('alg', [
  es256IssuerConfigSchema,
  hs256ContingencyConfigSchema,
]);
export type MintSigningConfig = z.infer<typeof mintSigningConfigSchema>;

// /bootstrap — user present, once per app auth. Authenticated by the user's real Supabase
// Auth session JWT plus the Worker-tier gateway HMAC, so a stolen session JWT alone cannot
// be escalated into a standing credential.
export const mintBootstrapRequestSchema = z.strictObject({
  session_jwt: compactJwsSchema,
  gateway_hmac: z.string().min(1),
});
export type MintBootstrapRequest = z.infer<typeof mintBootstrapRequestSchema>;

export const mintBootstrapResponseSchema = z.strictObject({
  mint_key: z.string().min(1),
  rls_jwt: compactJwsSchema,
});
export type MintBootstrapResponse = z.infer<typeof mintBootstrapResponseSchema>;

// /refresh — steady state, user absent. The caller proves custody of the current mint key;
// sub is pinned server-side to the stored row, so the caller can never choose the subject.
export const mintRefreshRequestSchema = z.strictObject({
  user_id: z.string().min(1),
  mint_key: z.string().min(1),
  gateway_hmac: z.string().min(1),
});
export type MintRefreshRequest = z.infer<typeof mintRefreshRequestSchema>;

// next_key is the rotate-on-use carrier (RFC 9700 §4.14.2): presenting current replays the
// same next key; presenting next promotes it; presenting a retired key revokes. A response
// without next_key would freeze rotation, so the field is required.
export const mintRefreshResponseSchema = z.strictObject({
  rls_jwt: compactJwsSchema,
  next_key: z.string().min(1),
});
export type MintRefreshResponse = z.infer<typeof mintRefreshResponseSchema>;
