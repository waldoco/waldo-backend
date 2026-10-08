import type { BrowserContext, BrowserWorker, Page } from '@cloudflare/playwright';
import { browserStateCustody, type BrowserStateBinding, type BrowserStateBlobStore } from './browser-state-custody';
import { siteScopedCustody } from './browser-site-custody';
import type { BrowserStateSitePolicy } from './browser-state-site-scope';
import { privateBrowserSession, type PrivateSessionOutcome, type PrivateStateCustody } from './browser-private-session';
import { cloudflarePrivateLauncher, cloudflareOwnerHandoff, type CloudflareLauncher } from './cloudflare-browser-adapter';

type Record = Readonly<{ binding: BrowserStateBinding; expiresAt: number; revoked?: true;
  allocation?: 'prepared' | 'observed' | 'closed'; allocationRef?: string; providerSessionId?: string; interrupted?: true; operationId?: string; operationDeadline?: number }>;
type SignIn = Readonly<{ instructions: string; timeoutMs: number; liveViewExpiresMs: number;
  prepare(context: BrowserContext): Promise<Page>; deliverToOwner(ownerId: string, url: string): Promise<void> }>;
const active = new WeakMap<DurableObjectStorage, Map<string, AbortController>>();
const cleanupWork = new WeakMap<DurableObjectStorage, Map<string, Promise<void>>>();
export async function cleanupPrivateBrowserOwner(storage: DurableObjectStorage, recordKey: string, providerSessionId: string, allocationRef: string | undefined, terminate: () => Promise<void>): Promise<void> {
  let pending = cleanupWork.get(storage);
  if (!pending) { pending = new Map(); cleanupWork.set(storage, pending); }
  const identity = JSON.stringify([recordKey, providerSessionId, allocationRef]);
  let work = pending.get(identity);
  if (!work) { work = Promise.resolve().then(terminate); pending.set(identity, work); }
  try { await work; }
  finally { if (pending.get(identity) === work) pending.delete(identity); }
}
export function revokePrivateBrowserOwner(storage: DurableObjectStorage, binding: BrowserStateBinding): void {
  const key = `private-browser-owner/v1/${JSON.stringify([binding.ownerId, binding.environment, binding.siteOrigin, binding.accountId])}`;
  storage.transactionSync(() => {
    const row = storage.kv.get<Record>(key);
    if (row && JSON.stringify(row.binding) !== JSON.stringify(binding)) throw Error('browser_private_rejected');
    if (row) storage.kv.put(key, { ...row, revoked: true, operationId: crypto.randomUUID() });
    for (const [path] of storage.kv.list({ prefix: `${key}/encrypted/` })) storage.kv.delete(path);
  });
  active.get(storage)?.get(key)?.abort();
}
// Concrete trusted-host consumer. The caller supplies existing owner authorization,
// persistence consent, metered allocation and a nonextractable approved key. It is
// not a model tool and does not mint approvals, keys, grants or spend allowance.
export function cloudflarePrivateOwner(options: Readonly<{
  storage: DurableObjectStorage; binding: BrowserWorker; launch: CloudflareLauncher;
  bindingScope: BrowserStateBinding; expiresAt: number; key?: CryptoKey;
  custody?(binding: BrowserStateBinding, blobs: BrowserStateBlobStore, admit: (binding: BrowserStateBinding) => Promise<boolean>): Promise<PrivateStateCustody>;
  allocationRef?: string;
  allowedDomains: readonly string[]; sitePolicy: BrowserStateSitePolicy; now(): number;
  keepAliveMs: number; lifetimeMs: number; deadline(): number;
  assertOwnerCurrent(binding: BrowserStateBinding): Promise<void>;
  assertPersistenceApproved(binding: BrowserStateBinding): Promise<void>;
  reserveAllocation(binding: BrowserStateBinding, lifetimeMs: number): Promise<void>;
  // Must terminate this exact provider identity and independently prove absence.
  // A transport ACK alone must reject rather than claim cleanup.
  terminate(providerSessionId: string): Promise<void>;
}>) {
  options = Object.freeze({ ...options, allowedDomains: Object.freeze([...options.allowedDomains]),
    sitePolicy: Object.freeze({origins: Object.freeze([...options.sitePolicy.origins]), cookieDomains: Object.freeze([...options.sitePolicy.cookieDomains])}) });
  const binding = Object.freeze({ ...options.bindingScope });
  const identity = JSON.stringify([binding.ownerId, binding.environment, binding.siteOrigin, binding.accountId]);
  const recordKey = `private-browser-owner/v1/${identity}`;
  const blobPrefix = `${recordKey}/encrypted/`;
  const matches = (row: Record | undefined) => row && JSON.stringify(row.binding) === JSON.stringify(binding) && row.expiresAt === options.expiresAt;
  const row = () => options.storage.kv.get<Record>(recordKey);
  const locallyCurrent = () => matches(row()) && !row()?.revoked && options.now() < options.expiresAt;
  const check = async () => {
    if (!locallyCurrent()) throw Error('browser_private_rejected');
    await options.assertOwnerCurrent(binding);
    await options.assertPersistenceApproved(binding);
    if (!locallyCurrent()) throw Error('browser_private_rejected');
  };
  const update = (change: Partial<Record>) => options.storage.transactionSync(() => {
    const current = row();
    if (!matches(current)) throw Error('browser_private_rejected');
    options.storage.kv.put(recordKey, { ...current!, ...change });
  });
  const cleanup = async (retained = row()) => {
    const current=row();
    if(current?.allocation==='closed' && current.providerSessionId===retained?.providerSessionId) return;
    if (!matches(retained)) throw Error('browser_private_rejected');
    if (!retained?.allocation || retained.allocation === 'closed') return;
    if (!retained.providerSessionId) throw Error('browser_private_allocation_uncertain');
    await cleanupPrivateBrowserOwner(options.storage, recordKey, retained.providerSessionId, retained.allocationRef, () => options.terminate(retained.providerSessionId!));
    options.storage.transactionSync(() => {
      const current = row();
      // A late cleanup cannot mark a replacement allocation closed.
      if (matches(current) && current?.providerSessionId === retained.providerSessionId)
        options.storage.kv.put(recordKey, {...current, allocation:'closed'});
    });
  };
  const interrupt = () => {
    update({interrupted:true, operationId:crypto.randomUUID()});
    active.get(options.storage)?.get(recordKey)?.abort();
  };
  return {
    async run<T>(operation: Readonly<{
      verifyAccount(context: BrowserContext, binding: BrowserStateBinding): Promise<boolean>;
      installPolicy?(context: BrowserContext): Promise<void>;
      signIn?: SignIn; work(context: BrowserContext): Promise<T>;
    }>): Promise<PrivateSessionOutcome<T>> {
      let controllers = active.get(options.storage);
      if (!controllers) { controllers = new Map(); active.set(options.storage, controllers); }
      if (controllers.has(recordKey)) return { status: 'failed', phase: 'work' };
      const controller = new AbortController(); controllers.set(recordKey, controller);
      const operationId = crypto.randomUUID();
      const operationDeadline=Math.min(options.expiresAt,options.deadline(),options.now()+options.lifetimeMs);
      let operationTimer:ReturnType<typeof setTimeout>|undefined;
      let rejectInterrupted!:(reason:Error)=>void;
      const interrupted = new Promise<never>((_,reject)=>{rejectInterrupted=reject;});
      void interrupted.catch(()=>{});
      const abort = ()=>rejectInterrupted(Error('browser_private_interrupted'));
      controller.signal.addEventListener('abort',abort,{once:true});
      const bounded = <V>(work:Promise<V>)=>Promise.race([work,interrupted]);
      const checkOperation = async () => {
        await check();
        if (controller.signal.aborted || row()?.operationId !== operationId || !Number.isSafeInteger(options.deadline()) || options.now() >= operationDeadline) throw Error('browser_private_interrupted');
      };
      try {
        await options.assertOwnerCurrent(binding);
        await options.assertPersistenceApproved(binding);
        options.storage.transactionSync(() => {
          const current = row();
          if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= options.now()
            || !Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs<10000 || options.lifetimeMs>600000
            || !Number.isSafeInteger(options.keepAliveMs) || options.keepAliveMs<10000 || options.keepAliveMs>options.lifetimeMs
            || current && !matches(current)) throw Error('browser_private_rejected');
          if (!current) options.storage.kv.put(recordKey, { binding, expiresAt: options.expiresAt });
        });
        await check();
        // A restored host cannot recover a page's interrupted MFA event listener.
        // Clean retained identity once, report interruption, and require a new request.
        if (row()?.allocation && row()?.allocation !== 'closed') {
          interrupt(); await cleanup();
          return { status: 'failed', phase: 'work' };
        }
        update({operationId, operationDeadline});
        await checkOperation();
        const remaining=operationDeadline-options.now();
        // JavaScript timers cannot represent a larger single timeout safely.
        if(!Number.isSafeInteger(remaining) || remaining<1 || remaining>2147483647) throw Error('browser_private_deadline_invalid');
        operationTimer=setTimeout(()=>controller.abort(),remaining);
        if (!!options.key === !!options.custody) throw Error('browser_private_custody_invalid');
        const createCustody = options.custody ?? ((scope, blobs, admit) => browserStateCustody(scope, options.key!, blobs, admit));
        const custody = await createCustody(binding, {
          get: async path => (options.storage.kv.get<Uint8Array>(blobPrefix + path) ?? null),
          put: async (path, bytes) => options.storage.transactionSync(() => {
            // Fence in the same transaction as the write: an earlier async check
            // cannot prevent a sign-out interleaving with encryption/blob I/O.
            if (!locallyCurrent() || controller.signal.aborted || row()?.operationId !== operationId || !Number.isSafeInteger(options.deadline()) || options.now() >= operationDeadline) throw Error('browser_private_rejected');
            options.storage.kv.put(blobPrefix + path, bytes);
          }),
          remove: async path => { options.storage.kv.delete(blobPrefix + path); },
        }, async () => { await checkOperation(); return true; });
        const launch = cloudflarePrivateLauncher(options.binding, async (browserBinding, args) => {
          await checkOperation(); await options.reserveAllocation(binding, options.lifetimeMs); await checkOperation();
          options.storage.transactionSync(()=>{
            if(!locallyCurrent() || controller.signal.aborted || row()?.operationId!==operationId) throw Error('browser_private_rejected');
            update({ allocation: 'prepared', allocationRef: options.allocationRef, providerSessionId: undefined });
          });
          const browser = await options.launch(browserBinding, args);
          try {
            const id = browser.sessionId();
            if (typeof id !== 'string' || !id || id.length > 200) throw Error('browser_private_identity_unavailable');
            update({ allocation: 'observed', providerSessionId: id });
            await checkOperation();
          } catch (error) { await browser.close(); throw error; }
          const retained = row();
          return new Proxy(browser, { get(target, property) {
            if (property === 'close') return async () => { void target.close().catch(() => {}); await cleanup(retained); };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }});
        }, options.allowedDomains, options.keepAliveMs);
        const result = await privateBrowserSession({
          signal: controller.signal, cleanupTimeoutMs: 10000,
          custody: siteScopedCustody(custody, options.sitePolicy, 1048576), launch,
          installPolicy: async context => { await checkOperation(); if (operation.installPolicy) await bounded(operation.installPolicy(context)); await checkOperation(); },
          work: async context => {
            await checkOperation();
            // Restored cookies are not proof of a current authenticated account.
            if (await bounded(operation.verifyAccount(context, binding)) !== true) {
              const request = operation.signIn;
              if (!request) throw Error('browser_account_unverified');
              const page = await bounded(request.prepare(context));
              await checkOperation();
              if (page.context() !== context || new URL(page.url()).origin !== binding.siteOrigin
                || request.timeoutMs > operationDeadline - options.now()
                || request.liveViewExpiresMs > operationDeadline - options.now()) throw Error('browser_handoff_rejected');
              await cloudflareOwnerHandoff({ ...request, page, context, ownerId: binding.ownerId, signal: controller.signal,
                assertCurrent:async()=>{ await checkOperation(); if(new URL(page.url()).origin!==binding.siteOrigin) throw Error('browser_handoff_rejected'); },
                verify:()=>bounded(operation.verifyAccount(context,binding)) });
            }
            await checkOperation();
            const value = await bounded(operation.work(context));
            if (await bounded(operation.verifyAccount(context, binding)) !== true) throw Error('browser_account_unverified');
            await checkOperation(); return value;
          },
        });
        if (result.status === 'ok') await checkOperation();
        return result;
      } catch { return { status: 'failed', phase: 'load' }; }
      finally {
        if(operationTimer!==undefined)clearTimeout(operationTimer);
        controller.signal.removeEventListener('abort',abort);
        controllers.delete(recordKey);
      }
    },
    async signOut(): Promise<Readonly<{status:'signed_out';remoteLogout:'not_attempted'} | {status:'failed';phase:'owner'|'custody'|'cleanup'}>> {
      let phase:'owner'|'custody'|'cleanup'='owner';
      try {
        // Retiring state remains possible after consent expiry; identity is separate.
        await options.assertOwnerCurrent(binding);
        phase='custody';
        if (!matches(row())) throw Error('browser_private_rejected');
        revokePrivateBrowserOwner(options.storage, binding);
        phase='cleanup'; await cleanup();
        return {status:'signed_out',remoteLogout:'not_attempted'};
      } catch { return {status:'failed',phase}; }
    },
    async recover(): Promise<Readonly<{status:'clean'|'interrupted'} | {status:'failed';phase:'owner'|'custody'|'cleanup'}>> {
      let phase:'owner'|'custody'|'cleanup'='owner';
      try {
        await options.assertOwnerCurrent(binding);
        phase='custody';
        if (!matches(row())) throw Error('browser_private_rejected');
        if (!row()?.allocation || row()?.allocation === 'closed') return {status:'clean'};
        interrupt(); phase='cleanup'; await cleanup(); return {status:'interrupted'};
      } catch { return {status:'failed',phase}; }
    },
  };
}
