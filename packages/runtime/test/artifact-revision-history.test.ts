import { ownerByteCustody } from '../src/rights/write-custody';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';
import { artifactPage } from '../src/channels/artifact-delivery';

const clock = { timezone: 'UTC', now: () => new Date() };

it('preserves exact saved revisions and private links after revision and reconstructed book', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`artifact-revisions-${crypto.randomUUID()}`)) as DurableObjectStub<TelegramOwnerDO>;
  await runInDurableObject(stub, async (_instance, state) => {
    const bodies = r2ArtifactBodies((env as typeof env & { ARTIFACTS: R2Bucket }).ARTIFACTS, state.id.toString(), ownerByteCustody(state.storage, async () => {}));
    const open = () => artifactBook(state.storage.sql, bodies, clock, () => crypto.randomUUID());
    const original = await open().create({ name: 'Saved brief', kind: 'document', body_markdown: '# Original\nOwner edit preserved' }, 'test');
    const revised = await open().revise({ artifact_id: original.id, expected_revision: 1, body_markdown: '# Revised\nNew facts' }, 'owner-edit');
    expect(revised.status).toBe('ok');
    const reopened = open();
    expect((await reopened.read(original.id, 0, 8000, 1))?.text).toContain('Owner edit preserved');
    expect((await reopened.read(original.id, 0, 8000, 2))?.text).toContain('New facts');
    expect(reopened.revisions(original.id).map(row => row.revision)).toEqual([2, 1]);
    expect(await reopened.revise({ artifact_id: original.id, expected_revision: 1, body_markdown: 'stale edit' }, 'test')).toMatchObject({ status: 'conflict', current_revision: 2 });
    const pinned = await artifactPage(new Request(`https://fixture.invalid/console/artifacts/${encodeURIComponent(original.id)}?revision=1`), reopened);
    expect(pinned?.status).toBe(200);
    expect(await pinned!.text()).toContain('Owner edit preserved');
    expect(await reopened.read(original.id, 0, 8000, 3)).toBeNull();
  });
});
