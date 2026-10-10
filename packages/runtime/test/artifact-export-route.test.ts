import { ownerByteCustody } from '../src/rights/write-custody';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';
import { artifactExports, r2ArtifactBinaries } from '../src/channels/artifact-exports';
import { ARTIFACT_EXPORT_PATH, exportDownloadUrl } from '../src/channels/artifact-export-download';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';

// J6a: the export download route lives in the owner DO behind its console session, per-owner store and bucket prefix.
const bucket = (env as typeof env & { ARTIFACTS: R2Bucket }).ARTIFACTS;
const clock = { timezone: 'UTC', now: () => new Date() };
const owner = (name: string) => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)) as DurableObjectStub<TelegramOwnerDO>;

it('real DO: export download needs the owner session, serves the PDF, and another owner cannot read it by id', async () => {
  const a = owner('export-a'), b = owner('export-b');
  const seeded = await runInDurableObject(a, async (_i, s) => {
    const scope = s.id.toString(), bodies = r2ArtifactBodies(bucket, scope, ownerByteCustody(s.storage, async () => {}));
    const book = artifactBook(s.storage.sql, bodies, clock, () => crypto.randomUUID());
    const meta = await book.create({ name: 'Brief', kind: 'document', body_markdown: '# Brief\n\nowner A only' }, 'test');
    const done = await artifactExports(s.storage.sql, book, bodies, r2ArtifactBinaries(bucket, scope, ownerByteCustody(s.storage, async () => {})), clock, () => crypto.randomUUID()).exportPdf({ artifact_id: meta.id, expected_revision: 1, format: 'pdf' });
    if (!done.ok) throw new Error(`export failed ${done.code}`);
    return { id: done.id, token: await consoleAccess(s.storage).grant() };
  });
  const url = `https://fixture.invalid${ARTIFACT_EXPORT_PATH}/${encodeURIComponent(seeded.id)}`;
  expect(seeded.id).toMatch(/^exp:[0-9a-f-]{36}$/);
  expect((await a.fetch(url)).status).toBe(401); // no session: no body, no existence signal
  const own = await a.fetch(url, { headers: { cookie: `${CONSOLE_COOKIE}=${seeded.token}` } });
  expect(own.status).toBe(200);
  expect(own.headers.get('content-type')).toContain('application/pdf');
  expect(new TextDecoder().decode((await own.arrayBuffer()).slice(0, 5))).toBe('%PDF-');
  expect((await b.fetch(url, { headers: { cookie: `${CONSOLE_COOKIE}=${seeded.token}` } })).status).toBe(401); // A's session is not B's
  const bToken = await runInDurableObject(b, async (_i, s) => consoleAccess(s.storage).grant());
  expect((await b.fetch(url, { headers: { cookie: `${CONSOLE_COOKIE}=${bToken}` } })).status).toBe(404); // B's own session, A's export id
});

it('exportDownloadUrl builds a link only from a bare https origin and a well-formed export id', () => {
  const id = `exp:${crypto.randomUUID()}`;
  expect(exportDownloadUrl('https://staging.invalid', id)).toBe(`https://staging.invalid${ARTIFACT_EXPORT_PATH}/${encodeURIComponent(id)}`);
  for (const base of [null, '', 'http://staging.invalid', 'https://staging.invalid/', 'https://staging.invalid/x', 'https://u:p@staging.invalid', 'not a url']) expect(exportDownloadUrl(base, id)).toBeNull();
  for (const bad of ['', 'exp:', 'art:abc', 'exp:a/b', 'exp:a b', `exp:${'x'.repeat(129)}`]) expect(exportDownloadUrl('https://staging.invalid', bad)).toBeNull();
});
