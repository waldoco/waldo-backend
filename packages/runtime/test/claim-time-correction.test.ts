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
  it('a refused correction is a recorded hold with a closed reason, not a silent skip', async () => {
    const r = await run('I like tea');
    expect(r.out).toContain('correction-not-applied');
    expect(r.out).not.toContain('corrected1');
    expect(r.active).toEqual(['Project Posterbot standup is at 08:40 UTC']);
  });
  it('retires the old claim when the replacement is already active', async () => {
    const r = await withSql((sql, tx) => {
      const store = claimStore(sql, tx);
      store.add({ kind: 'fact', text: 'Project Posterbot standup is at 08:40 UTC', source: 'stated', evidence: '"standup at 08:40 UTC"', origin: 'owner' }, AT);
      store.add({ kind: 'fact', text: 'Project Posterbot standup is at 09:10 UTC', source: 'stated', evidence: '"standup is at 09:10 UTC"', origin: 'owner' }, AT);
      const old = store.claims().find((c) => c.text.includes('08:40'))!;
      const out = applyClaimOps(store, ops({ corrections: [{ old_id: old.id, kind: 'fact', text: 'Project Posterbot standup is at 09:10 UTC', evidence: '"the Posterbot standup is now at 09:10 UTC"' }] }), AT, 'owner, tg-1', undefined, { owner: 'the Posterbot standup is now at 09:10 UTC' });
      return { out, active: store.claims().map((c) => c.text) };
    });
    expect(r.out).toContain('corrected1');
    expect(r.active).toEqual(['Project Posterbot standup is at 09:10 UTC']);
  });
  it('does not retire the owner claim when the matching active row is untrusted', async () => {
    const r = await withSql((sql, tx) => {
      const store = claimStore(sql, tx);
      store.add({ kind: 'fact', text: 'Project Posterbot standup is at 08:40 UTC', source: 'stated', evidence: '"standup at 08:40 UTC"', origin: 'owner' }, AT);
      store.add({ kind: 'fact', text: 'Project Posterbot standup is at 09:10 UTC', source: 'inferred', evidence: 'shared note', origin: 'untrusted' }, AT);
      const old = store.claims().find((c) => c.text.includes('08:40'))!;
      const out = applyClaimOps(store, ops({ corrections: [{ old_id: old.id, kind: 'fact', text: 'Project Posterbot standup is at 09:10 UTC', evidence: '"the Posterbot standup is now at 09:10 UTC"' }] }), AT, 'owner, tg-1', undefined, { owner: 'the Posterbot standup is now at 09:10 UTC' });
      return { out, active: store.claims().map((c) => `${c.origin}:${c.text}`) };
    });
    expect(r.out).not.toContain('corrected1');
    expect(r.active).toContain('owner:Project Posterbot standup is at 08:40 UTC');
  });
  it('does not apply a correction whose new value is not in the owner words', async () => {
    const r = await run('when is the Posterbot standup?');
    expect(r.out).not.toContain('corrected1');
    expect(r.active).toEqual(['Project Posterbot standup is at 08:40 UTC']);
    const r2 = await run('the Posterbot standup is at 09:30 UTC');
    expect(r2.out).not.toContain('corrected1');
  });
  it('applies a time-only correction that does not repeat the project name', async () => {
    expect((await run('actually 09:10 UTC')).out).toContain('corrected1');
  });
});
