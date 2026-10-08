import { digest, validatePath, WorkspaceError } from '@waldo/workspace';

export type ComputeResult = Readonly<{ bytes: Uint8Array; stdout: string; stderr: string; exitCode: number }>;
export type ComputeRequest = Readonly<{
  operationId: string; argv: readonly string[]; inputs: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  outputPath: string; timeoutMs: number; maxOutputBytes: number; assertCurrent(): Promise<void>;
}>;
export type ComputeExecutor = Readonly<{
  execute(request: ComputeRequest): Promise<ComputeResult>;
  // null means never issued. A pending intent is uncertain and MUST NOT be replayed.
  recover(operationId: string): Promise<ComputeResult | null>;
}>;
export type ComputeRecord = Readonly<{ operationId: string; fingerprint: string; status: 'issued' | 'completed' | 'failed'; result?: ComputeResult }>;
export type ComputeJournal = Readonly<{ transaction<T>(work: (record: ComputeRecord | null) => Readonly<{ record: ComputeRecord | null; value: T }>): T }>;

// Only one operation belongs to a container DO. Intent survives a crash, while
// executable processes never survive cleanup. Recovery observes; it never runs code.
export const journaledCompute = (journal: ComputeJournal, run: (request: ComputeRequest) => Promise<ComputeResult>): ComputeExecutor => {
  const recover = async (operationId: string): Promise<ComputeResult | null> => journal.transaction(record => {
    if (record && record.operationId !== operationId) throw new WorkspaceError('rejected');
    if (record && record.status !== 'completed') throw new WorkspaceError('pending');
    return { record, value: record?.result ?? null };
  });
  return {
    recover,
    async execute(request) {
      validatePath(request.outputPath);
      let inputBytes = 0;
      const paths = new Set<string>();
      for (const input of request.inputs) {
        validatePath(input.path);
        if (paths.has(input.path)) throw new WorkspaceError('invalid');
        paths.add(input.path); inputBytes += input.bytes.byteLength;
      }
      if (inputBytes > 262_144 || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30_000 || !Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 262_144) throw new WorkspaceError('invalid');
      const hashes = await Promise.all(request.inputs.map(async input => [input.path, await digest(input.bytes)]));
      const fingerprint = await digest(new TextEncoder().encode(JSON.stringify([request.operationId, request.argv, hashes, request.outputPath, request.timeoutMs, request.maxOutputBytes])));
      await request.assertCurrent();
      const prior = journal.transaction(record => {
        if (record && (record.operationId !== request.operationId || record.fingerprint !== fingerprint)) throw new WorkspaceError('conflict');
        if (record && record.status !== 'completed') throw new WorkspaceError('pending');
        return { record: record ?? { operationId: request.operationId, fingerprint, status: 'issued' }, value: record?.result ?? null };
      });
      if (prior) return prior;
      try {
        await request.assertCurrent();
        const result = await run(request);
        if (result.bytes.byteLength > request.maxOutputBytes || new TextEncoder().encode(result.stdout + result.stderr).byteLength > 16_384 || result.exitCode !== 0) throw new WorkspaceError('unavailable');
        await request.assertCurrent();
        return journal.transaction(record => {
          if (record?.operationId !== request.operationId || record.fingerprint !== fingerprint || record.status !== 'issued') throw new WorkspaceError('rejected');
          return { record: { ...record, status: 'completed', result }, value: result };
        });
      } catch (error) {
        journal.transaction(record => ({ record: record?.status === 'issued' ? { ...record, status: 'failed' } : record, value: undefined }));
        throw error;
      }
    },
  };
};
