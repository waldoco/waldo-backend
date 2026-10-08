import type { BrowserContext, Download, Page } from '@cloudflare/playwright';
import type { BrowsePageArgs } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { privateBrowserConsolePage } from './browser-private-console-page';
import { browserBoundedJson } from './browser-bounded-body';
import { cloudflarePrivateOwner, revokePrivateBrowserOwner, cleanupPrivateBrowserOwner } from './cloudflare-private-owner';
import { cloudflareGeneralBrowser } from './cloudflare-general-browser';
import { PRIVATE_BROWSER_CONSENT_KEY, privateBrowserConsent, type PrivateBrowserConsent } from './browser-private-consent';
import type { CommonBrowserConfiguration, CommonBrowserGrant } from './common-browser-host';
import { browserDownloadToWorkspace } from './browser-download-workspace';
import { browserScreenshotToWorkspace } from './browser-screenshot-workspace';
import type { workspaceOwnerHost } from './workspace-host';

type RunnerOptions = Parameters<typeof cloudflarePrivateOwner>[0];
export type PrivateBrowserRegistration = Readonly<{
  siteOrigin: string; accountId: string; expiresAt: number;
  allowedDomains: readonly string[]; sitePolicy: RunnerOptions['sitePolicy'];
  launch: RunnerOptions['launch']; custody: NonNullable<RunnerOptions['custody']>;
  verifyAccount(context: BrowserContext, accountId: string): Promise<boolean>;
  signIn: Readonly<{ instructions: string; prepare(context: BrowserContext): Promise<Page> }>;
  deliverToOwner(ownerId: string, url: string): Promise<void>;
}>;
type Configuration = CommonBrowserConfiguration & Readonly<{ ownerId: string; lifetimeMs: number; expiresAt: number }>;
const failure = () => ({ ok: false as const, code: 'rejected' as const, error: 'Saved sign-in is unavailable or unverified. No useful private read is claimed.', source_taint: 'external' as const });
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
export const privateBrowserRecordKey = (approval: PrivateBrowserConsent) => `private-browser-owner/v1/${JSON.stringify([approval.binding.ownerId, approval.binding.environment, approval.binding.siteOrigin, approval.binding.accountId])}`;
export const PRIVATE_BROWSER_BUDGET_PREFIX = 'private-browser-budget:';
export const PRIVATE_BROWSER_DUE = 'private_browser_due_v1';
const PRIVATE_STATE_RETIREMENT = 'private_browser_state_retirement_v1';
class PrivateStateRetirementError extends Error {}

