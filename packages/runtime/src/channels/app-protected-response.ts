import { appProtectedHealthPartV1Schema, appProtectedResponseQueryV1Schema, appProtectedResponseRefV1Schema, appProtectedResponseV1Schema, type AppProtectedHealthPartV1 } from '../../../contracts/src/app/protected';
import { redactSecretUrls } from './egress-guard';
import type { OwnerTurnResponse } from './owner-turn-response';

export type AppProtectedResponseBinding = Readonly<{
  principal_ref: string; session_ref: string; conversation_ref: string;
}>;
export type AppProtectedResponseMetadata = AppProtectedResponseBinding & Readonly<{
  response_ref: string; expires_at: number; part: AppProtectedHealthPartV1;
}>;
type VolatileRecord = Readonly<{ metadata: AppProtectedResponseMetadata; text: string; assertDeliveryCurrent(): Promise<void> }>;
const MAX_TTL_MS = 5 * 60 * 1000;
const MAX_TEXT_BYTES = 32768;
const currentBinding = (binding: AppProtectedResponseBinding) => {
  if (!/^prn_[a-f0-9]{32}$/.test(binding.principal_ref) || !/^sess_[a-f0-9]{64}$/.test(binding.session_ref)
    || !appProtectedResponseQueryV1Schema.safeParse({ conversation_ref: binding.conversation_ref }).success) throw new Error('Protected response binding invalid.');
};
const response = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store', 'pragma': 'no-cache' } });

// Construct once per owner runtime instance. Nothing in this Map, including model
// text or currentness closures, is serialized to DO storage, R2, traces or replay.
export const appProtectedResponses = (options: Readonly<{ now?(): number; ttlMs?: number; capacity?: number }> = {}) => {
  const records = new Map<string, VolatileRecord>();
  const now = options.now ?? Date.now;
  const ttl = Math.min(MAX_TTL_MS, Math.max(1, options.ttlMs ?? MAX_TTL_MS));
  const capacity = Math.min(16, Math.max(1, options.capacity ?? 8));
  const expire = () => { for (const [ref, row] of records) if (row.metadata.expires_at <= now()) records.delete(ref); };
  return {
    async register(reply: OwnerTurnResponse, binding: AppProtectedResponseBinding, assertDeliveryCurrent: () => Promise<void>): Promise<AppProtectedResponseMetadata> {
      // Snapshot the trusted binding before awaits: caller object reuse cannot
      // retarget a previously authenticated response to a different session.
      binding = Object.freeze({ ...binding });
      currentBinding(binding);
      if (reply.custody.kind !== 'volatile_owner_health' || !reply.text.trim() || new TextEncoder().encode(reply.text).byteLength > MAX_TEXT_BYTES) throw new Error('Protected response unavailable.');
      await reply.custody.assertCurrent();
      await reply.custody.assertHealthCurrent();
      await assertDeliveryCurrent();
      expire();
      if (records.size >= capacity) throw new Error('Protected response capacity unavailable.');
      const ref = `hresp_${crypto.randomUUID().replaceAll('-', '')}`;
      const expires_at = now() + ttl;
      const part = appProtectedHealthPartV1Schema.parse({ type: 'protected_health', response_ref: ref,
        readback_path: `/app/v1/chat/protected-responses/${ref}?conversation_ref=${encodeURIComponent(binding.conversation_ref)}`,
        expires_at, retention: 'volatile', state: 'available_until_expiry' });
      const metadata = Object.freeze({ ...binding, response_ref: ref, expires_at, part });
      const healthCurrent = reply.custody.assertHealthCurrent;
      records.set(ref, { metadata, text: redactSecretUrls(reply.text).text, assertDeliveryCurrent: async () => { await healthCurrent(); await assertDeliveryCurrent(); } });
      try {
        await reply.custody.assertCurrent();
        await healthCurrent();
        await assertDeliveryCurrent();
      } catch { records.delete(ref); throw new Error('Protected response authority changed.'); }
      if (expires_at <= now()) { records.delete(ref); throw new Error('Protected response expired.'); }
      return metadata;
    },
    async readback(request: Request, binding: AppProtectedResponseBinding, assertRequestCurrent: () => Promise<void>): Promise<Response | null> {
      binding = Object.freeze({ ...binding });
      const url = new URL(request.url);
      const match = /^\/app\/v1\/chat\/protected-responses\/([^/]+)$/.exec(url.pathname);
      if (!match) return null;
      if (request.method !== 'GET') return response({ error: 'method_not_allowed' }, 405);
      try { currentBinding(binding); await assertRequestCurrent(); } catch { return response({ error: 'auth_failed' }, 401); }
      const query = appProtectedResponseQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
      if (url.searchParams.getAll('conversation_ref').length !== 1 || !appProtectedResponseRefV1Schema.safeParse(match[1]).success || !query.success) return response({ error: 'invalid_request' }, 400);
      if (query.data.conversation_ref !== binding.conversation_ref) return response({ error: 'forbidden' }, 403);
      expire();
      const row = records.get(match[1]!);
      // After eviction/restart/expiry the body is gone. Metadata never fabricates it.
      if (!row) return response({ error: 'protected_response_unavailable' }, 410);
      if (row.metadata.principal_ref !== binding.principal_ref || row.metadata.session_ref !== binding.session_ref
        || row.metadata.conversation_ref !== binding.conversation_ref) return response({ error: 'forbidden' }, 403);
      try {
        await row.assertDeliveryCurrent(); await assertRequestCurrent();
        if (row.metadata.expires_at <= now()) { records.delete(match[1]!); return response({ error: 'protected_response_unavailable' }, 410); }
        const body = appProtectedResponseV1Schema.parse({ version: 1, response_ref: row.metadata.response_ref, conversation_ref: binding.conversation_ref,
          state: 'available', text: row.text, expires_at: row.metadata.expires_at, retention: 'volatile' });
        await row.assertDeliveryCurrent(); await assertRequestCurrent();
        if (row.metadata.expires_at <= now()) { records.delete(match[1]!); return response({ error: 'protected_response_unavailable' }, 410); }
        return response(body);
      } catch { records.delete(match[1]!); return response({ error: 'protected_response_unavailable' }, 410); }
    },
    revokeSession(principal: string, session: string) { for (const [ref, row] of records) if (row.metadata.principal_ref === principal && row.metadata.session_ref === session) records.delete(ref); },
    eraseConversation(principal: string, conversation: string) { for (const [ref, row] of records) if (row.metadata.principal_ref === principal && row.metadata.conversation_ref === conversation) records.delete(ref); },
    clear() { records.clear(); },
  };
};
