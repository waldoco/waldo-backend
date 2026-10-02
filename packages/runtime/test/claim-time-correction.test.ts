import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore } from '../src/memory/claims';

let n = 0;
const withSql = <T>(fn: (sql: SqlStorage, tx: <R>(work: () => R) => R) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`time-correction-${n++}`)), (_i, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));
const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });
const AT = '2026-10-02T18:00:00Z';

describe('correcting a time or number fact', () => {
  const run = (ownerSaid: string) => withSql((sql, tx) => {
    const store = claimStore(sql, tx);
    store.add({ kind: 'fact', text: 'Project Posterbot standup is at 08:40 UTC', source: 'stated', evidence: '"standup at 08:40 UTC"', origin: 'owner' }, AT);
    const old = store.claims()[0]!;
    const out = applyClaimOps(store, ops({ corrections: [{ old_id: old.id, kind: 'fact', text: 'Project Posterbot standup is at 09:10 UTC', evidence: `"${ownerSaid}"` }] }), AT, 'owner, tg-1', undefined, { owner: ownerSaid });
    return { out, active: store.claims().map((c) => c.text) };
  });
  it('applies a correction that has a correction word and a time', async () => {
    expect((await run('actually the Posterbot standup moved to 09:10 UTC')).out).toContain('corrected1');
  });
  it('applies a plain correction with no marker word', async () => {
    expect((await run('the Posterbot standup is now at 09:10 UTC, move it')).out).toContain('corrected1');
    expect((await run('Posterbot standup: 09:10 UTC')).out).toContain('corrected1');
  });
  it('applies a time-only correction that does not repeat the project name', async () => {
    expect((await run('actually 09:10 UTC')).out).toContain('corrected1');
  });
});
