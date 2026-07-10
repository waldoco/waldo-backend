export interface OidcHandlerConfig {
  issuerUrl: string;
  privateJwkJson: string | undefined;
  requiredKid?: string;
  stagingProof?: {
    enabled: boolean;
    verifyIdentity: (accessToken: string) => Promise<{ id: string } | null>;
    now?: () => number;
  };
}

export function createSupabaseIdentityVerifier(config: {
  projectUrl: string;
  publishableKey: string;
  fetch?: typeof fetch;
}) {
  const projectUrl = new URL(config.projectUrl);
  if (projectUrl.protocol !== 'https:' || !config.publishableKey) {
    throw new Error('Invalid Supabase identity verifier configuration');
  }
  const userEndpoint = new URL('/auth/v1/user', projectUrl).toString();
  const fetcher = config.fetch ?? fetch;

  return async function verifyIdentity(accessToken: string) {
    try {
      const response = await fetcher(userEndpoint, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          apikey: config.publishableKey,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') return null;
      const id = (body as Record<string, unknown>).id;
      return typeof id === 'string' && isUuid(id) ? { id } : null;
    } catch {
      return null;
    }
  };
}

export function createOidcHandler(config: OidcHandlerConfig) {
  const issuer = config.issuerUrl.replace(/\/$/, '');
  const issuerPath = new URL(issuer).pathname.replace(/\/$/, '');
  const functionName = issuerPath.split('/').filter(Boolean).at(-1);
  const acceptedBasePaths = new Set([
    issuerPath,
    ...(functionName ? [`/${functionName}`] : []),
  ]);
  const discoveryPaths = new Set(
    [...acceptedBasePaths].map(
      (basePath) => `${basePath}/.well-known/openid-configuration`,
    ),
  );
  const jwksPaths = new Set(
    [...acceptedBasePaths].map(
      (basePath) => `${basePath}/.well-known/jwks.json`,
    ),
  );
  const proofPaths = new Set(
    [...acceptedBasePaths].map((basePath) => `${basePath}/proof/mint`),
  );
  const signingMaterialPromise = signingMaterialFromPrivate(
    config.privateJwkJson,
    config.requiredKid,
  );
  const proofLimiter = createProofLimiter(
    config.stagingProof?.now ?? (() => Math.floor(Date.now() / 1000)),
  );

  return async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const isDiscoveryPath = discoveryPaths.has(path);
    const isJwksPath = jwksPaths.has(path);
    const isProofPath = proofPaths.has(path);
    const isMetadataPath = isDiscoveryPath || isJwksPath;

    if (request.method !== 'GET' && isMetadataPath) {
      return jsonResponse(
        { error: 'method_not_allowed' },
        405,
        'no-store',
        { allow: 'GET' },
      );
    }

    if (
      request.method === 'GET' &&
      isDiscoveryPath
    ) {
      return jsonResponse({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        id_token_signing_alg_values_supported: ['ES256'],
        subject_types_supported: ['public'],
      });
    }

    if (request.method === 'GET' && isJwksPath) {
      const signingMaterial = await signingMaterialPromise;
      if (!signingMaterial) {
        return jsonResponse({ error: 'issuer_unavailable' }, 503, 'no-store');
      }
      return jsonResponse({ keys: [signingMaterial.publicJwk] });
    }

    if (config.stagingProof?.enabled && isProofPath) {
      if (request.method !== 'POST') {
        return jsonResponse(
          { error: 'method_not_allowed' },
          405,
          'no-store',
          { allow: 'POST' },
        );
      }
      if (!(await hasEmptyBody(request))) {
        return jsonResponse({ error: 'invalid_request' }, 400, 'no-store');
      }
      const proofCase = request.headers.get('x-hey125-proof-case');
      if (proofCase !== null && proofCase !== 'expired') {
        return jsonResponse({ error: 'invalid_request' }, 400, 'no-store');
      }

      const accessToken = bearerToken(request.headers.get('authorization'));
      if (!accessToken) {
        return jsonResponse({ error: 'proof_denied' }, 403, 'no-store');
      }
      const rateLimit = await proofLimiter.check(accessToken);
      if (!rateLimit.allowed) {
        return jsonResponse(
          { error: 'rate_limited' },
          429,
          'no-store',
          { 'retry-after': String(rateLimit.retryAfterSeconds) },
        );
      }

      let identity: { id: string } | null;
      try {
        identity = await config.stagingProof.verifyIdentity(accessToken);
      } catch {
        return jsonResponse({ error: 'proof_denied' }, 403, 'no-store');
      }
      if (!identity || !isUuid(identity.id)) {
        return jsonResponse({ error: 'proof_denied' }, 403, 'no-store');
      }

      const signingMaterial = await signingMaterialPromise;
      if (!signingMaterial) {
        return jsonResponse({ error: 'issuer_unavailable' }, 503, 'no-store');
      }
      const now = config.stagingProof.now?.() ?? Math.floor(Date.now() / 1000);
      const issuedAt = proofCase === 'expired' ? now - 7_200 : now;
      const rlsJwt = await signJwt(
        signingMaterial.privateKey,
        signingMaterial.kid,
        {
          sub: identity.id,
          role: 'authenticated',
          aud: 'authenticated',
          iss: issuer,
          iat: issuedAt,
          nbf: issuedAt - 60,
          exp: issuedAt + 3_600,
          actor: 'do-agent',
        },
      );
      return jsonResponse({ rls_jwt: rlsJwt }, 200, 'no-store');
    }

    return jsonResponse({ error: 'not_found' }, 404, 'no-store');
  };
}

