import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';
import { artifactExports, r2ArtifactBinaries } from '../src/channels/artifact-exports';
import { APP_FILES_PATH } from '../src/channels/app-files';

const bucket = (env as typeof env & { ARTIFACTS: R2Bucket }).ARTIFACTS;
const clock = { timezone: 'UTC', now: () => new Date() };
const OWNER_ID = '6c4d5e6f-7081-4b9c-8dbe-2f3a4b5c6d7e';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
afterEach(() => { vi.unstubAllGlobals(); });
const directoryAnswers = () => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
  const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
  if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
  return new Response('unexpected', { status: 500 });
});
const seedExport = (stub: DurableObjectStub) => runInDurableObject(stub, async (_i, s) => {
  const scope = s.id.toString(), bodies = r2ArtifactBodies(bucket, scope);
  const book = artifactBook(s.storage.sql, bodies, clock, () => crypto.randomUUID());
  const meta = await book.create({ name: 'Boarding pass', kind: 'document', body_markdown: '# Fictional boarding pass\n\nSeat 12A' }, 'test');
  const done = await artifactExports(s.storage.sql, book, bodies, r2ArtifactBinaries(bucket, scope), clock, () => crypto.randomUUID()).exportPdf({ artifact_id: meta.id, expected_revision: 1, format: 'pdf' });
  if (!done.ok) throw new Error(`export failed ${done.code}`);
  return done.id;
});
const appGet = (name: string, path: string, init: { method?: string; hash?: string } = {}) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_i, state) => {
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined });
  const response = await owner.fetch(new Request(`https://telegram-owner${path}`, { method: init.method ?? 'GET', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': init.hash ?? 'a'.repeat(64) } }));
  return { status: response.status, type: response.headers.get('content-type') ?? '', head: new TextDecoder().decode((await response.arrayBuffer()).slice(0, 5)) };
});

it('real DO: the app reads its own exported PDF through the app session; no session, another owner or a write reads nothing', async () => {
  const name = `app-files-${crypto.randomUUID()}`, other = `app-files-other-${crypto.randomUUID()}`;
  const id = await seedExport(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)));
  directoryAnswers();
  const path = `${APP_FILES_PATH}/${encodeURIComponent(id)}`;
  expect(await appGet(name, path)).toMatchObject({ status: 200, head: '%PDF-' });
  expect((await appGet(name, path)).type).toContain('application/pdf');
  expect((await appGet(name, path, { hash: 'not-a-session' })).status).toBe(403);
  expect((await appGet(other, path)).status).toBe(404);
  expect((await appGet(name, path, { method: 'POST' })).status).toBe(405);
  expect((await appGet(name, `${APP_FILES_PATH}/${encodeURIComponent('exp:missing')}`)).status).toBe(404);
});
