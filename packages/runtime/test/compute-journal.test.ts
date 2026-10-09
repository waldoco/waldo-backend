import { describe, expect, it, vi } from 'vitest';
import { journaledCompute, type ComputeJournal, type ComputeRecord, type ComputeRequest } from '../src/execution-environment/compute-journal';
import { ownerComputeExecutor } from '../src/channels/compute-host';

const request = (operationId = 'operation-1'): ComputeRequest => ({ operationId, argv: ['node', '-e', ''], inputs: [], outputPath: 'report.md', timeoutMs: 1000, maxOutputBytes: 100, assertCurrent: async () => {} });
const result = () => ({ bytes: new TextEncoder().encode('report'), stdout: 'done', stderr: '', exitCode: 0 });
const state = () => {
  let record: ComputeRecord | null = null;
  const journal: ComputeJournal = { transaction(work) { const next = work(record); record = next.record; return next.value; } };
  return { journal, read: () => record };
};
describe('durable bounded compute intent', () => {
  it('reopens the exact output without executing the command twice', async () => {
    const s = state(), run = vi.fn(async () => result());
    const first = journaledCompute(s.journal, run);
    expect(await first.recover('operation-1')).toBeNull();
    expect(await first.execute(request())).toEqual(result());
    const reopened = journaledCompute(s.journal, run);
    expect(await reopened.recover('operation-1')).toEqual(result());
    expect(await reopened.execute(request())).toEqual(result());
    expect(run).toHaveBeenCalledTimes(1);
    await expect(reopened.execute({ ...request(), argv: ['other'] })).rejects.toThrow('workspace_conflict');
  });
  it('a crash after intent never becomes permission to reexecute', async () => {
    const s = state(); let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const run = vi.fn(async () => { await pending; return result(); });
    const executor = journaledCompute(s.journal, run), first = executor.execute(request());
    await vi.waitFor(() => expect(s.read()?.status).toBe('issued'));
    const reopened = journaledCompute(s.journal, run);
    await expect(reopened.recover('operation-1')).rejects.toThrow('workspace_pending');
    await expect(reopened.execute(request())).rejects.toThrow('workspace_pending');
    release(); await first; expect(run).toHaveBeenCalledTimes(1);
  });
  it('a failed command or lost current authority has no completed receipt', async () => {
    const s = state(), run = vi.fn(async () => ({ ...result(), exitCode: 1 }));
    const executor = journaledCompute(s.journal, run);
    await expect(executor.execute(request())).rejects.toThrow();
    expect(s.read()?.status).toBe('failed');
    await expect(executor.recover('operation-1')).rejects.toThrow('workspace_pending');
    await expect(executor.execute(request())).rejects.toThrow('workspace_pending');
    expect(run).toHaveBeenCalledTimes(1);
    const closed = state(), check = vi.fn(async () => { throw Error('revoked'); });
    await expect(journaledCompute(closed.journal, run).execute({ ...request(), assertCurrent: check })).rejects.toThrow('revoked');
    expect(closed.read()).toBeNull();
  });
  it('rejects oversized output and traversal before recording success', async () => {
    const s = state(), run = vi.fn(async () => ({ ...result(), bytes: new Uint8Array(101) }));
    const executor = journaledCompute(s.journal, run);
    await expect(executor.execute({ ...request(), outputPath: '../outside' })).rejects.toThrow();
    expect(s.read()).toBeNull();
    await expect(executor.execute(request())).rejects.toThrow();
    expect(s.read()?.status).toBe('failed');
  });
});
describe('owner compute service fence', () => {
  it('uses host owner scope and rechecks before returning readback', async () => {
    const service = { execute: vi.fn(async (_owner: string, _request: unknown) => result()), recover: vi.fn(async () => result()), cancel: vi.fn(async () => {}) };
    const executor = ownerComputeExecutor(service, 'owner-do-id');
    expect(await executor.execute(request())).toEqual(result());
    expect(service.execute.mock.calls[0]?.[0]).toBe('owner-do-id');
    expect(await executor.recover('operation-1')).toEqual(result());
  });
  it('revocation destroys an in-flight compute environment and refuses its result', async () => {
    let current = true;
    const service = { execute: vi.fn(async () => new Promise<ReturnType<typeof result>>(() => {})), recover: vi.fn(async () => null), cancel: vi.fn(async () => {}) };
    const executor = ownerComputeExecutor(service, 'owner-do-id', { assertTaskSourceCurrent: async () => { if (!current) throw Error('revoked'); } } as never);
    current = false;
    const pending = executor.execute(request());
    await expect(pending).rejects.toThrow('revoked');
    // Revocation before issue needs no remote cleanup.
    expect(service.execute).not.toHaveBeenCalled();
    current = true;
    const running = executor.execute(request());
    await vi.waitFor(() => expect(service.execute).toHaveBeenCalledTimes(1));
    current = false;
    await expect(running).rejects.toThrow('revoked');
    expect(service.cancel).toHaveBeenCalled();
  });
});
