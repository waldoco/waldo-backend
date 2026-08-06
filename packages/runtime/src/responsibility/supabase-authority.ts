import type {
  ResponsibilityAuthority,
  TrustedResponsibilityContext,
} from './worker-adapter';

type SupabaseResponsibilityAuthorityConfig = Readonly<{
  projectUrl: string;
  publishableKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}>;

export function createSupabaseResponsibilityAuthority(
  config: SupabaseResponsibilityAuthorityConfig,
): ResponsibilityAuthority {
  const project = new URL(config.projectUrl);
  if (project.protocol !== 'https:' || config.publishableKey.trim().length === 0) {
    throw new Error('invalid responsibility authority configuration');
  }
  const endpoint = new URL('/auth/v1/user', project).toString();
  const activeSessionEndpoint = new URL(
    '/rest/v1/rpc/waldo_responsibility_session_active',
    project,
  ).toString();
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? Date.now;

  return {
    async authenticate(request): Promise<TrustedResponsibilityContext | null> {
      const token = bearerToken(request.headers.get('authorization'));
      if (token === null) return null;
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            apikey: config.publishableKey,
          },
          signal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        throw new Error('responsibility authority unavailable', { cause: error });
      }
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error('responsibility authority unavailable');

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      const authority = readAuthorityMetadata(body, now());
      if (authority === null) return null;
      const sessionId = verifiedSessionId(token, isRecord(body) ? body.id : null, now());
      if (sessionId === null) return null;
      const sessionActive = await readActiveSession({
        endpoint: activeSessionEndpoint,
        fetcher,
        publishableKey: config.publishableKey,
        token,
      });
      if (!sessionActive) return null;
      const sessionDigest = await sha256Hex(sessionId);
      return Object.freeze({
        ownerId: authority.owner_id,
        actor: Object.freeze({ kind: 'presence' as const, id: authority.presence_id }),
        presenceId: authority.presence_id,
        presenceRegistrationId: authority.presence_registration_id,
        authenticatedSessionId: `authenticated_session_${sessionDigest}`,
        ownerPolicyRevision: authority.owner_policy_revision,
        authAssurance: 'supabase_verified_session',
        ownerRootRoutingVersion: authority.owner_root_routing_version,
      });
    },
  };
}

async function readActiveSession(input: Readonly<{
  endpoint: string;
  fetcher: typeof fetch;
  publishableKey: string;
  token: string;
}>): Promise<boolean> {
  let response: Response;
  try {
    response = await input.fetcher(input.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        apikey: input.publishableKey,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error('responsibility authority unavailable', { cause: error });
  }
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error('responsibility authority unavailable');
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error('responsibility authority unavailable', { cause: error });
  }
  if (typeof body !== 'boolean') throw new Error('responsibility authority unavailable');
  return body;
}

function verifiedSessionId(token: string, verifiedUserId: unknown, now: number): string | null {
  if (typeof verifiedUserId !== 'string') return null;
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(segments[1]!))) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.sub !== verifiedUserId ||
      typeof payload.session_id !== 'string' || !isUuid(payload.session_id) ||
      !Number.isSafeInteger(payload.exp) || (payload.exp as number) <= Math.floor(now / 1_000)) {
    return null;
  }
  return payload.session_id;
}

type AuthorityMetadata = Readonly<{
  owner_id: string;
  presence_id: string;
  presence_registration_id: string;
  owner_policy_revision: number;
  owner_root_routing_version: number;
  state: 'active';
  expires_at: string;
}>;

function readAuthorityMetadata(body: unknown, now: number): AuthorityMetadata | null {
  if (!isRecord(body) || typeof body.id !== 'string' || !isUuid(body.id)) return null;
  if (!isRecord(body.app_metadata)) return null;
  const candidate = body.app_metadata.waldo_responsibility_authority;
  if (!isRecord(candidate)) return null;
  const expectedKeys = [
    'expires_at', 'owner_id', 'owner_policy_revision', 'owner_root_routing_version',
    'presence_id', 'presence_registration_id', 'state',
  ];
  if (Object.keys(candidate).sort().join('\0') !== expectedKeys.join('\0')) return null;
  if (
    !isProtocolId(candidate.owner_id) ||
    !isProtocolId(candidate.presence_id) ||
    !isProtocolId(candidate.presence_registration_id) ||
    !isRevision(candidate.owner_policy_revision) ||
    !isRevision(candidate.owner_root_routing_version) ||
    candidate.state !== 'active' ||
    typeof candidate.expires_at !== 'string'
  ) return null;
  const expiresAt = Date.parse(candidate.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return candidate as AuthorityMetadata;
}

function bearerToken(value: string | null): string | null {
  if (value === null) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]{16,8192})$/.exec(value);
  return match?.[1] ?? null;
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid JWT encoding');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isProtocolId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
