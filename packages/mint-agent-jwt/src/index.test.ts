import { describe, expect, it } from 'vitest';
import { createOidcHandler, createSupabaseIdentityVerifier } from './index';

const issuerUrl =
  'https://oqcjjcytjvrckvylagsl.supabase.co/functions/v1/mint-agent-jwt';

describe('mint-agent-jwt public metadata', () => {
  it('serves discovery metadata for the exact stable issuer', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: undefined,
    });

    const response = await handle(
      new Request(`${issuerUrl}/.well-known/openid-configuration`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    await expect(response.json()).resolves.toEqual({
      issuer: issuerUrl,
      jwks_uri: `${issuerUrl}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['ES256'],
      subject_types_supported: ['public'],
    });
  });

  it('serves only the public projection of the configured ES256 key', async () => {
    const privateJwk = await createPrivateJwk('key-1');
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(privateJwk),
    });

    const response = await handle(
      new Request(`${issuerUrl}/.well-known/jwks.json`),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      keys: [
        {
          kty: 'EC',
          crv: 'P-256',
          x: privateJwk.x,
          y: privateJwk.y,
          kid: 'key-1',
          use: 'sig',
          alg: 'ES256',
          key_ops: ['verify'],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(privateJwk.d);
    expect(JSON.stringify(body)).not.toContain('"d"');
  });

  it.each([undefined, '{not-json}', JSON.stringify({ kty: 'EC' })])(
    'fails closed without disclosing invalid key material (%s)',
    async (privateJwkJson) => {
      const handle = createOidcHandler({ issuerUrl, privateJwkJson });

      const response = await handle(
        new Request(`${issuerUrl}/.well-known/jwks.json`),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual({
        error: 'issuer_unavailable',
      });
    },
  );

  it('returns stable public metadata across repeated reads', async () => {
    const privateJwk = await createPrivateJwk('stable-key');
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(privateJwk),
    });

    const first = await handle(
      new Request(`${issuerUrl}/.well-known/jwks.json`),
    );
    const second = await handle(
      new Request(`${issuerUrl}/.well-known/jwks.json`),
    );

    expect(await first.text()).toBe(await second.text());
  });

  it('rejects non-base64url and non-P-256-sized key material', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        x: 'x',
        y: 'y',
        d: 'd',
        kid: 'invalid-key',
        use: 'sig',
        alg: 'ES256',
        key_ops: ['sign'],
      }),
    });

    const response = await handle(
      new Request(`${issuerUrl}/.well-known/jwks.json`),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not serve metadata through nested suffix aliases', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(await createPrivateJwk('key-1')),
    });

    const response = await handle(
      new Request(`${issuerUrl}/attacker/.well-known/jwks.json`),
    );

    expect(response.status).toBe(404);
  });

  it('rejects non-GET access to public metadata routes', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: undefined,
    });

    const response = await handle(
      new Request(`${issuerUrl}/.well-known/openid-configuration`, {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    await expect(response.json()).resolves.toEqual({
      error: 'method_not_allowed',
    });
  });

  it('mints an ES256 proof token only for the verified session subject', async () => {
    const privateJwk = await createPrivateJwk('proof-key');
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(privateJwk),
      stagingProof: {
        enabled: true,
        verifyIdentity: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
        }),
        now: () => 1_700_000_000,
      },
    });

    const response = await handle(
      new Request(`${issuerUrl}/proof/mint`, {
        method: 'POST',
        headers: { authorization: 'Bearer session.jwt.value' },
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { rls_jwt: token } = (await response.json()) as { rls_jwt: string };
    const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
    expect(decodeJwtPart(encodedHeader)).toEqual({
      alg: 'ES256',
      typ: 'JWT',
      kid: 'proof-key',
    });
    expect(decodeJwtPart(encodedClaims)).toEqual({
      sub: '11111111-1111-4111-8111-111111111111',
      role: 'authenticated',
      aud: 'authenticated',
      iss: issuerUrl,
      iat: 1_700_000_000,
      nbf: 1_699_999_940,
      exp: 1_700_003_600,
      actor: 'do-agent',
    });
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { ...privateJwk, d: undefined, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    await expect(
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        fromBase64Url(encodedSignature).buffer as ArrayBuffer,
        new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
      ),
    ).resolves.toBe(true);
  });

  it('rejects every caller-supplied proof payload, including an arbitrary sub', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(await createPrivateJwk('proof-key')),
      stagingProof: {
        enabled: true,
        verifyIdentity: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
        }),
      },
    });

    const response = await handle(
      new Request(`${issuerUrl}/proof/mint`, {
        method: 'POST',
        headers: { authorization: 'Bearer session.jwt.value' },
        body: JSON.stringify({
          sub: '22222222-2222-4222-8222-222222222222',
          role: 'service_role',
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
  });

  it('rate-limits repeated proof mint attempts for the same credential', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(await createPrivateJwk('proof-key')),
      stagingProof: {
        enabled: true,
        verifyIdentity: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
        }),
        now: () => 1_700_000_000,
      },
    });
    const request = () =>
      new Request(`${issuerUrl}/proof/mint`, {
        method: 'POST',
        headers: { authorization: 'Bearer session.jwt.value' },
      });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await handle(request())).status).toBe(200);
    }
    const limited = await handle(request());

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('40');
    await expect(limited.json()).resolves.toEqual({ error: 'rate_limited' });
  });

  it('fails closed when the signing key kid is not the registered kid', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(await createPrivateJwk('unregistered-key')),
      requiredKid: 'registered-key',
      stagingProof: {
        enabled: true,
        verifyIdentity: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
        }),
      },
    });

    const response = await handle(
      new Request(`${issuerUrl}/proof/mint`, {
        method: 'POST',
        headers: { authorization: 'Bearer session.jwt.value' },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'issuer_unavailable',
    });
  });

  it('mints only the fixed expired variant for the authenticated expiry probe', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(await createPrivateJwk('proof-key')),
      stagingProof: {
        enabled: true,
        verifyIdentity: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
        }),
        now: () => 1_700_000_000,
      },
    });

    const response = await handle(
      new Request(`${issuerUrl}/proof/mint`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer session.jwt.value',
          'x-hey125-proof-case': 'expired',
        },
      }),
    );

    expect(response.status).toBe(200);
    const { rls_jwt: token } = (await response.json()) as { rls_jwt: string };
    const claims = decodeJwtPart(token.split('.')[1]);
    expect(claims).toEqual({
      sub: '11111111-1111-4111-8111-111111111111',
      role: 'authenticated',
      aud: 'authenticated',
      iss: issuerUrl,
      iat: 1_699_992_800,
      nbf: 1_699_992_740,
      exp: 1_699_996_400,
      actor: 'do-agent',
    });
  });

  it.each([
    { name: 'missing identity', verifyIdentity: async () => null },
    {
      name: 'invalid identity',
      verifyIdentity: async () => ({ id: 'not-a-supabase-auth-uuid' }),
    },
    {
      name: 'verification outage',
      verifyIdentity: async () => {
        throw new Error('auth unavailable');
      },
    },
  ])('fails closed on $name', async ({ verifyIdentity }) => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(await createPrivateJwk('proof-key')),
      stagingProof: { enabled: true, verifyIdentity },
    });

    const response = await handle(
      new Request(`${issuerUrl}/proof/mint`, {
        method: 'POST',
        headers: { authorization: 'Bearer session.jwt.value' },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'proof_denied' });
  });

  it('hides the proof route when the staging switch is disabled', async () => {
    const handle = createOidcHandler({
      issuerUrl,
      privateJwkJson: JSON.stringify(await createPrivateJwk('proof-key')),
    });

    const response = await handle(
      new Request(`${issuerUrl}/proof/mint`, { method: 'POST' }),
    );

    expect(response.status).toBe(404);
  });
});

describe('Supabase session identity verification', () => {
  it('derives only the user id from the fixed Auth user endpoint', async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const verifyIdentity = createSupabaseIdentityVerifier({
      projectUrl: 'https://oqcjjcytjvrckvylagsl.supabase.co',
      publishableKey: 'publishable-test-key',
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return Response.json({
          id: '11111111-1111-4111-8111-111111111111',
          user_metadata: { attempted_role: 'service_role' },
        });
      },
    });

    await expect(verifyIdentity('session.jwt.value')).resolves.toEqual({
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      'https://oqcjjcytjvrckvylagsl.supabase.co/auth/v1/user',
    );
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
      'Bearer session.jwt.value',
    );
    expect(new Headers(calls[0]?.init?.headers).get('apikey')).toBe(
      'publishable-test-key',
    );
  });

  it.each([
    Response.json({ id: '11111111-1111-4111-8111-111111111111' }, { status: 401 }),
    Response.json({ id: 'not-a-uuid' }),
    Response.json({}),
  ])('fails closed for rejected or malformed Auth responses', async (authResponse) => {
    const verifyIdentity = createSupabaseIdentityVerifier({
      projectUrl: 'https://oqcjjcytjvrckvylagsl.supabase.co',
      publishableKey: 'publishable-test-key',
      fetch: async () => authResponse.clone(),
    });

    await expect(verifyIdentity('session.jwt.value')).resolves.toBeNull();
  });
});

async function createPrivateJwk(kid: string) {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return {
    ...jwk,
    kid,
    use: 'sig',
    alg: 'ES256',
    key_ops: ['sign'],
  };
}

function decodeJwtPart(value: string | undefined): unknown {
  if (!value) throw new Error('missing JWT part');
  return JSON.parse(new TextDecoder().decode(fromBase64Url(value)));
}

function fromBase64Url(value: string | undefined): Uint8Array {
  if (!value) throw new Error('missing base64url value');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
