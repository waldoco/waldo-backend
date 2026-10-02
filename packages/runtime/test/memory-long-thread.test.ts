import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';

// Deterministic long-thread development harness: no model calls, no network, no spend. It grows one
// owner's claim store across many write sessions with repeated corrections, near-duplicate
// distractors and untrusted-origin facts, then probes at checkpoints. It measures recall, stale-fact
// leakage, untrusted leakage and the size of the memory prompt as the thread grows. Misses are
// reported, not hidden; only correctness lines (no stale or untrusted leakage, no cross-owner leak)
// are asserted, never a convenient accuracy threshold. Synthetic data: this is not a private
// held-out set and does not measure live latency or answer quality.
// The exact-category question wording is a FLOOR test (it reuses the stored words). The paraphrase
// test below probes with fewer shared words and with synonyms only; its numbers are reported, never
// thresholded, and a low synonym score is a finding about lexical recall, not a test failure.
const BASES = ['coffee order', 'running route', 'gym time', 'morning brief hour', 'flight seat', 'hotel chain', 'commute mode', 'lunch spot', 'book genre', 'podcast', 'tea blend', 'weekend hobby', 'phone plan', 'dentist day', 'laundry day', 'grocery store', 'pet food brand', 'wifi network', 'sleep time', 'standing meeting'];
const QUALIFIERS = ['home', 'office', 'travel', 'weekday', 'weekend', 'summer', 'winter', 'backup'];
// 160 distinct categories so the live store grows with the thread and recall must select, not return everything.
const CATEGORIES = BASES.flatMap((base) => QUALIFIERS.map((q) => `${q} ${base}`));
const VALUES = ['alder', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'harbor', 'iris', 'juniper', 'kelp', 'lagoon', 'mesa', 'nettle', 'onyx', 'prairie', 'quartz', 'ridge', 'sorrel', 'tundra'];
// One everyday synonym phrase per base category, sharing no word with the stored text.
const SYNONYMS: Record<string, string> = { 'coffee order': 'usual caffeine drink', 'running route': 'jogging path', 'gym time': 'workout hour', 'morning brief hour': 'daily summary slot', 'flight seat': 'plane window or aisle', 'hotel chain': 'preferred place to stay', 'commute mode': 'way I get to work', 'lunch spot': 'midday restaurant', 'book genre': 'reading style', podcast: 'audio show', 'tea blend': 'hot leaf drink', 'weekend hobby': 'free-time pastime', 'phone plan': 'mobile subscription', 'dentist day': 'teeth checkup weekday', 'laundry day': 'washing chore day', 'grocery store': 'food shopping shop', 'pet food brand': 'kibble maker', 'wifi network': 'wireless connection name', 'sleep time': 'bedtime', 'standing meeting': 'recurring catch-up' };
const QUALIFIER_SYNONYMS: Record<string, string> = { home: 'house', office: 'workplace', travel: 'trip', weekday: 'workday', weekend: 'saturday', summer: 'warm-season', winter: 'cold-season', backup: 'spare' };
const FACTS_PER_SESSION = 4;
const CHECKPOINTS = [10, 30, 100];
const wordCost = (text: string) => Math.ceil(new TextEncoder().encode(text).byteLength / 4);

