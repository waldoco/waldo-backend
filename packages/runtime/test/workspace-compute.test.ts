// Local handler proof with a labelled fake executable provider. These tests do not
// claim Linux process isolation or live Cloudflare execution.
import { describe, expect, it, vi } from 'vitest';
import { workspaceStore, type WorkspaceState } from '@waldo/workspace';
import { workspaceComputeArgsSchema } from '@waldo/contracts';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { workspaceComputeHandler, workspaceComputeOperationId, type WorkspaceComputeExecutor, type WorkspaceComputeResult } from '../src/tools/live/workspace-compute';

const id = (n: number) => `abcdefab-cdef-4abc-8abc-${n.toString(16).padStart(12, '0')}`;
const bytes = (text: string) => new TextEncoder().encode(text);
const ctx = { authenticatedUserId: id(1), turnId: 'owner-turn', toolCallId: 'compute-call' };
const fixture = async (withEffects = false) => {
  const rows = new Map<string, unknown>();
  const storage = { transactionSync: (work: () => unknown) => work(), kv: { get: (key: string) => structuredClone(rows.get(key)), put: (key: string, value: unknown) => { rows.set(key, structuredClone(value)); }, list: ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))) } };
  const effects = ownerEffectLedger(storage as never, () => 0);
  let state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] };
  const objects = new Map<string, Uint8Array>(); let n = 20; let admitted = true;
  const store = await workspaceStore({ binding: { ownerId: id(1), environment: 'test', namespace: 'ns', doName: 'owner', doId: 'do', stateVersion: 0, mappingVersion: 1 }, admit: async () => ({ status: admitted ? 'ok' : 'rejected' }), metadata: { transaction(work) { const copy = structuredClone(state); const result = work(copy); state = copy; return result; } }, bodies: { put: async (body, value) => { objects.set(body.blob_id, value.slice()); }, get: async body => objects.get(body.blob_id) ?? null, remove: async body => { objects.delete(body.blob_id); } }, now: () => 0, newId: () => id(n++) });
  const source = await store.write({ path: 'expenses.csv', bytes: bytes('category,amount\nFood,10\nFood,15\nTravel,30\n'), mime: 'text/csv', expected_revision: 0, operation_id: id(2), provenance: 'owner_upload' });
  const result: WorkspaceComputeResult = { bytes: bytes('# Expense report\nFood: 25\nTravel: 30\nTotal: 55\n'), stdout: '3 rows processed', stderr: '', exitCode: 0 };
  const completed = new Map<string, WorkspaceComputeResult>();
  const execute = vi.fn<WorkspaceComputeExecutor['execute']>(async request => { await request.assertCurrent(); completed.set(request.operationId, result); return result; });
  const recover = vi.fn<WorkspaceComputeExecutor['recover']>(async operation => completed.get(operation) ?? null);
  const handler = () => workspaceComputeHandler(async () => store, () => ({ execute, recover }), { origin: async () => 'https://owner.example', durable: true }, withEffects ? ownerEffectLedger(storage as never, () => 0) : undefined);
  const args = () => workspaceComputeArgsSchema.parse({ argv: ['python3', 'report.py'], inputs: [{ file_id: source.file_id, revision: 1, path: 'input.csv' }], output_path: 'result.md', path: 'reports/expenses.md', mime: 'text/markdown', expected_revision: 0 });
  const call = (context = ctx) => handler().handle(args(), context as never);
  return { effects, rows, store, source, args, call, handler, execute, recover, completed, result, state: () => state, objects, revoke: () => { admitted = false; } };
};

