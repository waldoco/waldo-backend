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
  it('reopens known command failure diagnostics without executing again', async () => {
    const failed = { bytes: new Uint8Array(), stdout: '', stderr: 'Missing column: amount', exitCode: 2 };
    const s = state(), run = vi.fn(async () => failed);
    const executor = journaledCompute(s.journal, run);
    expect(await executor.execute(request())).toEqual(failed);
    expect(s.read()?.status).toBe('failed');
    const reopened = journaledCompute(s.journal, run);
    expect(await reopened.recover('operation-1')).toEqual(failed);
    expect(await reopened.execute(request())).toEqual(failed);
    await expect(reopened.execute({ ...request(), argv: ['corrected'] })).rejects.toThrow('workspace_conflict');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('lost current authority leaves no completed receipt', async () => {
    const run = vi.fn(async () => result());
    const closed = state(), check = vi.fn(async () => { throw Error('revoked'); });
    await expect(journaledCompute(closed.journal, run).execute({ ...request(), assertCurrent: check })).rejects.toThrow('revoked');
    expect(closed.read()).toBeNull();
  });
  it('strips terminal controls and discards a failed output body before persisting diagnostics', async () => {
    const s = state();
    const failed = { ...result(), stdout: 'read\u0000\tCSV\n', stderr: '\u001b[31mMissing\rcolumn\u007f', exitCode: 2 };
    const executor = journaledCompute(s.journal, async () => failed);
    const safe = { ...failed, bytes: new Uint8Array(), stdout: 'read\tCSV\n', stderr: '[31mMissingcolumn' };
    expect(await executor.execute(request())).toEqual(safe);
    expect(await executor.recover('operation-1')).toEqual(safe);
  });
  it('revocation after a failed command leaves an uncertain intent without readable diagnostics', async () => {
    const s = state(); let current = true;
    const run = vi.fn(async () => { current = false; return { ...result(), exitCode: 2 }; });
    const executor = journaledCompute(s.journal, run);
    await expect(executor.execute({ ...request(), assertCurrent: async () => { if (!current) throw Error('revoked'); } })).rejects.toThrow('revoked');
    await expect(executor.recover('operation-1')).rejects.toThrow('workspace_pending');
    expect(s.read()?.result).toBeUndefined(); expect(run).toHaveBeenCalledTimes(1);
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
