import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Workspace, WorkspaceProxy } from '@cloudflare/computer';
import { ContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container';
import { ComputerContainerExecutor } from './computer-container';
export { WorkspaceProxy };
import {
  type LinuxContainer,
} from './linux-container';
import { journaledCompute, type ComputeRecord } from './compute-journal';
import type { ComputeWireRequest } from '../channels/compute-host';
import { WorkspaceError } from '@waldo/workspace';

interface Env { OWNER_COMPUTE: DurableObjectNamespace<OwnerComputeContainer> }

/** Internal RPC only: the trusted owner worker selects this instance from authenticated identity. */
class ComputerDurableObject extends DurableObject<Env> {}
export class OwnerComputeContainer extends withWorkspaceContainer(ComputerDurableObject) {
  private readonly executor: ComputerContainerExecutor;
  private workingCopy: Workspace | undefined;
  private backend: ContainerBackend | undefined;
  private activeAbort: AbortController | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error('Owner compute container is not configured');
    this.executor = new ComputerContainerExecutor({
      open: async check => {
        check(); this.assertAllowed();
        if (ctx.container!.running) await ctx.container!.destroy('Fresh Computer trial operation');
        check(); this.assertAllowed();
        const image = (ctx.container as unknown as LinuxContainer).images.compute;
        if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw Error('Computer image must be digest pinned');
        const api = this.getWorkspaceContainer();
        // A pending SDK start may outlive cancellation. Check both sides and tear down late starts.
        const fenced = new Proxy(api, { get: (target, key) => {
          if (key === 'start' || key === 'restart') return async (spec: Parameters<typeof api.start>[0]) => {
            check(); this.assertAllowed();
            if (spec.enableInternet) throw Error('Computer trial network must remain disabled');
            const started = await target[key](spec);
            try { check(); this.assertAllowed(); }
            catch (error) { await ctx.container!.destroy('Late Computer start cancelled'); throw error; }
            return started;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        this.backend = new ContainerBackend({
          container: () => ({ getWorkspaceContainer: () => fenced }),
          workspace: { binding: 'OWNER_COMPUTE', id: ctx.id.toString() },
          id: 'container', name: 'compute', instance: 'lite', egress: { mode: 'none' }, restartAttempts: 0,
          launch: { entrypoint: ['timeout', '--signal=KILL', '35s', '/usr/local/bin/computerd'] },
        });
        this.workingCopy = new Workspace({ storage: ctx.storage, backends: [this.backend], output: false });
        return this.workingCopy;
      },
      destroy: reason => ctx.container!.destroy(reason),
    });
  }

  // Same SDK stub surface installed by withWorkspace, with an explicit task-owned copy.
  async __getWorkspaceStub() {
    if (!this.workingCopy) throw new WorkspaceError('pending');
    return this.workingCopy.stub();
  }
  override async fetch(request: Request) {
    if (!this.backend) return new Response('No active Computer operation', { status: 409 });
    return this.backend.handleFetch(request);
  }

  private claim(ownerScope: string, operationId: string) {
    if (!ownerScope || ownerScope.length > 512 || !operationId || operationId.length > 512) throw new WorkspaceError('invalid');
    const identity = JSON.stringify([ownerScope, operationId]);
    this.ctx.storage.transactionSync(() => {
      const prior = this.ctx.storage.kv.get<string>('identity');
      if (prior && prior !== identity) throw new WorkspaceError('rejected');
      this.ctx.storage.kv.put('identity', identity);
    });
  }

  private journal() {
    return journaledCompute({ transaction: work => this.ctx.storage.transactionSync(() => {
      const next = work(this.ctx.storage.kv.get<ComputeRecord>('operation') ?? null);
      if (next.record) this.ctx.storage.kv.put('operation', next.record);
      return next.value;
    }) }, async request => {
      this.assertAllowed();
      const controller = new AbortController(); this.activeAbort = controller;
      try {
        // Persistent provider-side watchdog survives eviction and cannot be changed by Linux code.
        await this.ctx.storage.setAlarm(Date.now() + 35_000);
        this.assertAllowed();
        const result = await this.executor.execute({ ...request, signal: controller.signal });
        // execute resolves only after its finally block has destroyed the container.
        await this.ctx.storage.deleteAlarm();
        return result;
      }
      finally { if (this.activeAbort === controller) this.activeAbort = undefined; }
    });
  }

  private assertAllowed() {
    if (this.ctx.storage.kv.get<boolean>('cancelled')) throw new WorkspaceError('rejected');
  }

  execute(ownerScope: string, request: ComputeWireRequest) {
    this.claim(ownerScope, request.operationId);
    return this.journal().execute({ ...request, assertCurrent: async () => { this.assertAllowed(); } });
  }

  async recover(ownerScope: string, operationId: string) {
    this.claim(ownerScope, operationId);
    const record = this.ctx.storage.kv.get<ComputeRecord>('operation');
    if (record?.status === 'issued' || record?.status === 'failed') {
      // Recovery observes the durable intent and removes stale executable processes; never replay it.
      this.activeAbort?.abort();
      await (this.ctx.container as unknown as LinuxContainer).destroy('Uncertain compute recovery');
    }
    return this.journal().recover(operationId);
  }

  async cancel(ownerScope: string, operationId: string) {
    this.claim(ownerScope, operationId);
    // Persist before stopping so cancel arriving before execute survives eviction and wins the race.
    this.ctx.storage.kv.put('cancelled', true);
    this.activeAbort?.abort();
    await (this.ctx.container as unknown as LinuxContainer).destroy('Owner compute cancelled');
  }

  override async alarm() {
    this.ctx.storage.kv.put('cancelled', true);
    this.activeAbort?.abort();
    // A failed alarm throws so the Durable Object alarm retry policy attempts cleanup again.
    await (this.ctx.container as unknown as LinuxContainer).destroy('Compute persistent watchdog');
    await this.ctx.storage.deleteAlarm();
  }
}

/** Access requires an internal Worker service binding; no public HTTP compute entrypoint. */
export default class OwnerComputeService extends WorkerEntrypoint<Env> {
  private instance(ownerScope: string, operationId: string) {
    const id = this.env.OWNER_COMPUTE.idFromName(JSON.stringify([ownerScope, operationId]));
    return this.env.OWNER_COMPUTE.get(id);
  }
  execute(ownerScope: string, request: ComputeWireRequest) {
    return this.instance(ownerScope, request.operationId).execute(ownerScope, request);
  }
  recover(ownerScope: string, operationId: string) {
    return this.instance(ownerScope, operationId).recover(ownerScope, operationId);
  }
  cancel(ownerScope: string, operationId: string) {
    return this.instance(ownerScope, operationId).cancel(ownerScope, operationId);
  }
  override fetch() { return new Response('Not found', { status: 404 }); }
}
