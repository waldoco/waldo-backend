import {
  createOidcHandler,
  createSupabaseIdentityVerifier,
} from '../../../packages/mint-agent-jwt/src/index.ts';

const projectUrl = Deno.env.get('SUPABASE_URL');
const proofEnabled = Deno.env.get('HEY125_PROOF_ENABLED') === 'true';
const publishableKey = Deno.env.get('SUPABASE_ANON_KEY');
const registeredKid = 'cOhuxITY6ZJzBPSDIYRJtfZFmx3IEgG7eAYeobtyHZI';
const registeredIssuer =
  'https://oqcjjcytjvrckvylagsl.supabase.co/functions/v1/mint-agent-jwt';

if (!projectUrl) {
  throw new Error('SUPABASE_URL is required');
}
if (proofEnabled && !publishableKey) {
  throw new Error('SUPABASE_ANON_KEY is required for the HEY-125 proof');
}

const issuerUrl = `${projectUrl.replace(/\/$/, '')}/functions/v1/mint-agent-jwt`;
if (issuerUrl !== registeredIssuer) {
  throw new Error('SUPABASE_URL does not match the registered HEY-125 issuer');
}
const verifyIdentity = publishableKey
  ? createSupabaseIdentityVerifier({ projectUrl, publishableKey })
  : undefined;

Deno.serve(
  createOidcHandler({
    issuerUrl,
    privateJwkJson: Deno.env.get('MINT_ES256_PRIVATE_JWK'),
    requiredKid: registeredKid,
    stagingProof:
      proofEnabled && verifyIdentity
        ? { enabled: true, verifyIdentity }
        : undefined,
  }),
);
