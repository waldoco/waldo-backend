import { browserTaskCheckpointSchema } from '@waldo/contracts';
import { browserTaskContinuity } from './browser-task-continuity';
import type { BrowserGate, BrowserGateOptions } from './browser-gate-types';

// This test/host bridge uses the same durable task and the existing approval desk.
// It neither stores approvals nor allocates a second browser session.
export function browserGate(options: BrowserGateOptions): BrowserGate {
  const host = browserTaskContinuity({ ...options, taskId: options.driver.runId });
  const identity = (owner: string) => { if (owner !== options.ownerId) throw Error('browser task unavailable'); };
  return {
    async command(owner, command) {
      identity(owner);
      const result = await host.command(owner, command);
      if (!result.held) return result;
      if (result.reason) return { held: true, reason: result.reason };
      try {
        const approvalRef = await options.approvals.create(result.proposal);
        return { held: true, proposal: result.proposal, approvalRef };
      } catch (cause) { await host.cancel(owner); throw cause; }
    },
    async approve(owner, proposalId, approvalRef) {
      identity(owner);
      // The ledger's consumed claim precedes any action; the continuity host then
      // reobserves actual state and rechecks its current owner grant before I/O.
      const raw = await options.store.load();
      const parsed = browserTaskCheckpointSchema.safeParse(raw);
      const record = parsed.success ? parsed.data : null, proposal = record?.proposal;
      if (!record || !proposal || proposal.id !== proposalId || record.session.expiresAt <= options.now()
        || record.session.ownerId !== owner || record.taskId !== options.driver.runId || record.origin !== options.driver.origin
        || !await options.approvals.consume(owner, proposal, approvalRef)) {
        await host.finishRun(owner);
        return { status: 'rejected', message: 'The current owner approval is unavailable or expired.' };
      }
      try { return await host.submit(owner, proposalId, approvalRef); }
      finally { await host.finishRun(owner); }
    },
    async deny(owner, proposalId) { identity(owner); await host.deny(owner, proposalId); },
    async finishRun(owner) { identity(owner); await host.finishRun(owner); },
    async expire(owner) {
      identity(owner);
      const parsed = browserTaskCheckpointSchema.safeParse(await options.store.load());
      if (parsed.success && parsed.data.session.expiresAt <= options.now()) await host.cancel(owner);
    },
  };
}
