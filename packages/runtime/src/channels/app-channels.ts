import { APP_CHANNELS_MAX_REQUEST_BYTES, appChannelMutationV1Schema, appChannelReceiptV1Schema, appChannelsV1Schema, type AppChannelReceiptV1 } from '../../../contracts/src/app/channels';
import { RightsError } from '../rights/jobs';
import { rightsDigest } from '../rights/capability';
import type { OwnerChannelDirectory } from '../identity/owner-channel-directory';
export type AppChannelsHost = {
  accountRef: string; sessionHash: string; directory: OwnerChannelDirectory; configured: { telegram: boolean; whatsapp: boolean };
  storage: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
  now(): number; assertCurrent(): Promise<void>; rateLimit(): Promise<boolean>; commit<T>(work: () => T): T;
};
type Operation = { digest: string; session: string; receipt: AppChannelReceiptV1 };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
const read = async (request: Request) => {
  if (!request.body || !(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new RightsError('invalid');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try { for (;;) { const chunk = await reader.read(); if (expired) throw new RightsError('invalid'); if (chunk.done) break; size += chunk.value.byteLength; if (size > APP_CHANNELS_MAX_REQUEST_BYTES) { await reader.cancel(); throw new RightsError('invalid'); } chunks.push(chunk.value); } }
  finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw new RightsError('invalid'); }
  const parsed = appChannelMutationV1Schema.safeParse(raw); if (!parsed.success) throw new RightsError('invalid'); return parsed.data;
};
const queues = new WeakMap<object, Promise<unknown>>();
const serialized = async <T>(storage: object, work: () => Promise<T>) => { const next = (queues.get(storage) ?? Promise.resolve()).catch(() => undefined).then(work); queues.set(storage, next); try { return await next; } finally { if (queues.get(storage) === next) queues.delete(storage); } };
export const appChannelsRequest = async (request: Request, host: AppChannelsHost): Promise<Response | null> => {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/app/v1/channels' && !path.startsWith('/app/v1/channels/')) return null;
  try {
    if (url.search) throw new RightsError('invalid');
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'unavailable' }, 405);
    if (request.method === 'POST' && request.headers.has('origin') && request.headers.get('origin') !== url.origin) throw new RightsError('rejected');
    if (!await host.rateLimit()) return json({ error: 'rate_limited' }, 429);
    await host.assertCurrent();
    if (request.method === 'GET') {
      if (path !== '/app/v1/channels') {
        const id = /^\/app\/v1\/channels\/operations\/([A-Za-z0-9_-]{8,64})$/.exec(path)?.[1];
        const prior = id && host.storage.get<Operation>(`app:channels.operation:${id}`);
        if (!prior) throw new RightsError('not_found');
        if (prior.session !== host.sessionHash) throw new RightsError('rejected');
        await host.assertCurrent(); return json(appChannelReceiptV1Schema.parse(prior.receipt));
      }
      const inventory = await host.directory.inventory(); await host.assertCurrent();
      return json(appChannelsV1Schema.parse({ version: 'channels.v1', account_ref: host.accountRef, revision: inventory.revision,
        channels: ['app', 'telegram', 'whatsapp', 'imessage'].map(provider => {
          const linked = provider === 'app' || inventory.linked.includes(provider as 'telegram' | 'whatsapp');
          const available = provider === 'app' || provider === 'telegram' && host.configured.telegram || provider === 'whatsapp' && host.configured.whatsapp;
          return { provider, state: linked ? 'linked' : available ? 'available' : 'unavailable', link_available: provider !== 'app' && available,
            unlink_available: provider !== 'app' && linked, reason: linked || available ? null : provider === 'imessage' ? 'integration_absent' : 'not_configured', authority: 'channel_only' };
        }) }));
    }
    if (path !== '/app/v1/channels/link' && path !== '/app/v1/channels/unlink') throw new RightsError('not_found');
    const args = await read(request), kind = path.endsWith('/link') ? 'link' : 'unlink';
    return await serialized(host.storage, async () => {
      await host.assertCurrent();
      const digest = await rightsDigest(JSON.stringify([path, args])), key = `app:channels.operation:${args.operation_id}`;
      await host.assertCurrent();
      const prior = host.storage.get<Operation>(key);
      if (prior) { if (prior.digest !== digest || prior.session !== host.sessionHash) throw new RightsError('conflict'); return json(appChannelReceiptV1Schema.parse(prior.receipt)); }
      const inventory = await host.directory.inventory();
      if (args.expected_revision !== inventory.revision) throw new RightsError('conflict');
      if (kind === 'link' && !host.configured[args.provider]) throw new RightsError('rejected');
      const receipt: AppChannelReceiptV1 = { version: 'channels.v1', operation_id: args.operation_id, provider: args.provider, kind,
        state: 'unconfirmed', revision: null, recorded_at: host.now(), authority: 'channel_only', owner_state: 'preserved', link: null };
      // Persist intent before I/O. Lost replies stay unconfirmed and are never
      // redispatched: a retry cannot undo a newly linked channel.
      host.commit(() => host.storage.put(key, { digest, session: host.sessionHash, receipt } satisfies Operation));
      try {
        if (kind === 'link') {
          const result = await host.directory.issueLink(args.provider, args.expected_revision);
          receipt.revision = result.revision; receipt.link = { code: result.code, expires_at: result.expiresAt, completion: 'provider_redemption_required' };
        } else { receipt.revision = (await host.directory.unlink(args.provider, args.expected_revision)).revision; }
        receipt.state = 'recorded';
      } catch (error) {
        if (error instanceof RightsError && ['conflict', 'rejected', 'invalid'].includes(error.code)) receipt.state = 'rejected';
      }
      // The signed directory checked the live owner/session after I/O; unlink
      // changes channel admission, so the original epoch must not be reused here.
      host.commit(() => host.storage.put(key, { digest, session: host.sessionHash, receipt: appChannelReceiptV1Schema.parse(receipt) } satisfies Operation));
      return json(receipt);
    });
  } catch (error) {
    const code = error instanceof RightsError ? error.code : 'unavailable';
    return json({ error: code }, code === 'invalid' ? 400 : code === 'rejected' ? 403 : code === 'not_found' ? 404 : code === 'conflict' ? 409 : 503);
  }
};
