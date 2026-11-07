import { APP_GOOGLE_PICTURE_MEDIA_V1, APP_GOOGLE_PICTURE_PATH_V1 } from '../../../contracts/src/app/controls';
import { googlePictureUrl } from '../connectors/google';

// A Google account's picture, fetched by Waldo so the phone never reaches Google's image host. The app names a picture by a
// key derived from the account and the picture's address: it reveals neither, and changes when the picture does.
const PICTURE_MAX_BYTES = 1_048_576;
const PICTURE_TIMEOUT_MS = 3_000;
const KEY = /^[a-f0-9]{32}$/;

const keyOf = async (account: string, url: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${account}\n${url}`)))].slice(0, 16).map(byte => byte.toString(16).padStart(2, '0')).join('');

// The picture address each account's latest connect gave, from the stored Google profiles; an address that is no longer
// accepted is left out.
export const googlePictures = (profiles: Readonly<Record<string, Readonly<{ picture?: unknown }>>> | undefined): ReadonlyMap<string, string> =>
  new Map(Object.entries(profiles ?? {}).flatMap(([account, profile]) => { const url = googlePictureUrl(profile.picture); return url ? [[account, url] as const] : []; }));

// The app path for each account that has a picture.
export const googlePicturePaths = async (pictures: ReadonlyMap<string, string>): Promise<ReadonlyMap<string, string>> =>
  new Map(await Promise.all([...pictures].map(async ([account, url]) => [account, `${APP_GOOGLE_PICTURE_PATH_V1}/${await keyOf(account, url)}`] as const)));

const refuse = (error: string, status: number) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

const boundedBytes = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> => {
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > PICTURE_MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
};

// Redirects are not followed: Waldo fetches only the address it kept, which was checked when it was stored and again here.
export async function appGooglePicture(request: Request, pictures: () => Promise<ReadonlyMap<string, string>>, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'GET') return refuse('method_not_allowed', 405);
  const url = new URL(request.url), key = url.pathname.slice(APP_GOOGLE_PICTURE_PATH_V1.length + 1);
  if (url.search || !KEY.test(key)) return refuse('not_found', 404);
  let source: string | undefined;
  for (const [account, picture] of await pictures()) if (await keyOf(account, picture) === key) source = googlePictureUrl(picture);
  if (!source) return refuse('not_found', 404);
  let response: Response;
  try { response = await fetcher(source, { redirect: 'manual', headers: { accept: APP_GOOGLE_PICTURE_MEDIA_V1.join(', ') }, signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS) }); }
  catch { return refuse('picture_unavailable', 502); }
  const media = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (response.status !== 200 || !response.body || !(APP_GOOGLE_PICTURE_MEDIA_V1 as readonly string[]).includes(media) || declared > PICTURE_MAX_BYTES) {
    await response.body?.cancel();
    return refuse('picture_unavailable', 502);
  }
  let bytes: Uint8Array | null;
  try { bytes = await boundedBytes(response.body); } catch { return refuse('picture_unavailable', 502); }
  if (!bytes) return refuse('picture_unavailable', 502);
  return new Response(bytes, { status: 200, headers: { 'content-type': media, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
}
