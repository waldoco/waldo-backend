import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import {
  LinuxContainerExecutor,
  type LinuxContainer,
} from '../../packages/runtime/src/execution-environment/linux-container';
import { journaledCompute, type ComputeRecord } from '../../packages/runtime/src/execution-environment/compute-journal';
import type { ComputeWireRequest } from '../../packages/runtime/src/channels/compute-host';
import { WorkspaceError } from '../../packages/workspace/src/index';

interface Env { OWNER_COMPUTE: DurableObjectNamespace<OwnerComputeContainer> }

/** Internal RPC only: the trusted owner worker selects this instance from authenticated identity. */
export class OwnerComputeContainer extends DurableObject<Env> {
  private readonly executor: LinuxContainerExecutor;
  private activeAbort: AbortController | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error('Owner compute container is not configured');
    this.executor = new LinuxContainerExecutor(ctx.container as unknown as LinuxContainer);
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
