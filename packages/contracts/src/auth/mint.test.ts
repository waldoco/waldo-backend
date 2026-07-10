// ADR-0066 — DO→Supabase per-user RLS JWT custody (spike-gated ES256 issuer path).
// Invariants under test: the minted claim surface is minimal and exact (sub/role/aud/iss/
// iat/nbf/exp/actor, nothing else); the refresh response always carries next_key (the
// rotate-on-use carrier); HS256 is representable only as an explicitly acknowledged audited
// contingency, never a default; ES256 config pins a registered HTTPS issuer and a JWKS
// cache TTL; TTL/margin/failure-status constants match the ADR-pinned values.
// Failure modes caught: claim-surface widening (PII or health fields entering the
// credential layer), a service_role-shaped claim set parsing as a mint claim, a silent
// HS256 default, next_key drift freezing rotation, constant drift against ADR-0066 §4.
import { describe, expect, it } from 'vitest';
import {
  compactJwsSchema,
  es256IssuerConfigSchema,
  MINT_FAILURE_STATUS,
  MINT_ISSUER,
  MINT_JWT_TTL_MIN,
  MINT_REFRESH_MARGIN_MIN,
  mintBootstrapRequestSchema,
  mintBootstrapResponseSchema,
  mintClaimsSchema,
  mintRefreshRequestSchema,
  mintRefreshResponseSchema,
  mintSigningConfigSchema,
} from './mint';

const jws = 'aaa.bbb.ccc';

const baseClaims = {
  sub: 'user-1',
  role: 'authenticated',
  aud: 'authenticated',
  iss: 'https://oqcjjcytjvrckvylagsl.supabase.co/functions/v1/mint-agent-jwt',
  iat: 1_700_000_000,
  nbf: 1_699_999_940,
  exp: 1_700_003_600,
  actor: 'do-agent',
} as const;

const baseEs256 = {
  alg: 'ES256',
  issuer_url: 'https://mint.example.com',
  jwks_cache_ttl_seconds: 600,
} as const;

describe('mintClaims', () => {
  it('accepts the exact ADR-0066 claim surface', () => {
    expect(mintClaimsSchema.safeParse(baseClaims).success).toBe(true);
  });

  it('rejects a widened claim surface (no email/device/health claims)', () => {
    expect(mintClaimsSchema.safeParse({ ...baseClaims, email: 'a@b.example' }).success).toBe(
      false,
    );
  });

  it('rejects a service_role-shaped claim set', () => {
    expect(mintClaimsSchema.safeParse({ ...baseClaims, role: 'service_role' }).success).toBe(
      false,
    );
  });

  it('rejects a non-canonical issuer', () => {
    expect(mintClaimsSchema.safeParse({ ...baseClaims, iss: 'supabase-auth' }).success).toBe(
      false,
    );
  });

  it('rejects a non-agent actor', () => {
    expect(mintClaimsSchema.safeParse({ ...baseClaims, actor: 'user' }).success).toBe(false);
  });

  it('rejects a missing actor claim (forensic separation is load-bearing)', () => {
    const { actor: _actor, ...withoutActor } = baseClaims;
    expect(mintClaimsSchema.safeParse(withoutActor).success).toBe(false);
  });

  it('rejects exp not after iat', () => {
    expect(mintClaimsSchema.safeParse({ ...baseClaims, exp: baseClaims.iat }).success).toBe(
      false,
    );
  });

  it('rejects a token lifetime longer than the ADR-0066 60-minute TTL', () => {
    expect(
      mintClaimsSchema.safeParse({ ...baseClaims, exp: baseClaims.iat + 3_601 }).success,
    ).toBe(false);
  });

  it('rejects an nbf that is not the ADR-0066 60-second clock-skew backdate', () => {
    expect(
      mintClaimsSchema.safeParse({ ...baseClaims, nbf: baseClaims.iat - 30 }).success,
    ).toBe(false);
  });

  it('rejects a non-integer NumericDate', () => {
    expect(mintClaimsSchema.safeParse({ ...baseClaims, iat: 1_700_000_000.5 }).success).toBe(
      false,
    );
  });
});

