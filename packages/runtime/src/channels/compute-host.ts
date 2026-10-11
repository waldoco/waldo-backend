import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { ComputeExecutor, ComputeRequest, ComputeResult } from '../execution-environment/compute-journal';
import { WorkspaceError } from '@waldo/workspace';

export type ComputeWireRequest = Omit<ComputeRequest, 'assertCurrent'>;
// Service binding only: no owner-controlled URL, credentials, or public route.
export type ComputeService = Readonly<{
  execute(ownerScope: string, request: ComputeWireRequest): Promise<ComputeResult>;
  recover(ownerScope: string, operationId: string): Promise<ComputeResult | null>;
  cancel(ownerScope: string, operationId: string): Promise<void>;
}>;
export const ownerComputeExecutor = (service: ComputeService, ownerScope: string, ctx?: ToolDispatcherContext): ComputeExecutor => {
  const assertCurrent = async () => { await ctx?.assertTaskSourceCurrent?.(); ctx?.runScope?.admit(); };
  return {
    async recover(operationId) { await assertCurrent(); const result = await service.recover(ownerScope, operationId); await assertCurrent(); return result; },
    async execute(request) {
      await assertCurrent();
      const { assertCurrent: check, ...wire } = request;
      const timeoutMs = Math.min(wire.timeoutMs, ctx?.runScope ? ctx.runScope.deadline - Date.now() : wire.timeoutMs);
      if (timeoutMs < 1) throw new WorkspaceError('rejected');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const stop = async () => {
        stopped = true;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([service.cancel(ownerScope, request.operationId), new Promise<never>((_resolve, reject) => { cleanupTimer = setTimeout(() => reject(new WorkspaceError('unavailable')), 2_000); })]); }
        finally { clearTimeout(cleanupTimer); }
      };
      try {
        return await Promise.race([
          service.execute(ownerScope, { ...wire, timeoutMs }).then(async result => { await check(); await assertCurrent(); if (stopped) throw new WorkspaceError('rejected'); return result; }),
          new Promise<never>((_resolve, reject) => {
            const poll = async () => {
              try { await check(); await assertCurrent(); if (!stopped) timer = setTimeout(() => { void poll(); }, 200); }
              catch (error) { try { await stop(); } finally { reject(error); } }
            };
            timer = setTimeout(() => { void poll(); }, 200);
          }),
          new Promise<never>((_resolve, reject) => { deadlineTimer = setTimeout(() => { void stop().then(() => reject(new WorkspaceError('unavailable')), reject); }, timeoutMs + 5_000); }),
        ]);
      } catch (error) { await stop(); throw error; }
      finally { stopped = true; clearTimeout(timer); clearTimeout(deadlineTimer); }
    },
  };
};
