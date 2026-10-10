import { iMessageBridgeName, iMessageComposition, mintBridgeIdentity, type HostRoute, type IMessageBridgeDO, type IMessageEnv } from './bridge-do';
import { sha256Hex, wrapCredential } from './crypto';
import { iMessageDirectory } from './directory';
import { errorResponse, IMESSAGE_HTTP_PREFIX, invalidRequest, jsonResponse, parseJson, parseS2Header, readBoundedBody, redeemBodySchema } from './wire';

// Profile waldo-imessage-http-v1. Host routes only; owner console actions live in console.ts
// behind the owner session + CSRF and are never reachable with host S2 credentials.
const HOST_ROUTES: Record<string, HostRoute> = {
  '/events': 'events', '/heartbeat': 'heartbeat', '/capabilities': 'capabilities', '/commands/pull': 'commands/pull', '/commands/result': 'commands/result',
};
// PROPOSED redeem throttle windows (source: this connector's local profile), independent per key.
const REDEEM_THROTTLES = [{ prefix: 'imredeem.code', limit: 5, seconds: 600 }, { prefix: 'imredeem.source', limit: 20, seconds: 3600 }] as const;

export const isIMessageHostPath = (pathname: string) => pathname.startsWith(IMESSAGE_HTTP_PREFIX + '/');

export async function handleIMessageHost(request: Request, env: IMessageEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const composition = iMessageComposition(env);
  // Feature off or incomplete composition: the surface does not exist (no memory fallback).
  if (!composition) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const url = new URL(request.url), suffix = url.pathname.slice(IMESSAGE_HTTP_PREFIX.length);
  if (suffix !== '/pair/redeem' && !HOST_ROUTES[suffix]) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed');
  // No secrets/codes in URLs: any query string is refused outright.
  if (url.search !== '') return invalidRequest();
  if ((request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') return errorResponse(415, 'unsupported_media_type');
  const raw = await readBoundedBody(request, composition.policy.maxRequestBytes);
  if (!raw.ok) return raw.status === 413 ? errorResponse(413, 'request_too_large') : errorResponse(400, 'invalid_body');
  if (suffix === '/pair/redeem') return redeem(request, raw.text, env, composition, fetcher);
  const headers = parseS2Header(request);
  if (!headers) return invalidRequest();
  const ns = env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO>;
  try {
    const stub = ns.get(ns.idFromName(iMessageBridgeName(composition.environment, headers.bridgeId, headers.accountId)));
    const reply = await stub.hostRequest(HOST_ROUTES[suffix]!, raw.text, headers);
    return new Response(reply.json, { status: reply.status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'application/json' } });
  } catch { return errorResponse(503, 'unavailable'); }
}

async function redeem(request: Request, text: string, env: IMessageEnv, composition: NonNullable<ReturnType<typeof iMessageComposition>>, fetcher: typeof fetch): Promise<Response> {
  // Setup is unsigned by design (no credential exists yet); request headers carry no authority.
  if (request.headers.has('x-waldo-imessage-s2')) return invalidRequest();
  const body = redeemBodySchema.safeParse(parseJson(text));
  if (!body.success) return invalidRequest();
  const directory = iMessageDirectory(env, fetcher);
  try {
    const codeHash = await sha256Hex(body.data.code), sourceHash = await sha256Hex(request.headers.get('cf-connecting-ip') ?? 'local');
    for (const t of REDEEM_THROTTLES)
      if (!await directory.throttle(`${t.prefix}.${t.prefix === 'imredeem.code' ? codeHash : sourceHash}`, t.limit, t.seconds)) return errorResponse(429, 'throttled');
    const identity = mintBridgeIdentity();
    const wrapped = await wrapCredential(identity.key, { environment: composition.environment, bridgeId: identity.bridgeId, accountId: identity.accountId, revision: '1' }, composition.wrappingKey);
    const redeemed = await directory.redeemInvitation({ codeHash, environment: composition.environment, bridgeId: identity.bridgeId, accountId: identity.accountId,
      wrappedCredential: wrapped, hostVersion: body.data.hostVersion, transportVersion: body.data.transportVersion, generation: body.data.databaseGeneration, pendingSeconds: Math.floor(composition.policy.setupLifetimeMs / 1000) });
    if (!redeemed) return invalidRequest();
    // Returned exactly once; a lost response needs a fresh invitation.
    return jsonResponse(200, { version: 1, state: 'pending_verification', bridgeId: identity.bridgeId, accountId: identity.accountId,
      credential: { kind: 'hmac-sha256', key: identity.key }, expiresAtMs: redeemed.expiresAtMs });
  } catch { return errorResponse(503, 'unavailable'); }
}
