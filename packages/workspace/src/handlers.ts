import { LIMITS, WorkspaceError, type WorkspaceStore } from './store';
// Pure validated adapters. Core/contracts own actual tool registration and trigger ACLs.
const object = (value: unknown, allowed: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new WorkspaceError('invalid');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { if (typeof value !== 'string') throw new WorkspaceError('invalid'); return value; };
const integer = (value: unknown): number => { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new WorkspaceError('invalid'); return value; };
const result = async (work: () => unknown, taint: 'external' | null) => {
  try { return { ok: true as const, data: await work(), source_taint: taint }; }
  catch (error) { return { ok: false as const, code: error instanceof WorkspaceError ? error.code : 'unavailable', error: error instanceof WorkspaceError ? error.message : 'workspace_unavailable', source_taint: 'external' as const }; }
};
export const workspaceHandlers = (store: WorkspaceStore) => ({
  list: (input: unknown) => result(() => { const a = object(input, ['prefix', 'cursor', 'limit']); return store.list(a.cursor === undefined ? undefined : text(a.cursor), a.limit === undefined ? 20 : integer(a.limit), a.prefix === undefined ? '' : text(a.prefix)); }, 'external'),
  read: (input: unknown) => result(() => { const a = object(input, ['file_id', 'revision', 'offset', 'length']); return store.read(text(a.file_id), integer(a.revision), a.offset === undefined ? 0 : integer(a.offset), a.length === undefined ? 4096 : integer(a.length)); }, 'external'),
  write: (input: unknown) => result(async () => {
    const a = object(input, ['path', 'text', 'mime', 'expected_revision', 'operation_id']);
    const bytes = new TextEncoder().encode(text(a.text)); const mime = text(a.mime);
    if (bytes.length > LIMITS.textWriteBytes || !['text/plain', 'text/markdown'].includes(mime)) throw new WorkspaceError('invalid');
    const meta = await store.write({ path: text(a.path), bytes, mime, expected_revision: integer(a.expected_revision), operation_id: text(a.operation_id), provenance: 'agent_generated' });
    return { file_id: meta.file_id, revision: meta.revision, byte_size: meta.byte_size, sha256: meta.sha256 };
  }, null),
});
