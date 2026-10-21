import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, type ClaimStore } from '../src/memory/claims';
import { consolidationSides, type Episode } from '../src/channels/episodes';

// The nightly pass labels its evidence `owner, day of <trace>` and hands over the owner's own messages by entry id. A
// correction the owner made that day retires the old claim and points the replacement at the message it came from,
// whatever shape the channel gives its entry ids.
let n = 0;
const withSql = <T>(fn: (sql: SqlStorage, tx: <R>(work: () => R) => R) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`nightly-correction-${n++}`)), (_i, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));
const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });
const LEARNED = '2026-10-01T09:00:00Z';
const NIGHT = '2026-10-19T03:00:00Z';
const day = (entryId: string, ownerSaid: string): readonly Episode[] => [
  { entry_id: entryId, speaker: 'owner', at: 1, text: ownerSaid, own: true },
  { entry_id: `${entryId}-reply`, speaker: 'waldo', at: 2, text: 'Noted, Mumbai it is.' },
];
const nightly = (store: ClaimStore, raw: string, episodes: readonly Episode[]) =>
  applyClaimOps(store, raw, NIGHT, 'owner, day of nightly-memory', undefined, consolidationSides(episodes), false, undefined, true);
const withOldClaim = <T>(fn: (store: ClaimStore, oldId: number) => T) => withSql((sql, tx) => {
  const store = claimStore(sql, tx);
  store.add({ kind: 'fact', text: 'Lives in Pune', source: 'stated', evidence: '"I moved to Pune"', origin: 'owner', source_ref: 'owner, tg-1' }, LEARNED);
  return fn(store, store.claims()[0]!.id);
});

describe('corrections in the nightly pass', () => {
  it.each([
    ['app', 'app-1048'],
    ['telegram', 'tg-77'],
    ['an id of any other shape', JSON.stringify(['imessage', 'bridge', 'account', 3, 'evt-9'])],
  ])('a correction from %s supersedes the old claim and names its message', async (_channel, entryId) => {
    const r = await withOldClaim((store, oldId) => {
      const out = nightly(store, ops({ corrections: [{ old_id: oldId, kind: 'fact', text: 'Lives in Mumbai', evidence: '"I live in Mumbai now"' }] }), day(entryId, 'we moved last week, I live in Mumbai now'));
      return { out, oldId, active: store.claims(), superseded: store.claims('superseded'), holds: store.holds() };
    });
    expect(r.out).toContain('corrected1');
    expect(r.active).toMatchObject([{ text: 'Lives in Mumbai', status: 'active', supersedes_id: r.oldId, source_ref: `owner, ${entryId}`, verification_status: 'owner-grounded', origin: 'owner' }]);
    expect(r.superseded).toMatchObject([{ id: r.oldId, valid_to: NIGHT }]);
    expect(r.holds).toEqual([]);
  });

  it('a correction the owner did not say that day is held for review, and the replacement the owner did say is still added', async () => {
    const r = await withOldClaim((store, oldId) => {
      const out = nightly(store, ops({
        corrections: [{ old_id: oldId, kind: 'fact', text: 'Lives in Mumbai', evidence: '"I live in Mumbai now"' }],
        add: [{ kind: 'fact', text: 'Lives in Mumbai', source: 'stated', evidence: '"we are moving to Mumbai"', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }],
      }), day('app-1049', 'we are moving to Mumbai next month'));
      return { out, active: store.claims().map((claim) => [claim.text, claim.status, claim.source_ref]), holds: store.holds().map((hold) => hold.reason) };
    });
    expect(r.out).toContain('correction-not-applied');
    expect(r.out).not.toContain('corrected');
    expect(r.out).toContain('+1 ');
    expect(r.holds).toEqual(['correction-not-applied']);
    expect(r.active).toEqual([['Lives in Mumbai', 'active', 'owner, app-1049'], ['Lives in Pune', 'active', 'owner, tg-1']]);
  });

  it('a correction whose words span two owner messages names no message and is held', async () => {
    const r = await withOldClaim((store, oldId) => {
      const episodes: readonly Episode[] = [
        { entry_id: 'app-1', speaker: 'owner', at: 1, text: 'I live in', own: true },
        { entry_id: 'app-2', speaker: 'owner', at: 2, text: 'Mumbai now', own: true },
      ];
      const out = nightly(store, ops({ corrections: [{ old_id: oldId, kind: 'fact', text: 'Lives in Mumbai', evidence: '"I live in Mumbai now"' }] }), episodes);
      return { out, active: store.claims().map((claim) => claim.text) };
    });
    expect(r.out).toContain('correction-not-applied');
    expect(r.active).toEqual(['Lives in Pune']);
  });
});
