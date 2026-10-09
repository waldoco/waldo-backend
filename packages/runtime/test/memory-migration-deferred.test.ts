import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { createOwnerResponder } from '../src/channels/owner-turn';

// A deferred memory migration must not look like a finished one: the caller marks the legacy
// notes migrated on a normal return, so a deferral has to surface as a failure it can trace and retry.
it('a migration deferred for incomplete forget coverage is a failure, not a completed migration', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('migration-deferred')), async (_i, state) => {
    const memory = claimStore(state.storage.sql);
    memory.beginTopicCoverage('coffee', '2026-10-08T00:00:00Z');
    const responder = createOwnerResponder('fixture', undefined, memory);
    await expect(responder.migrate('tg-migrate', 'Notes files to split')).rejects.toThrow('forgetting coverage incomplete');
  });
});
