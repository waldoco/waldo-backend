import { describe, expect, it } from 'vitest';
import { createSupabaseResponsibilityAuthority } from '../src/responsibility/supabase-authority';

const authorityMetadata = {
  owner_id: 'owner_server_01',
  presence_id: 'presence_server_01',
  presence_registration_id: 'presence_registration_01',
  owner_policy_revision: 7,
  owner_root_routing_version: 2,
  state: 'active',
  expires_at: '2026-08-07T00:00:00.000Z',
};

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

function token(
  signature = 'signature',
  session: string | undefined = sessionId,
  claimOverrides: Record<string, unknown> = {},
): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  return `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({
    sub: userId, session_id: session, exp: 1_786_070_400, ...claimOverrides,
  })}.${signature}`;
}

function authRequest(header = `Bearer ${token()}`): Request {
  return new Request('https://api.heywaldo.com/public/responsibilities', {
    headers: { authorization: header },
  });
}

describe('Supabase responsibility authority', () => {
  it('derives only registered responsibility authority from a live Auth user response', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        if (String(input).endsWith('/rest/v1/rpc/waldo_responsibility_session_active')) {
          expect(init?.method).toBe('POST');
          expect(init?.body).toBe('{}');
          return Response.json(true);
        }
        return Response.json({
          id: userId,
          app_metadata: { waldo_responsibility_authority: authorityMetadata },
          user_metadata: { owner_id: 'owner_attacker', role: 'service_role' },
        });
      },
    });

    await expect(authority.authenticate(authRequest())).resolves.toEqual({
      ownerId: authorityMetadata.owner_id,
      actor: { kind: 'presence', id: authorityMetadata.presence_id },
      presenceId: authorityMetadata.presence_id,
      presenceRegistrationId: authorityMetadata.presence_registration_id,
      authenticatedSessionId: expect.stringMatching(/^authenticated_session_[a-f0-9]{64}$/),
      ownerPolicyRevision: 7,
      authAssurance: 'supabase_verified_session',
      ownerRootRoutingVersion: 2,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://project.supabase.co/auth/v1/user');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${token()}`);
    expect(calls[0]!.headers.get('apikey')).toBe('publishable-key');
    expect(calls[1]!.url).toBe(
      'https://project.supabase.co/rest/v1/rpc/waldo_responsibility_session_active',
    );
    expect(calls[1]!.headers.get('authorization')).toBe(`Bearer ${token()}`);
    expect(calls[1]!.headers.get('apikey')).toBe('publishable-key');
  });

  it('keeps the authenticated session identity stable across access-token rotation', async () => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input) => String(input).endsWith(
        '/rest/v1/rpc/waldo_responsibility_session_active',
      )
        ? Response.json(true)
        : Response.json({
            id: userId,
            app_metadata: { waldo_responsibility_authority: authorityMetadata },
          }),
    });
    const first = await authority.authenticate(authRequest(`Bearer ${token('signature-one')}`));
    const rotated = await authority.authenticate(authRequest(`Bearer ${token('signature-two')}`));
    expect(rotated?.authenticatedSessionId).toBe(first?.authenticatedSessionId);
  });

  it('denies an otherwise valid user when the active-session adapter returns false', async () => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input) => String(input).endsWith(
        '/rest/v1/rpc/waldo_responsibility_session_active',
      )
        ? Response.json(false)
        : Response.json({
            id: userId,
            app_metadata: { waldo_responsibility_authority: authorityMetadata },
          }),
    });

    await expect(authority.authenticate(authRequest())).resolves.toBeNull();
  });

  it('fails closed as unavailable when the active-session oracle cannot be reached', async () => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input) => {
        if (String(input).endsWith('/rest/v1/rpc/waldo_responsibility_session_active')) {
          throw new Error('session oracle unavailable');
        }
        return Response.json({
          id: userId,
          app_metadata: { waldo_responsibility_authority: authorityMetadata },
        });
      },
    });

    await expect(authority.authenticate(authRequest()))
      .rejects.toThrow('responsibility authority unavailable');
  });

  it('fails closed as unavailable when the active-session oracle returns a non-boolean body', async () => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input) => String(input).endsWith(
        '/rest/v1/rpc/waldo_responsibility_session_active',
      )
        ? Response.json({ active: true })
        : Response.json({
            id: userId,
            app_metadata: { waldo_responsibility_authority: authorityMetadata },
          }),
    });

    await expect(authority.authenticate(authRequest()))
      .rejects.toThrow('responsibility authority unavailable');
  });

  it.each([
    ['subject mismatch', token('signature', sessionId, { sub: '33333333-3333-4333-8333-333333333333' })],
    ['missing session claim', token('signature', sessionId, { session_id: undefined })],
    ['locally expired token', token('signature', sessionId, { exp: 1 })],
  ])('denies %s before calling the active-session oracle', async (_name, accessToken) => {
    let oracleCalls = 0;
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input) => {
        if (String(input).endsWith('/rest/v1/rpc/waldo_responsibility_session_active')) {
          oracleCalls += 1;
          return Response.json(true);
        }
        return Response.json({
          id: userId,
          app_metadata: { waldo_responsibility_authority: authorityMetadata },
        });
      },
    });

    await expect(authority.authenticate(authRequest(`Bearer ${accessToken}`)))
      .resolves.toBeNull();
    expect(oracleCalls).toBe(0);
  });

  it.each([401, 403])('maps active-session oracle %s to an authentication denial', async (status) => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input) => String(input).endsWith(
        '/rest/v1/rpc/waldo_responsibility_session_active',
      )
        ? new Response(null, { status })
        : Response.json({
            id: userId,
            app_metadata: { waldo_responsibility_authority: authorityMetadata },
          }),
    });

    await expect(authority.authenticate(authRequest())).resolves.toBeNull();
  });

  it('maps an active-session oracle 5xx to authority unavailability', async () => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async (input) => String(input).endsWith(
        '/rest/v1/rpc/waldo_responsibility_session_active',
      )
        ? new Response(null, { status: 503 })
        : Response.json({
            id: userId,
            app_metadata: { waldo_responsibility_authority: authorityMetadata },
          }),
    });

    await expect(authority.authenticate(authRequest()))
      .rejects.toThrow('responsibility authority unavailable');
  });

  it.each([
    ['missing bearer', authRequest('Basic wrong')],
    ['malformed bearer', authRequest('Bearer token with spaces')],
  ])('denies %s without contacting Auth', async (_name, request) => {
    let calls = 0;
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      fetch: async () => { calls += 1; return Response.json({}); },
    });
    await expect(authority.authenticate(request)).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it.each([
    ['expired session', Response.json({}, { status: 401 })],
    ['revoked presence', Response.json({ id: '11111111-1111-4111-8111-111111111111', app_metadata: { waldo_responsibility_authority: { ...authorityMetadata, state: 'revoked' } } })],
    ['expired presence', Response.json({ id: '11111111-1111-4111-8111-111111111111', app_metadata: { waldo_responsibility_authority: { ...authorityMetadata, expires_at: '2026-08-06T11:59:59.000Z' } } })],
    ['missing policy', Response.json({ id: '11111111-1111-4111-8111-111111111111', app_metadata: { waldo_responsibility_authority: { ...authorityMetadata, owner_policy_revision: undefined } } })],
  ])('denies %s', async (_name, authResponse) => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      fetch: async () => authResponse.clone(),
    });
    await expect(authority.authenticate(authRequest())).resolves.toBeNull();
  });

  it('treats Auth transport failure as unavailable rather than an invalid identity', async () => {
    const authority = createSupabaseResponsibilityAuthority({
      projectUrl: 'https://project.supabase.co', publishableKey: 'publishable-key',
      fetch: async () => { throw new Error('network unavailable'); },
    });
    await expect(authority.authenticate(authRequest())).rejects.toThrow('responsibility authority unavailable');
  });
});
