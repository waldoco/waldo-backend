// The owner's files in the app: GET /app/v1/files/<file_ref> answers a file a chat part named, after the owner DO has checked the
// app session. A file ref is opaque to the app; today it names an exported PDF (exp:<id>).
import { exportFileResponse, type ArtifactExportDownloadDeps } from './artifact-export-download';

export const APP_FILES_PATH = '/app/v1/files';

export const appFileDownload = async (request: Request, deps: ArtifactExportDownloadDeps): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(`${APP_FILES_PATH}/`)) return null;
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { 'cache-control': 'no-store' } });
  let ref: string;
  try { ref = decodeURIComponent(path.slice(APP_FILES_PATH.length + 1)); } catch { ref = ''; }
  return exportFileResponse(ref, deps);
};
