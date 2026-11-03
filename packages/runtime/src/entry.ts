import { lazyWorker } from './lazy-entry';

// The deployed production entry: the full Worker (./index) loads on the first event, not at startup (see lazy-entry.ts).
// Tests import ./index directly; this module adds no behaviour of its own.
const worker = lazyWorker(() => import('./index'));

export { RunLoopDO, RuntimeProbeDO, TracerDO } from './retired-durable-objects';
export class OwnerDO extends worker.OwnerDO {}
export class DeviceBridgeDO extends worker.DeviceBridgeDO {}
export class IMessageBridgeDO extends worker.IMessageBridgeDO {}
export class TaskWorkerDO extends worker.TaskWorkerDO {}
export default worker.handler;