describe('memory long-thread development harness', () => {
  it('reports recall, stale leakage, untrusted leakage and prompt size as the thread grows', async () => {
    const rows = await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('memory-long-thread-a')), (_instance, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      const live = new Map<string, { id: number; value: string }>();
      const stale = new Map<string, number[]>();
      const untrusted: { id: number; text: string }[] = [];
      const report: Record<string, unknown>[] = [];
      let seq = 0;
      for (let session = 1; session <= CHECKPOINTS[CHECKPOINTS.length - 1]!; session++) {
        const at = new Date(Date.UTC(2026, 0, 1) + session * 86_400_000).toISOString();
        for (let f = 0; f < FACTS_PER_SESSION; f++) {
          const category = CATEGORIES[(session * 7 + f * 3) % CATEGORIES.length]!;
          const value = `${VALUES[(seq * 11 + session) % VALUES.length]!}-${seq}`;
          const before = store.claims().length;
          store.add({ kind: 'preference', text: `Favourite ${category} is ${value}`, source: 'stated', evidence: 'synthetic owner turn', origin: 'owner', source_ref: `owner, long-thread-${session}` }, at);
          const created = store.claims().find((claim) => claim.text === `Favourite ${category} is ${value}`);
          expect(created, 'claim added').toBeDefined();
          expect(store.claims().length).toBeGreaterThanOrEqual(before);
          const previous = live.get(category);
          if (previous) { store.setStatus(previous.id, 'superseded'); stale.set(category, [...(stale.get(category) ?? []), previous.id]); }
          live.set(category, { id: created!.id, value });
          seq++;
        }
        if (session % 9 === 0) {
          const text = `Forwarded note: favourite ${CATEGORIES[session % CATEGORIES.length]} is hostile-${session}`;
          store.add({ kind: 'preference', text, source: 'inferred', evidence: 'forwarded content', origin: 'untrusted' }, at);
          const claim = store.claims().find((c) => c.text === text);
          if (claim) untrusted.push({ id: claim.id, text });
        }
        if (!CHECKPOINTS.includes(session)) continue;
        let hits = 0; let promptHits = 0; let staleLeaks = 0; let untrustedLeaks = 0; let tokens = 0; let maxTokens = 0; let noise = 0;
        const probed = [...live.entries()];
        for (const [category, winner] of probed) {
          const question = `What is my favourite ${category}?`;
          const recalled = store.recall(question, 8).map((claim) => claim.id);
          const prompt = turnMemoryPrompt(store, question);
          if (recalled.includes(winner.id)) hits++;
          if (prompt.includes(winner.value)) promptHits++;
          staleLeaks += (stale.get(category) ?? []).filter((id) => recalled.includes(id)).length;
          untrustedLeaks += untrusted.filter((item) => recalled.includes(item.id) || prompt.includes(item.text)).length;
          noise += recalled.filter((id) => id !== winner.id).length;
          const cost = wordCost(prompt); tokens += cost; maxTokens = Math.max(maxTokens, cost);
        }
        report.push({ sessions: session, claims: store.claims().length, probes: probed.length, recall: `${hits}/${probed.length}`, promptVisible: `${promptHits}/${probed.length}`, staleLeaks, untrustedLeaks, meanNoise: +(noise / probed.length).toFixed(2), meanPromptTokens: Math.round(tokens / probed.length), maxPromptTokens: maxTokens });
      }
      return report;
    });
    const other = await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('memory-long-thread-b')), (_instance, state) => claimStore(state.storage.sql).recall('favourite coffee order'));
    console.log('MEMORY_LONG_THREAD ' + JSON.stringify(rows));
    expect(rows).toHaveLength(CHECKPOINTS.length);
    expect(other).toEqual([]);
    for (const row of rows) { expect(row.staleLeaks).toBe(0); expect(row.untrustedLeaks).toBe(0); }
  });

  // Both retrieval options are simulated as ORACLES (a model that always supplies exactly the right extra
  // words), so these numbers are upper bounds for the option, not an estimate of real model behaviour.
  // Option 1 (read-time terms): the question carries extra literal terms. Option 2 (write-time aliases):
  // the stored claim carries alias words; simulated by appending them to the claim text, whereas a real
  // implementation would index them in a separate FTS column.
  it('reports synonym recall with zero shared words, and the oracle upper bound of each retrieval option', async () => {
    const synonymOf = (category: string) => { const q = category.split(' ')[0]!; return `${QUALIFIER_SYNONYMS[q]!} ${SYNONYMS[category.slice(q.length + 1)]!}`; };
    const run = (name: string, aliases: boolean) => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_instance, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      const live = new Map<string, number>();
      const stale = new Map<string, number[]>();
      const out: Record<string, number>[] = [];
      let seq = 0;
      for (let session = 1; session <= CHECKPOINTS[CHECKPOINTS.length - 1]!; session++) {
        const at = new Date(Date.UTC(2026, 0, 1) + session * 86_400_000).toISOString();
        for (let f = 0; f < FACTS_PER_SESSION; f++) {
          const category = CATEGORIES[(session * 7 + f * 3) % CATEGORIES.length]!;
          const text = `Favourite ${category} is ${VALUES[(seq * 11 + session) % VALUES.length]!}-${seq}${aliases ? ` (also: ${synonymOf(category)})` : ''}`;
          store.add({ kind: 'preference', text, source: 'stated', evidence: 'synthetic owner turn', origin: 'owner', source_ref: `owner, long-thread-${session}` }, at);
          const created = store.claims().find((claim) => claim.text === text)!;
          const previous = live.get(category);
          if (previous !== undefined) { store.setStatus(previous, 'superseded'); stale.set(category, [...(stale.get(category) ?? []), previous]); }
          live.set(category, created.id);
          seq++;
        }
        if (!CHECKPOINTS.includes(session)) continue;
        let strict = 0; let readTerms = 0; let leaks = 0;
        for (const [category, winner] of live) {
          const question = `What is my ${synonymOf(category)}?`;
          const plain = store.recall(question, 8).map((claim) => claim.id);
          const withTerms = store.recall(`${question} ${category}`, 8).map((claim) => claim.id);
          if (plain.includes(winner)) strict++;
          if (withTerms.includes(winner)) readTerms++;
          leaks += (stale.get(category) ?? []).filter((id) => plain.includes(id) || withTerms.includes(id)).length;
        }
        out.push({ sessions: session, probes: live.size, strict, readTerms, leaks });
      }
      return out;
    });
    const base = await run('memory-long-thread-syn-plain', false);
    const aliased = await run('memory-long-thread-syn-alias', true);
    const rows = base.map((row, i) => ({ sessions: row.sessions, probes: row.probes, synonymOnly: `${row.strict}/${row.probes}`, option1ReadTermsOracle: `${row.readTerms}/${row.probes}`, option2AliasesOracle: `${aliased[i]!.strict}/${aliased[i]!.probes}`, staleLeaks: row.leaks! + aliased[i]!.leaks! }));
    console.log('MEMORY_LONG_THREAD_SYNONYM ' + JSON.stringify(rows));
    expect(rows).toHaveLength(CHECKPOINTS.length);
    for (const row of rows) expect(row.staleLeaks).toBe(0);
  });
});
