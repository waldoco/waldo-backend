import type { FileMeta, WorkspaceStore } from '@waldo/workspace';
import type { ArtifactDelivery } from './artifact-delivery';
export type WorkspaceDeliveryOptions = Readonly<{ origin(): Promise<string | null>; durable: boolean }>;
const internal: ArtifactDelivery = { status: 'saved_internal', url: null, audience: 'unverified' };
// Host-origin only. The model cannot supply a destination or obtain a public sharing URL.
export const workspaceDelivery = async (store: WorkspaceStore, meta: Pick<FileMeta, 'file_id' | 'revision'>, options?: WorkspaceDeliveryOptions): Promise<ArtifactDelivery> => {
  if (!options?.durable) return internal;
  let base: string | null;
  try { base = await options.origin(); } catch { return internal; }
  if (!base) return internal;
  let url: URL;
  try { url = new URL(base); } catch { return internal; }
  if (url.protocol !== 'https:' || url.origin !== base || url.username || url.password) return internal;
  // Integrity and owner lifecycle admission are rechecked before presenting a stored link.
  await store.export(meta.file_id, meta.revision);
  return { status: 'owner_link', url: `${base}/console/workspace/file?id=${encodeURIComponent(meta.file_id)}&revision=${meta.revision}`, audience: 'owner_authenticated' };
};