async function signingMaterialFromPrivate(
  privateJwkJson: string | undefined,
  requiredKid: string | undefined,
) {
  if (!privateJwkJson) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(privateJwkJson);
    if (!isPrivateEs256Jwk(value)) {
      return null;
    }
    if (requiredKid && value.kid !== requiredKid) {
      return null;
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      value,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    return {
      privateKey,
      kid: value.kid,
      publicJwk: {
        kty: value.kty,
        crv: value.crv,
        x: value.x,
        y: value.y,
        kid: value.kid,
        use: value.use,
        alg: value.alg,
        key_ops: ['verify'],
      },
    };
  } catch {
    return null;
  }
}

function bearerToken(header: string | null): string | null {
  if (!header || header.length > 8_192) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    header,
  );
  return match?.[1] ?? null;
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) return contentLength === '0';
  if (!request.body) return true;

  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done) await reader.cancel();
    return first.done;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The request is already rejected; cancellation is best-effort cleanup only.
    }
    return false;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, string | number>,
): Promise<string> {
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })),
  );
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createProofLimiter(now: () => number) {
  const perCredential = new Map<string, number>();
  let windowStart = Math.floor(now() / 60) * 60;
  let globalCount = 0;

  return {
    async check(accessToken: string) {
      const current = now();
      if (current >= windowStart + 60) {
        windowStart = Math.floor(current / 60) * 60;
        globalCount = 0;
        perCredential.clear();
      }
      const retryAfterSeconds = Math.max(1, windowStart + 60 - current);
      if (globalCount >= 60) {
        return { allowed: false, retryAfterSeconds } as const;
      }
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(accessToken),
      );
      const fingerprint = toBase64Url(new Uint8Array(digest));
      const credentialCount = perCredential.get(fingerprint) ?? 0;
      if (credentialCount >= 5) {
        return { allowed: false, retryAfterSeconds } as const;
      }
      globalCount += 1;
      perCredential.set(fingerprint, credentialCount + 1);
      return { allowed: true, retryAfterSeconds: 0 } as const;
    },
  };
}

interface PrivateEs256Jwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
  kid: string;
  use: 'sig';
  alg: 'ES256';
  key_ops: ['sign'];
}

function isPrivateEs256Jwk(value: unknown): value is PrivateEs256Jwk {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const jwk = value as Record<string, unknown>;
  return (
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    isP256Coordinate(jwk.x) &&
    typeof jwk.y === 'string' &&
    isP256Coordinate(jwk.y) &&
    typeof jwk.d === 'string' &&
    isP256Coordinate(jwk.d) &&
    typeof jwk.kid === 'string' &&
    jwk.kid.length > 0 &&
    jwk.use === 'sig' &&
    jwk.alg === 'ES256' &&
    Array.isArray(jwk.key_ops) &&
    jwk.key_ops.length === 1 &&
    jwk.key_ops[0] === 'sign'
  );
}

function isP256Coordinate(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function jsonResponse(
  body: unknown,
  status = 200,
  cacheControl = 'public, max-age=300',
  additionalHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      ...Object.fromEntries(new Headers(additionalHeaders)),
    },
  });
}
