import { lazyWorker } from './lazy-entry';

// The deployed staging entry: the staging Worker (./staging-browser, which registers the browser SDK loader before any
// handler runs) loads on the first event, not at startup (see lazy-entry.ts).
const worker = lazyWorker(() => import('./staging-browser'));

export { RunLoopDO, RuntimeProbeDO, TracerDO } from './retired-durable-objects';
export class OwnerDO extends worker.OwnerDO {}
export class DeviceBridgeDO extends worker.DeviceBridgeDO {}
export class IMessageBridgeDO extends worker.IMessageBridgeDO {}
export class TaskWorkerDO extends worker.TaskWorkerDO {}
export default worker.handler;
