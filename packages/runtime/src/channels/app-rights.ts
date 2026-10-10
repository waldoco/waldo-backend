import { appDeletePrepareV1Schema, appDeleteSubmitV1Schema, appDeviceRegisterV1Schema, appDeviceRevokeV1Schema, appExportRequestV1Schema, appRightsStatusRequestV1Schema } from '../../../contracts/src/app/rights';
import { rightsJobs, RightsError, type RightsHost } from '../rights/jobs';
import type { AppPushDirectory } from '../rights/push-directory';

export type AppRightsHost = RightsHost & { push: AppPushDirectory; rateLimit(): Promise<boolean> };
const json = (value: object, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
const read = async <T>(request: Request, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<T> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new RightsError('invalid');
  if (!request.body) throw new RightsError('invalid');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0, timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel(); }, 5000);
  try { while (true) { const part = await reader.read(); if (timedOut) throw new RightsError('unavailable'); if (part.done) break; size += part.value.byteLength; if (size > 8192) { await reader.cancel(); throw new RightsError('invalid'); } chunks.push(part.value); } } finally { clearTimeout(deadline); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let body: unknown; try { body = JSON.parse(raw); } catch { throw new RightsError('invalid'); }
  const parsed = schema.safeParse(body); if (!parsed.success) throw new RightsError('invalid'); return parsed.data;
};
// Authenticated host identity selects the owner. Public submit/status routes select
// it only after readRightsCapability decrypts the exact purpose-bound capability.
export const appRightsRequest = async (request: Request, host: AppRightsHost): Promise<Response | null> => {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/app/v1/rights/') && path !== '/app/v1/devices' && !path.startsWith('/app/v1/devices/')) return null;
  try {
    if (url.search) throw new RightsError('invalid');
    const origin = request.headers.get('origin'); if (request.method !== 'GET' && origin !== null && origin !== url.origin) throw new RightsError('rejected');
    if (!await host.rateLimit()) return json({ error: 'rate_limited' }, 429);
    const jobs = rightsJobs(host);
    if (path === '/app/v1/rights/inventory' && request.method === 'GET') return json(await jobs.inventory());
    if (path === '/app/v1/rights/exports' && request.method === 'POST') { const args = await read(request, appExportRequestV1Schema); return json(await jobs.export(args.operation_id, args.expected_inventory_revision), 202); }
    if (path === '/app/v1/rights/delete/prepare' && request.method === 'POST') { const args = await read(request, appDeletePrepareV1Schema); return json(await jobs.prepare(args.operation_id, args.expected_inventory_revision)); }
    if (path === '/app/v1/rights/delete/submit' && request.method === 'POST') { const args = await read(request, appDeleteSubmitV1Schema); return json(await jobs.submit(args.submission_capability), 202); }
    if (path === '/app/v1/rights/receipts/status' && request.method === 'POST') { const args = await read(request, appRightsStatusRequestV1Schema); return json(await jobs.status(args.status_capability)); }
    const exportId = /^\/app\/v1\/rights\/exports\/([a-f0-9-]{36})$/.exec(path)?.[1];
    if (exportId && request.method === 'GET') return json(await jobs.readExport(exportId));
    await host.assertCurrent();
    if (path === '/app/v1/devices' && request.method === 'GET') { const devices = await host.push.list(); await host.assertCurrent(); return json({ devices }); }
    if (path === '/app/v1/devices/register' && request.method === 'POST') { const result = await host.push.register(await read(request, appDeviceRegisterV1Schema)); await host.assertCurrent(); return json(result); }
    if (path === '/app/v1/devices/revoke' && request.method === 'POST') { const result = await host.push.revoke(await read(request, appDeviceRevokeV1Schema)); await host.assertCurrent(); return json(result); }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    const code = error instanceof RightsError ? error.code : 'unavailable';
    return json({ error: `rights_${code}` }, code === 'invalid' ? 400 : code === 'rejected' ? 403 : code === 'conflict' ? 409 : code === 'not_found' ? 404 : 503);
  }
};