// One registered account, through existing owner authority and spend configuration.
// Registration is trusted host policy; model tools cannot supply keys or account proof.
export function ownerPrivateBrowserHost(options: Readonly<{
  storage: DurableObjectStorage; environment: string; registration?: PrivateBrowserRegistration;
  configuration(cleanupOnly?: boolean): Promise<Configuration | undefined>;
  assertOwner(): Promise<Readonly<{ directoryOwnerId: string; custodyDigest: string }>>;
  now(): number;
  wake?(at: number): Promise<void>;
  retireState?(approval: PrivateBrowserConsent): Promise<void>;
  files?(assertCurrent: () => Promise<void>, ownerId: string): Promise<Readonly<{ workspace: Awaited<ReturnType<typeof workspaceOwnerHost>>; origin: string }>>;
}>) {
  const registration = options.registration ? Object.freeze({ ...options.registration,
    allowedDomains: Object.freeze([...options.registration.allowedDomains]),
    sitePolicy: Object.freeze({ origins: Object.freeze([...options.registration.sitePolicy.origins]), cookieDomains: Object.freeze([...options.registration.sitePolicy.cookieDomains]) }) }) : undefined;
  const row = () => options.storage.kv.get<PrivateBrowserConsent>(PRIVATE_BROWSER_CONSENT_KEY);
  const wake = async (at: number | null) => { options.storage.kv.put(PRIVATE_BROWSER_DUE, at); if (at !== null) await options.wake?.(at); };
  const refreshWake = async () => {
    const approval = row();
    if (!approval || approval.state === 'revoked') return wake(null);
    if (options.storage.kv.get(PRIVATE_STATE_RETIREMENT)) return wake(null);
    const record = options.storage.kv.get<{ allocation?: string; operationDeadline?: number; cleanupFailed?: boolean }>(privateBrowserRecordKey(approval));
    if (record?.cleanupFailed) return wake(approval.state === 'approved' && options.now() < approval.expiresAt ? approval.expiresAt : null);
    return wake(approval.state === 'retiring' ? options.now() : Math.min(approval.expiresAt, record?.allocation && record.allocation !== 'closed' ? record.operationDeadline ?? options.now() : Infinity));
  };
  const assertApproval = async (approval: PrivateBrowserConsent) => {
    const current = await options.assertOwner();
    if (current.directoryOwnerId !== approval.binding.ownerId || current.custodyDigest !== approval.custodyDigest
      || !registration || approval.binding.siteOrigin !== registration.siteOrigin || approval.binding.accountId !== registration.accountId || approval.expiresAt !== registration.expiresAt
      || approval.binding.environment !== options.environment || JSON.stringify(row()) !== JSON.stringify(approval)
      || approval.state !== 'approved' || options.now() >= approval.expiresAt) throw Error('private approval unavailable');
  };
  const runner = (approval: PrivateBrowserConsent, config: Configuration, grant: CommonBrowserGrant | undefined, deadline: number, assertTask = async () => {}) => {
    if (!registration || !config.cleanupBinding || !config.bindingForOperation) throw Error('private transport unavailable');
    const recordKey = privateBrowserRecordKey(approval);
    const allocationRef = options.storage.kv.get<{ allocationRef?: string }>(recordKey)?.allocationRef;
    const budget = allocationRef ? options.storage.kv.get<{ grant: CommonBrowserGrant; recordKey: string }>(`${PRIVATE_BROWSER_BUDGET_PREFIX}${allocationRef}`) : undefined;
    const retained = grant ?? (budget?.recordKey === recordKey ? budget.grant : undefined);
    return cloudflarePrivateOwner({ storage: options.storage, bindingScope: approval.binding, expiresAt: approval.expiresAt,
      custody: registration.custody, binding: grant ? config.bindingForOperation(grant, `private:${grant.taskId}`) : config.binding,
      allocationRef: grant?.taskId,
      launch: registration.launch, allowedDomains: registration.allowedDomains, sitePolicy: registration.sitePolicy,
      now: options.now, lifetimeMs: grant?.lifetimeMs ?? config.lifetimeMs, keepAliveMs: grant?.lifetimeMs ?? config.lifetimeMs, deadline: () => deadline,
      assertOwnerCurrent: async binding => { if ((await options.assertOwner()).directoryOwnerId !== binding.ownerId) throw Error('owner changed'); },
      assertPersistenceApproved: async () => { await assertTask(); await assertApproval(approval); },
      reserveAllocation: async () => {
        if (!grant) throw Error('cleanup only');
        await assertApproval(approval); await assertTask(); await config.assertGrantCurrent(grant);
        options.storage.kv.put(`${PRIVATE_BROWSER_BUDGET_PREFIX}${grant.taskId}`, { grant, recordKey });
        await config.reserveAllocation(grant);
      },
      terminate: async providerSessionId => {
        if (!retained) throw Error('cleanup custody unavailable');
        const driver = cloudflareGeneralBrowser({ ownerId: config.ownerId, binding: config.binding, loadSdk: config.loadSdk,
          cleanupBinding: id => config.cleanupBinding!(retained, id), now: options.now, deadline: () => deadline,
          maxScreenshotBytes: retained.maxScreenshotBytes, admit: async () => { throw Error('cleanup only'); }, authorizeRequest: async () => false });
        await driver.terminate({ id: retained.taskId, ownerId: config.ownerId, provider: 'cloudflare_playwright', providerSessionId,
          contextHandle: null, mode: 'authenticated_takeover', state: 'active', generation: approval.binding.generation, expiresAt: approval.expiresAt, updatedAt: options.now() });
      },
    });
  };
  const retire = async (approval: PrivateBrowserConsent) => {
    const recordKey = privateBrowserRecordKey(approval);
    const observed = options.storage.kv.get<{ allocation?: string; allocationRef?: string; providerSessionId?: string; cleanupFailed?: boolean }>(recordKey);
    revokePrivateBrowserOwner(options.storage, approval.binding);
    let stateFailed = false;
    try { await options.retireState?.(approval); options.storage.kv.delete(PRIVATE_STATE_RETIREMENT); }
    catch { stateFailed = true; options.storage.kv.put(PRIVATE_STATE_RETIREMENT, { binding: approval.binding }); }
    // Remote state removal and prepaid provider termination are independent obligations.
    // An interrupted read may have completed termination during the Vault await.
    const record = options.storage.kv.get<typeof observed>(recordKey);
    if (record?.allocationRef !== observed?.allocationRef || record?.providerSessionId !== observed?.providerSessionId) throw Error('cleanup custody changed');
    if (record) {
      if (record.cleanupFailed) throw Error('cleanup unresolved');
      if (record.allocation && record.allocation !== 'closed') {
        const config = await options.configuration(true); if (!config) throw Error('cleanup unavailable');
        const budget = record.allocationRef ? options.storage.kv.get<{ grant: CommonBrowserGrant; recordKey: string }>(`${PRIVATE_BROWSER_BUDGET_PREFIX}${record.allocationRef}`) : undefined;
        if (!budget || budget.recordKey !== recordKey || !record.providerSessionId || !config.cleanupBinding) throw Error('cleanup uncertain');
        const driver = cloudflareGeneralBrowser({ ownerId: config.ownerId, binding: config.binding, loadSdk: config.loadSdk,
          cleanupBinding: id => config.cleanupBinding!(budget.grant, id), now: options.now, deadline: options.now, maxScreenshotBytes: budget.grant.maxScreenshotBytes,
          admit: async () => { throw Error('cleanup only'); }, authorizeRequest: async () => false });
        await cleanupPrivateBrowserOwner(options.storage, recordKey, record.providerSessionId, record.allocationRef, () => driver.terminate({ id: budget.grant.taskId, ownerId: config.ownerId, provider: 'cloudflare_playwright', providerSessionId: record.providerSessionId!,
          contextHandle: null, mode: 'authenticated_takeover', state: 'active', generation: approval.binding.generation, expiresAt: approval.expiresAt, updatedAt: options.now() }));
      }
      options.storage.transactionSync(() => {
        const retained = options.storage.kv.get<{ allocationRef?: string; providerSessionId?: string }>(recordKey);
        if (retained?.allocationRef !== record.allocationRef || retained?.providerSessionId !== record.providerSessionId) throw Error('cleanup custody changed');
        options.storage.kv.delete(recordKey);
      });
    }
    // Pause remote recovery explicitly. A console revoke retries this obligation;
    // there is no autonomous privileged RPC polling or new browser allocation.
    if (stateFailed) throw new PrivateStateRetirementError('private state retirement unresolved');
  };
  const grantFor = async (approval: PrivateBrowserConsent, taskId: string) => {
    await assertApproval(approval);
    const config = await options.configuration(); if (!config || config.ownerId !== `prn_${approval.binding.ownerId.replaceAll('-', '')}`) throw Error('configuration unavailable');
    const grant = await config.grant({ taskId, revision: 1, sources: ['browser'], ready: true, startRef: 'private-owner' }, config.ownerId);
    if (!grant.allowedOrigins.includes('*') && !grant.allowedOrigins.includes(approval.binding.siteOrigin)) throw Error('site outside funded policy');
    await assertApproval(approval); await config.assertGrantCurrent(grant); return { config, grant };
  };
  return {
    stop() {
      const approval = row(); if (!approval || approval.state === 'revoked') return;
      revokePrivateBrowserOwner(options.storage, approval.binding);
      options.storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, { ...approval, state: 'retiring', revision: crypto.randomUUID() });
      options.storage.kv.put(PRIVATE_BROWSER_DUE, options.now());
    },
    async maintain() {
      const approval = row(); if (!approval || approval.state === 'revoked' || options.storage.kv.get(PRIVATE_STATE_RETIREMENT)) return wake(null);
      const record = options.storage.kv.get<{ allocation?: string; operationDeadline?: number; cleanupFailed?: boolean }>(privateBrowserRecordKey(approval));
      const permissionExpired = options.now() >= approval.expiresAt;
      if (record?.cleanupFailed && !options.storage.kv.get(PRIVATE_STATE_RETIREMENT)) {
        // Physical uncertainty does not authorize more spend or retain local auth after expiry.
        if (permissionExpired && approval.state === 'approved') {
          revokePrivateBrowserOwner(options.storage, approval.binding);
          options.storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, { ...approval, state: 'retiring' });
        }
        return refreshWake();
      }
      const allocationExpired = record?.allocation && record.allocation !== 'closed' && (record.operationDeadline ?? options.now()) <= options.now();
      if (approval.state === 'approved' && !permissionExpired && !allocationExpired) return refreshWake();
      revokePrivateBrowserOwner(options.storage, approval.binding);
      options.storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, { ...approval, state: 'retiring' });
      try { await retire(approval); }
      catch (error) {
        if (error instanceof PrivateStateRetirementError) { await wake(null); throw error; }
        options.storage.transactionSync(() => { const retained = options.storage.kv.get<object>(privateBrowserRecordKey(approval)); if (retained) options.storage.kv.put(privateBrowserRecordKey(approval), { ...retained, cleanupFailed: true }); });
        await wake(null); throw Error('private cleanup unresolved');
      }
      options.storage.transactionSync(() => {
        if (row()?.revision !== approval.revision) throw Error('consent changed');
        options.storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, { ...approval, state: permissionExpired || approval.state === 'retiring' ? 'revoked' : 'approved' });
      });
      await refreshWake();
    },
    matches(url: string) { try { return row()?.binding.siteOrigin === new URL(url).origin; } catch { return false; } },
    async control(request: Request, csrf: string): Promise<Response> {
      if (options.environment !== 'staging' || !registration && !row()) return reply({ error: 'not_configured' }, 404);
      try {
        const owner = await options.assertOwner();
        const retained = row();
        if (request.method === 'GET' && request.headers.get('accept')?.includes('text/html') && retained?.state === 'retiring') {
          if (retained.binding.ownerId !== owner.directoryOwnerId) throw Error('owner changed');
          return privateBrowserConsolePage({ nonce: '', csrf, site: retained.binding.siteOrigin, account: retained.binding.accountId,
            generation: retained.binding.generation, expires_at: retained.expiresAt }, false, true);
        }
        let input: Record<string, unknown> | undefined;
        if (request.method === 'POST') {
          input = await browserBoundedJson(request.clone()) as Record<string, unknown>;
          if (input?.action === 'sign_in') {
            if (!registration) return reply({ error: 'not_configured' }, 404);
            if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || Object.keys(input).sort().join(',') !== 'action,csrf' || input.csrf !== csrf) return reply({ error: 'invalid_confirmation' }, 403);
            const approval = row(); if (!approval) throw Error('consent unavailable');
            const { config, grant } = await grantFor(approval, crypto.randomUUID());
            const deadline = Math.min(grant.expiresAt, approval.expiresAt, options.now() + grant.lifetimeMs);
            if (deadline - options.now() < 60000) throw Error('handoff window unavailable');
            await wake(deadline);
            const result = await runner(approval, config, grant, deadline).run({ verifyAccount: context => registration.verifyAccount(context, approval.binding.accountId),
              signIn: { ...registration.signIn, timeoutMs: 60000, liveViewExpiresMs: 60000, deliverToOwner: registration.deliverToOwner }, work: async () => true });
            await refreshWake();
            return result.status === 'ok' ? reply({ signed_in: true }) : reply({ error: 'sign_in_failed', phase: result.phase }, 409);
          }
        }
        // Retiring an owner's old state needs identity, not a still-active key
        // registration or renewed permission to access that account.
        const target = input?.action === 'revoke' && row() ? { siteOrigin: row()!.binding.siteOrigin, accountId: row()!.binding.accountId, expiresAt: row()!.expiresAt } : registration;
        if (!target) return reply({ error: 'not_configured' }, 404);
        const result = await privateBrowserConsent(request, { storage: options.storage, csrf,
          binding: { ownerId: owner.directoryOwnerId, environment: options.environment, siteOrigin: target.siteOrigin, accountId: target.accountId },
          expiresAt: target.expiresAt, now: options.now, newId: () => crypto.randomUUID(), assertOwner: async () => {
            const current = await options.assertOwner(); if (current.directoryOwnerId !== owner.directoryOwnerId) throw Error('owner changed'); return current.custodyDigest;
          }, retire });
        await refreshWake();
        if (request.method === 'GET' && result.ok && request.headers.get('accept')?.includes('text/html')) return privateBrowserConsolePage(await result.json() as Parameters<typeof privateBrowserConsolePage>[0], row()?.state === 'approved');
        return result;
      } catch { return reply({ error: 'private_browser_unavailable' }, 409); }
    },
    async read(args: BrowsePageArgs, ctx: ToolDispatcherContext) {
      try {
        const approval = row();
        if (!registration || !approval || !ctx.runScope || !ctx.turnId || !ctx.toolCallId || !ctx.assertTaskSourceCurrent
          || args.provider && args.provider !== 'cloudflare_playwright' || new URL(args.url).origin !== registration.siteOrigin) throw Error('private read unavailable');
        await ctx.assertTaskSourceCurrent();
        const { config, grant } = await grantFor(approval, ctx.runScope.runId);
        const deadline = Math.min(approval.expiresAt, grant.expiresAt, ctx.runScope.deadline, options.now() + grant.lifetimeMs);
        await wake(deadline);
        const result = await runner(approval, config, grant, deadline, ctx.assertTaskSourceCurrent).run({
          installPolicy: async context => {
            await context.route('**/*', route => {
              const target = new URL(route.request().url());
              return ['GET', 'HEAD'].includes(route.request().method()) && target.origin === registration.siteOrigin && !target.username && !target.password ? route.continue() : route.abort('blockedbyclient');
            });
            await context.routeWebSocket('**/*', socket => socket.close());
          },
          verifyAccount: context => registration.verifyAccount(context, approval.binding.accountId),
          work: async context => {
            // HTTP method and WebSocket restrictions were installed before verification.
            const page = await context.newPage();
            let download: Download | undefined, timer: ReturnType<typeof setTimeout> | undefined;
            let arrive!: (value: Download) => void;
            const downloaded = new Promise<Download>((yes, no) => { arrive = yes; timer = setTimeout(() => no(Error('download unavailable')), Math.max(1, deadline - options.now())); });
            void downloaded.catch(() => {});
            const listener = (value: Download) => { if (download) { void value.cancel().catch(() => {}); return; } download = value; arrive(value); };
            page.on('download', listener);
            try {
              let response;
              try { response = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - options.now()) }); }
              catch { download = await downloaded; }
              if (download) {
                if (!options.files) throw Error('download serving unavailable');
                const assertCurrent = async () => { await ctx.assertTaskSourceCurrent!(); await assertApproval(approval); await config.assertGrantCurrent(grant); if (options.now() >= deadline) throw Error('download deadline'); };
                await assertCurrent();
                const files = await options.files(assertCurrent, approval.binding.ownerId);
                const file = await browserDownloadToWorkspace({ ...files, download, page, operationId: crypto.randomUUID(),
                  deadline, now: options.now, assertCurrent, sourceOrigin: registration.siteOrigin });
                return { url: args.url, file };
              }
              if (!response || response.status() >= 400 || new URL(page.url()).origin !== registration.siteOrigin) throw Error('private content denied');
              const text = (await page.evaluate(() => (globalThis as unknown as { document: { body?: { innerText: string } } }).document.body?.innerText ?? '')).slice(0, 8000);
              if (!text.trim()) throw Error('empty private content');
              const observedUrl = page.url(), title = await page.title();
              if (!options.files) throw Error('screenshot serving unavailable');
              const assertCurrent = async () => { await ctx.assertTaskSourceCurrent!(); await assertApproval(approval); await config.assertGrantCurrent(grant); if (options.now() >= deadline) throw Error('screenshot deadline'); };
              await assertCurrent();
              const image = new Uint8Array(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css', timeout: Math.max(1, deadline - options.now()) }));
              await assertCurrent();
              if (page.url() !== observedUrl || new URL(page.url()).origin !== registration.siteOrigin || await page.title() !== title
                || (await page.evaluate(() => (globalThis as unknown as { document: { body?: { innerText: string } } }).document.body?.innerText ?? '')).slice(0, 8000) !== text) throw Error('private observation changed');
              const files = await options.files(assertCurrent, approval.binding.ownerId);
              const screenshot = await browserScreenshotToWorkspace({ ...files, image, maxScreenshotBytes: grant.maxScreenshotBytes, operationId: crypto.randomUUID(), deadline, now: options.now, assertCurrent });
              return { url: observedUrl, title, text, screenshot };
            } finally { if (timer !== undefined) clearTimeout(timer); page.off('download', listener); await page.close(); }
          },
        });
        await ctx.assertTaskSourceCurrent();
        await refreshWake();
        return result.status === 'ok' ? { ok: true as const, data: result.value, source_taint: 'external' as const } : failure();
      } catch { return failure(); }
    },
  };
}
