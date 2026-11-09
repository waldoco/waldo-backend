import { z } from 'zod';
import { iMessageResultSchema, opaqueIMessageIdSchema as id } from '@waldo/contracts';
import type { S2Headers } from './crypto';

export const IMESSAGE_HTTP_PREFIX = '/channels/imessage/v1';
export const S2_HEADER = 'x-waldo-imessage-s2';

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const scope = { version: z.literal(1), bridgeId: id, accountId: id };

export const s2HeaderSchema = z.strictObject({ ...scope, atMs: z.int().nonnegative(), nonce: id, signature: hex64 });
export const heartbeatBodySchema = z.strictObject({ ...scope, databaseGeneration: id, status: z.enum(['online', 'offline']) });
export const pullBodySchema = z.strictObject(scope);
export const resultBodySchema = z.strictObject({ ...scope, deliveryId: id, commandId: id, commandDigest: hex64, result: iMessageResultSchema });
export const redeemBodySchema = z.strictObject({
  version: z.literal(1), code: z.string().regex(/^wim_[a-f0-9]{48}$/), hostVersion: id, transportVersion: id, databaseGeneration: id,
});

export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>;
export type PullBody = z.infer<typeof pullBodySchema>;
export type ResultBody = z.infer<typeof resultBodySchema>;
export type RedeemBody = z.infer<typeof redeemBodySchema>;

/** Exactly one S2 header value with a strict JSON object; duplicates and combined values reject. */
export const parseS2Header = (request: Request): S2Headers | null => {
  const raw = request.headers.get(S2_HEADER);
  // Headers.get joins repeated fields with ", " which can never be one strict JSON object.
  if (raw === null || raw.length > 1024) return null;
  try {
    const parsed = s2HeaderSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as S2Headers) : null;
  } catch { return null; }
};

export type RawBody = { ok: true; text: string } | { ok: false; status: 413 | 400 };

/** Reads at most maxBytes of UTF-8, refusing before buffering more. Never parses. */
export const readBoundedBody = async (request: Request, maxBytes: number): Promise<RawBody> => {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return { ok: false, status: 413 };
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, text: '' };
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); return { ok: false, status: 413 }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }; }
  catch { return { ok: false, status: 400 }; }
};

export const parseJson = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return undefined; }
};

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'application/json' };
/** Fixed diagnostics only: never private bodies, handles, GUIDs, keys or signatures. */
export const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: NO_STORE });
export const invalidRequest = () => jsonResponse(401, { error: 'invalid_request' });
export const errorResponse = (status: 400 | 405 | 409 | 413 | 415 | 429 | 503, code: string) => jsonResponse(status, { error: code });
