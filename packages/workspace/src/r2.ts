import { sameMapping, validateBinding, validId, WorkspaceError, type BodyRevision, type Bodies, type OwnerBinding, type Admission } from './store';
export type Bucket = Readonly<{ put(key: string, bytes: Uint8Array): Promise<unknown>; get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>; delete(key: string): Promise<unknown> }>;
export const r2Bodies = async (bucket: Bucket | undefined, supplied: OwnerBinding, admit: Admission): Promise<Bodies> => {
  validateBinding(supplied);
  const binding = Object.freeze({ ...supplied });
  const admission = await admit(binding, 'construct');
  if (admission.status !== 'ok') throw new WorkspaceError(admission.status);
  if (!bucket) throw new WorkspaceError('unavailable');
  const key = (body: BodyRevision) => {

    if (!sameMapping(body.binding, binding) || !validId(body.file_id) || !validId(body.blob_id)) throw new WorkspaceError('rejected');
    return `workspace/v1/${encodeURIComponent(binding.environment)}/${encodeURIComponent(binding.namespace)}/${binding.ownerId}/${body.file_id}/${body.blob_id}`;
  };
  return {
    put: async (body, bytes) => { const k = key(body); const a = await admit(binding, 'write'); if (a.status !== 'ok') throw new WorkspaceError(a.status); await bucket.put(k, bytes); },
    get: async body => { const k = key(body); const a = await admit(binding, 'read'); if (a.status !== 'ok') throw new WorkspaceError(a.status); const object = await bucket.get(k); return object ? new Uint8Array(await object.arrayBuffer()) : null; },
    remove: async body => { const k = key(body); const a = await admit(binding, 'delete'); if (a.status !== 'ok') throw new WorkspaceError(a.status); await bucket.delete(k); },
  };
};
