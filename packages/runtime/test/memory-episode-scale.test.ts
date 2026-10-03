import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { claimStore } from '../src/memory/claims';

// Episode history at thread scale (no model, no network, no spend). The index holds about 2,000 turns of
// distractors with shared words, plus planted facts. Correctness lines are asserted: the planted turn is
// returned, the limit holds, the date range holds, a newer turn is not promoted on recency, a purge clears the
// literal from every row and it never comes back through search. Recall and rank numbers are printed, never
// thresholded. Layer: SOURCE, synthetic data; it measures neither answer quality nor live latency.
const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const TOPICS = ['flight', 'hotel', 'dinner', 'meeting', 'gym', 'invoice', 'visa', 'train', 'doctor', 'budget'];
const PLANTED = [
  { id: 'tg-planted-1', text: 'my sister Priya lands at Terminal 3 on Tuesday evening', query: 'when does Priya land', day: 40 },
  { id: 'tg-planted-2', text: 'the quarterly budget cap for the Lisbon offsite is 14k euros', query: 'Lisbon offsite budget cap', day: 400 },
  { id: 'tg-planted-3', text: 'allergic to cashews, tell any restaurant before ordering', query: 'cashews allergic restaurant', day: 900 },
];

describe('episode history at thread scale', () => {
  it('finds planted turns among 2,000, respects limit and date range, and does not rank by recency', async () => {
    const report = await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('episode-scale-a')), (_instance, state) => {
      const index = episodeIndex(state.storage.sql);
      for (let i = 0; i < 2000; i++) {
        const topic = TOPICS[i % TOPICS.length]!; const other = TOPICS[(i * 7 + 3) % TOPICS.length]!;
        index.add(`tg-${i}`, i % 2 ? 'owner' : 'waldo', `Note ${i}: the ${topic} plan changed again, check the ${other} details later this week`, START + i * (DAY / 2));
      }
      for (const fact of PLANTED) index.add(fact.id, 'owner', fact.text, START + fact.day * DAY / 2);
      const rows = PLANTED.map((fact) => {
        const hits = index.search(fact.query, 8);
        const rank = hits.findIndex((hit) => hit.entry_id === fact.id);
        return { id: fact.id, rank, returned: hits.length };
      });
      const wide = index.search('plan changed details week', 5);
      const from = START + 100 * DAY / 2; const to = START + 120 * DAY / 2;
      const ranged = index.search('plan changed details week', 50, from, to);
      return { count: index.count(), rows, wide: wide.length, rangedAts: ranged.map((hit) => Date.parse(hit.at!)), from, to, rankedFirstEntry: index.search('plan changed details week', 3).map((hit) => hit.entry_id) };
    });
    console.log('MEMORY_EPISODE_SCALE ' + JSON.stringify(report.rows));
    expect(report.count).toBe(2003);
    for (const row of report.rows) { expect(row.rank, row.id).toBeGreaterThanOrEqual(0); expect(row.returned).toBeLessThanOrEqual(8); }
    expect(report.wide).toBe(5);
    expect(report.rangedAts.length).toBeGreaterThan(0);
    for (const at of report.rangedAts) { expect(at).toBeGreaterThanOrEqual(report.from); expect(at).toBeLessThanOrEqual(report.to); }
    // The three newest distractors are not what a broad query returns first: order is relevance, not recency.
    expect(report.rankedFirstEntry).not.toEqual(['tg-1999', 'tg-1998', 'tg-1997']);
  });

  it('a purge clears the forgotten literal from every episode row, and search cannot bring it back', async () => {
    const out = await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('episode-scale-b')), (_instance, state) => {
      const index = episodeIndex(state.storage.sql);
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      for (let i = 0; i < 300; i++) index.add(`tg-${i}`, 'owner', `chat ${i}: nothing special, just the usual ${TOPICS[i % TOPICS.length]} talk`, START + i * DAY);
      for (const i of [11, 120, 250]) index.add(`tg-s${i}`, 'owner', `remember my locker code is cobalt-${i}-lock for the gym`, START + i * DAY);
      store.add({ kind: 'fact', text: 'Locker code is cobalt-11-lock', source: 'stated', evidence: 'synthetic owner turn', origin: 'owner', source_ref: 'owner, tg-s11' }, '2026-02-01T00:00:00.000Z');
      const claim = store.claims().find((c) => c.text === 'Locker code is cobalt-11-lock')!;
      const before = index.search('cobalt locker code', 10).length;
      const purge = store.purge([claim.id], '2026-02-02T00:00:00.000Z', []);
      store.settle([claim.id], []);
      const all = state.storage.sql.exec<{ text: string }>('SELECT text FROM episodes').toArray().map((row) => row.text.toLowerCase());
      return { before, ready: purge.ready, literalLeft: all.filter((text) => text.includes('cobalt-11-lock')).length, otherKept: all.filter((text) => text.includes('cobalt-120-lock')).length, found: index.search('cobalt-11-lock', 10).map((hit) => hit.snippet.toLowerCase()), rows: all.length };
    });
    expect(out.before).toBe(3);
    expect(out.ready).toBe(true);
    expect(out.literalLeft).toBe(0);
    expect(out.found.filter((snippet) => snippet.includes('cobalt-11-lock'))).toEqual([]);
    // Literal-only by design: a different locker code in another turn is not this claim's text.
    expect(out.otherKept).toBe(1);
    expect(out.rows).toBe(303);
  });
});