describe('mintSigningConfig', () => {
  it('accepts the ES256 registered-issuer shape', () => {
    expect(mintSigningConfigSchema.safeParse(baseEs256).success).toBe(true);
  });

  it('rejects a non-HTTPS issuer_url', () => {
    expect(
      es256IssuerConfigSchema.safeParse({ ...baseEs256, issuer_url: 'http://mint.example.com' })
        .success,
    ).toBe(false);
  });

  it('rejects a zero JWKS cache TTL', () => {
    expect(
      es256IssuerConfigSchema.safeParse({ ...baseEs256, jwks_cache_ttl_seconds: 0 }).success,
    ).toBe(false);
  });

  it('accepts HS256 only as an explicitly marked audited contingency', () => {
    expect(
      mintSigningConfigSchema.safeParse({ alg: 'HS256', audited_contingency_only: true })
        .success,
    ).toBe(true);
  });

  it('rejects HS256 without the audited-contingency acknowledgement', () => {
    expect(mintSigningConfigSchema.safeParse({ alg: 'HS256' }).success).toBe(false);
  });

  it('rejects HS256 with the acknowledgement set to false', () => {
    expect(
      mintSigningConfigSchema.safeParse({ alg: 'HS256', audited_contingency_only: false })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown alg', () => {
    expect(
      mintSigningConfigSchema.safeParse({ ...baseEs256, alg: 'RS256' }).success,
    ).toBe(false);
  });

  it('rejects the contingency marker leaking onto the ES256 branch', () => {
    expect(
      mintSigningConfigSchema.safeParse({ ...baseEs256, audited_contingency_only: true })
        .success,
    ).toBe(false);
  });
});

describe('bootstrap contract', () => {
  it('accepts a session-JWT + gateway-HMAC request', () => {
    expect(
      mintBootstrapRequestSchema.safeParse({ session_jwt: jws, gateway_hmac: 'hmac-1' })
        .success,
    ).toBe(true);
  });

  it('rejects a request missing the gateway HMAC', () => {
    expect(mintBootstrapRequestSchema.safeParse({ session_jwt: jws }).success).toBe(false);
  });

  it('rejects a non-JWS session_jwt', () => {
    expect(
      mintBootstrapRequestSchema.safeParse({ session_jwt: 'not-a-jwt', gateway_hmac: 'hmac-1' })
        .success,
    ).toBe(false);
  });

  it('accepts a mint-key + first-RLS-JWT response', () => {
    expect(
      mintBootstrapResponseSchema.safeParse({ mint_key: 'key-1', rls_jwt: jws }).success,
    ).toBe(true);
  });

  it('rejects a response with an extra field', () => {
    expect(
      mintBootstrapResponseSchema.safeParse({ mint_key: 'key-1', rls_jwt: jws, user_id: 'u' })
        .success,
    ).toBe(false);
  });
});

describe('refresh contract', () => {
  it('accepts a (user_id, mint_key, gateway_hmac) request', () => {
    expect(
      mintRefreshRequestSchema.safeParse({
        user_id: 'user-1',
        mint_key: 'key-1',
        gateway_hmac: 'hmac-1',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty mint_key', () => {
    expect(
      mintRefreshRequestSchema.safeParse({
        user_id: 'user-1',
        mint_key: '',
        gateway_hmac: 'hmac-1',
      }).success,
    ).toBe(false);
  });

  it('accepts an RLS-JWT + next_key response', () => {
    expect(
      mintRefreshResponseSchema.safeParse({ rls_jwt: jws, next_key: 'key-2' }).success,
    ).toBe(true);
  });

  it('rejects a refresh response without next_key (rotation carrier)', () => {
    expect(mintRefreshResponseSchema.safeParse({ rls_jwt: jws }).success).toBe(false);
  });
});

describe('compactJws', () => {
  it('accepts three base64url segments', () => {
    expect(compactJwsSchema.safeParse(jws).success).toBe(true);
  });

  it('rejects the wrong segment count', () => {
    expect(compactJwsSchema.safeParse('aaa.bbb').success).toBe(false);
    expect(compactJwsSchema.safeParse('aaa.bbb.ccc.ddd').success).toBe(false);
  });
});

describe('ADR-pinned constants', () => {
  it('issuer is the exact registered HEY-125 HTTPS issuer', () => {
    expect(MINT_ISSUER).toBe(
      'https://oqcjjcytjvrckvylagsl.supabase.co/functions/v1/mint-agent-jwt',
    );
  });

  it('TTL 60 min and refresh margin 20 min (15-min handler ceiling + 5 skew)', () => {
    expect(MINT_JWT_TTL_MIN).toBe(60);
    expect(MINT_REFRESH_MARGIN_MIN).toBe(20);
    expect(MINT_REFRESH_MARGIN_MIN).toBeLessThan(MINT_JWT_TTL_MIN);
  });

  it('uniform failure status is 403', () => {
    expect(MINT_FAILURE_STATUS).toBe(403);
  });
});
