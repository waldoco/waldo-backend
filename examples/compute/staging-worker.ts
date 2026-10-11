import { WorkerEntrypoint } from 'cloudflare:workers';
import type { OwnerComputeContainer } from './worker';
import type { ComputeWireRequest } from '../../packages/runtime/src/channels/compute-host';
import { requireStagingComputeOwner } from './staging-owner-guard';
import { stagingOwnerScopes } from './.staging/owner-roster';

export { OwnerComputeContainer } from './worker';
interface Env { OWNER_COMPUTE: DurableObjectNamespace<OwnerComputeContainer> }

/** Deny before namespace allocation; the generic provider service remains unchanged. */
export default class StagingOwnerComputeService extends WorkerEntrypoint<Env> {
  #instance(ownerScope: string, operationId: string) {
    requireStagingComputeOwner(stagingOwnerScopes, ownerScope);
    const id = this.env.OWNER_COMPUTE.idFromName(JSON.stringify([ownerScope, operationId]));
    return this.env.OWNER_COMPUTE.get(id);
  }
  execute(ownerScope: string, request: ComputeWireRequest) {
    return this.#instance(ownerScope, request.operationId).execute(ownerScope, request);
  }
  recover(ownerScope: string, operationId: string) {
    return this.#instance(ownerScope, operationId).recover(ownerScope, operationId);
  }
  cancel(ownerScope: string, operationId: string) {
    return this.#instance(ownerScope, operationId).cancel(ownerScope, operationId);
  }
  override fetch() { return new Response('Not found', { status: 404 }); }
}