describe('workspace_compute handler with fake provider', () => {
  it('returns terminal failure diagnostics after reopen and accepts correction only as a new invocation', async () => {
    const w = await fixture(true);
    const failed = { bytes: bytes('partial output must not be saved'), stdout: 'CSV read', stderr: 'Missing column: amount', exitCode: 2 };
    w.execute.mockImplementationOnce(async request => { w.completed.set(request.operationId, failed); return failed; });
    const first = await w.call();
    expect(first).toMatchObject({ ok: false, code: 'rejected', source_taint: 'external', error: expect.stringContaining('Missing column: amount') });
    if (first.ok) throw Error('failed command claimed success');
    expect(first.error).toContain('code 2'); expect(first.error).toContain('CSV read');
    expect(await w.call()).toMatchObject({ ok: false, error: expect.stringContaining('code 2 (recovered)') });
    expect(w.state().files).toHaveLength(1);
    expect(await w.handler().handle({ ...w.args(), argv: ['node', 'corrected.js'] }, ctx as never)).toMatchObject({ ok: false });
    expect(w.execute).toHaveBeenCalledTimes(1);
    expect(await w.handler().handle({ ...w.args(), argv: ['node', 'corrected.js'] }, { ...ctx, toolCallId: 'corrected-call' } as never)).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(w.execute).toHaveBeenCalledTimes(2);
    expect(w.state().files).toHaveLength(2);
  });
  it('reserves the owner effect before provider issue and settles its exact artifact receipt', async () => {
    const w = await fixture(true); w.execute.mockImplementation(async request => {
      const reserved = [...w.rows.values()] as any[]; expect(reserved).toHaveLength(1);
      expect(reserved[0]).toMatchObject({ state: 'attempting', owner_ref: ctx.authenticatedUserId, tool: 'workspace_compute', payload: w.args() });
      w.completed.set(request.operationId, w.result); return w.result;
    });
    expect(await w.call()).toMatchObject({ ok: true });
    expect([...w.rows.values()]).toEqual([expect.objectContaining({ state: 'done', receipt: expect.objectContaining({ provider_id: expect.any(String) }) })]);
  });
  it('keeps terminal failure previews inside the dispatcher error limit', async () => {
    const w = await fixture(true);
    w.execute.mockResolvedValue({ ...w.result, exitCode: 2, stdout: '\n'.repeat(2000), stderr: 'Missing column\n'.repeat(500) });
    const out = await w.call();
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('[truncated]') });
    if (out.ok) throw Error('failed command claimed success');
    expect(out.error.length).toBeLessThanOrEqual(512); expect(out.error).toContain('stderr='); expect(out.error).toContain('stdout=');
    expect(w.state().files).toHaveLength(1);
  });
  it('changed arguments under the same owner call cannot issue another effect', async () => {
    const w = await fixture(true); expect(await w.call()).toMatchObject({ ok: true });
    expect(await w.handler().handle({ ...w.args(), argv: ['node', '-e', 'different'] }, ctx as never)).toMatchObject({ ok: false });
    expect(w.execute).toHaveBeenCalledTimes(1); expect(w.rows.size).toBe(1);
    expect(await w.call()).toMatchObject({ ok: true, data: { recovered: true } });
  });
  it('reconstructed ledger recovers accepted-but-unconfirmed compute without issuing again', async () => {
    const w = await fixture(true);
    w.recover.mockResolvedValueOnce(null).mockRejectedValueOnce(Error('readback temporarily unavailable'));
    w.execute.mockImplementation(async request => { w.completed.set(request.operationId, w.result); throw Error('response lost'); });
    expect(await w.call()).toMatchObject({ ok: false, code: 'transient' });
    expect([...w.rows.values()]).toEqual([expect.objectContaining({ state: 'unknown' })]);
    expect(await w.handler().handle(w.args(), ctx as never)).toMatchObject({ ok: true, data: { recovered: true } });
    expect(w.execute).toHaveBeenCalledTimes(1); expect([...w.rows.values()]).toEqual([expect.objectContaining({ state: 'done' })]);
  });
  it('unknown reserved effect remains visible and never reissues an unconfirmed operation', async () => {
    const w = await fixture(true); w.execute.mockRejectedValue(Error('response lost')); w.recover.mockResolvedValue(null);
    expect(await w.call()).toMatchObject({ ok: false }); expect(await w.call()).toMatchObject({ ok: false });
    expect(w.execute).toHaveBeenCalledTimes(1); expect(w.state().files).toHaveLength(1);
    expect([...w.rows.values()]).toEqual([expect.objectContaining({ state: 'unknown' })]);
  });
  it('exports exact uploaded bytes, saves/readbacks derived report and issues owner download receipt', async () => {
    const w = await fixture(); const out = await w.call();
    expect(out).toMatchObject({ ok: true, source_taint: 'external', data: { status: 'completed', recovered: false, stdout: '3 rows processed', delivery: { status: 'owner_link', audience: 'owner_authenticated' } } });
    if (!out.ok) throw Error('missing receipt');
    expect(w.execute.mock.calls[0]![0].inputs).toEqual([{ path: 'input.csv', bytes: (await w.store.export(w.source.file_id, 1)).bytes }]);
    expect(Object.keys(w.execute.mock.calls[0]![0]).sort()).toEqual(['argv', 'assertCurrent', 'inputs', 'maxOutputBytes', 'operationId', 'outputPath', 'timeoutMs']);
    const saved = await w.store.export(out.data.file_id, out.data.revision);
    expect(saved.bytes).toEqual(w.result.bytes); expect(saved.meta.provenance).toBe('sandbox_output'); expect(saved.meta.sha256).toBe(out.data.sha256);
    expect(out.data.delivery.url).toBe(`https://owner.example/console/workspace/file?id=${out.data.file_id}&revision=1`);
  });
  it('reopens from durable workspace receipt without executing or recovering provider again', async () => {
    const w = await fixture(); const first = await w.call(); const next = await w.call();
    expect(first.ok).toBe(true); expect(next).toMatchObject({ ok: true, data: { recovered: true } });
    expect(w.execute).toHaveBeenCalledTimes(1); expect(w.recover).toHaveBeenCalledTimes(1); expect(w.state().files).toHaveLength(2);
  });
  it('recovers completed compute after interruption before workspace save without command replay', async () => {
    const w = await fixture(); const operation = await workspaceComputeOperationId(w.args(), ctx as never);
    w.completed.set(operation, w.result);
    expect(await w.call()).toMatchObject({ ok: true, data: { recovered: true } }); expect(w.execute).not.toHaveBeenCalled(); expect(w.state().files).toHaveLength(2);
  });
  it('does not reissue an uncertain operation or invent an artifact receipt', async () => {
    const w = await fixture(); w.recover.mockRejectedValue(Error('issued outcome is unknown'));
    expect(await w.call()).toMatchObject({ ok: false, code: 'transient' }); expect(w.execute).not.toHaveBeenCalled(); expect(w.state().files).toHaveLength(1);
  });
  it('denies unavailable owner authority and closed source before any provider I/O', async () => {
    const w = await fixture(); w.revoke(); expect(await w.call()).toMatchObject({ ok: false, code: 'rejected' }); expect(w.execute).not.toHaveBeenCalled(); expect(w.recover).not.toHaveBeenCalled();
    const closed = await fixture(); expect(await closed.call({ ...ctx, assertTaskSourceCurrent: async () => { throw Error('closed'); } } as never)).toMatchObject({ ok: false }); expect(closed.recover).not.toHaveBeenCalled();
  });
  it('rechecks owner authority after execution before saving returned bytes', async () => {
    const w = await fixture(); w.execute.mockImplementation(async () => { w.revoke(); return w.result; });
    expect(await w.call()).toMatchObject({ ok: false, code: 'rejected' }); expect(w.state().files).toHaveLength(1);
  });
  it('rejects traversal, input/output alias and duplicate mount paths before provider', async () => {
    for (const change of [{ output_path: '../outside' }, { output_path: 'input.csv' }, { inputs: [{ file_id: id(20), revision: 1, path: 'input.csv' }, { file_id: id(20), revision: 1, path: 'input.csv' }] }]) {
      const w = await fixture(); expect(await w.handler().handle({ ...w.args(), ...change } as never, ctx as never)).toMatchObject({ ok: false, code: 'invalid_args' }); expect(w.recover).not.toHaveBeenCalled();
    }
  });
  it('keeps nonzero exit, oversized output and oversized UTF8 logs out of workspace', async () => {
    for (const result of [{ exitCode: 1 }, { bytes: new Uint8Array(256 * 1024 + 1) }, { stdout: '😀'.repeat(4097) }]) {
      const w = await fixture(); w.execute.mockResolvedValue({ ...w.result, ...result }); expect(await w.call()).toMatchObject({ ok: false }); expect(w.state().files).toHaveLength(1);
    }
  });
  it('rejects aggregate input bytes beyond 256KiB before command issue', async () => {
    const w = await fixture(); const extra = await w.store.write({ path: 'large.csv', bytes: new Uint8Array(256 * 1024), mime: 'text/csv', expected_revision: 0, operation_id: id(3), provenance: 'owner_upload' });
    expect(await w.handler().handle({ ...w.args(), inputs: [...w.args().inputs, { file_id: extra.file_id, revision: 1, path: 'extra.csv' }] }, ctx as never)).toMatchObject({ ok: false, code: 'oversize' }); expect(w.execute).not.toHaveBeenCalled();
  });
  it('binds operation identity to owner invocation and validated command arguments', async () => {
    const w = await fixture(); const original = await workspaceComputeOperationId(w.args(), ctx as never);
    expect(await workspaceComputeOperationId({ ...w.args(), argv: ['python3', 'different.py'] }, ctx as never)).not.toBe(original);
    expect(await workspaceComputeOperationId(w.args(), { ...ctx, authenticatedUserId: id(9) } as never)).not.toBe(original);
    expect(await w.handler().handle(w.args(), { authenticatedUserId: id(1) } as never)).toMatchObject({ ok: false, code: 'rejected' });
  });
  it('CAS conflict preserves existing target and retries only recovered output', async () => {
    const w = await fixture(); await w.store.write({ path: w.args().path, bytes: bytes('Owner version'), mime: 'text/markdown', expected_revision: 0, operation_id: id(4), provenance: 'owner_upload' });
    expect(await w.call()).toMatchObject({ ok: false, code: 'rejected' }); expect(await w.call()).toMatchObject({ ok: false, code: 'rejected' }); expect(w.execute).toHaveBeenCalledTimes(1);
  });
});
