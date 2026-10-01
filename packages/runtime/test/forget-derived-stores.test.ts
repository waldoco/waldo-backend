import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyClaimOps, claimStore } from '../src/memory/claims';

const MARKER = 'zephyr-quinoa-anchor';
const CLAIM_TEXT = `Owner uses the ${MARKER} code word`;
const AT = '2026-09-26T04:00:00Z';

// Derived text the model later reads back: update cards feed the prompt and day-plan reasons feed
// day cards. A forgotten fact must not survive in either.
it('forgetting a claim also clears derived card and day-plan text', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-derived')), (_instance, state) => {
    const sql = state.storage.sql;
    const store = claimStore(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, card))`);
    const claimId = Number(sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id);
    sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?, ?, ?, ?)', 1, '2026-09-26', JSON.stringify([`noted: ${CLAIM_TEXT}`]), `Heads up: ${CLAIM_TEXT}`);
    sql.exec('INSERT INTO day_plan (day, card, time, reason) VALUES (?, ?, ?, ?)', '2026-09-26', 'morning', '08:00', `because ${CLAIM_TEXT}`);

    const result = applyClaimOps(store, JSON.stringify({ add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null }), AT, 'owner agreed', undefined, undefined, true);

    const left = (table: string, column: string) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} LIKE ?`, `%${MARKER}%`).one().n;
    expect({ cards_text: left('update_cards', 'text'), cards_changes: left('update_cards', 'changes'), day_plan: left('day_plan', 'reason') }).toEqual({ cards_text: 0, cards_changes: 0, day_plan: 0 });
    expect(result).toContain('purged');
    // Rows stay: only the forgotten text is redacted.
    expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM update_cards').one().n).toBe(1);
    expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM day_plan').one().n).toBe(1);
  });
});

it('clears card changes whose forgotten text contains JSON-escaped characters', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-derived-json')), (_instance, state) => {
    const sql = state.storage.sql;
    const store = claimStore(sql);
    const text = `Owner calls it "${MARKER}" and says\nhi`;
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
    const claimId = Number(sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, text, AT, AT).one().id);
    sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?, ?, ?, ?)', 1, '2026-09-26', JSON.stringify([{ source: 'chat', kind: 'note', detail: text }]), null);
    const result = applyClaimOps(store, JSON.stringify({ add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null }), AT, 'owner agreed', undefined, undefined, true);
    expect(sql.exec<{ changes: string }>('SELECT changes FROM update_cards').one().changes).not.toContain(MARKER);
    expect(() => JSON.parse(sql.exec<{ changes: string }>('SELECT changes FROM update_cards').one().changes)).not.toThrow();
    expect(result).toContain('purged');
  });
});
