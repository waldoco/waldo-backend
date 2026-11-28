import { TOOL_PERMISSIONS, triggerTypeSchema, writeHomeCardArgsSchema, type ToolHandler, type WriteHomeCardArgs } from '@waldo/contracts';
import { appHomeCardV1Schema, type AppHomeCardV1 } from '../../../contracts/src/app/home-card';
import { numericHealthIn } from '../scribe/sanitiser';
import { guardArtifactLinks } from '../conversation/artifact-link-guard';
import { redactSecretUrls } from './egress-guard';
import type { ToolDispatcherContext } from '../tools/dispatcher';

// GENERAL_WAKE: the one card the owner sees first on Home, written by the general wake, in a lazy owner-object table with one
// row. The app reads it on open with no model call. The row keeps whether the run that wrote it had read other people's words.
type Sql = SqlStorage;
export type HomeCard = Readonly<{ card_id: string; text: string; written_at: number; day: string; outside: boolean }>;
const exists = (sql: Sql) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'home_card'").one().n > 0;

export const homeCardBook = (sql: Sql) => ({
  read(): HomeCard | null {
    if (!exists(sql)) return null;
    const row = sql.exec<{ card_id: string; text: string; written_at: number; day: string; outside: number }>('SELECT card_id, text, written_at, day, outside FROM home_card WHERE id = 1').toArray()[0];
    return row ? { ...row, outside: row.outside === 1 } : null;
  },
  // A card that holds a health reading is refused: the card is shown on a screen, and readings stay in the health views.
  write(card: HomeCard): boolean {
    if (numericHealthIn(card.text)) return false;
    sql.exec('CREATE TABLE IF NOT EXISTS home_card (id INTEGER PRIMARY KEY CHECK (id = 1), card_id TEXT NOT NULL, text TEXT NOT NULL, written_at INTEGER NOT NULL, day TEXT NOT NULL, outside INTEGER NOT NULL)');
    sql.exec(`INSERT INTO home_card (id, card_id, text, written_at, day, outside) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET card_id = excluded.card_id, text = excluded.text, written_at = excluded.written_at, day = excluded.day, outside = excluded.outside`,
    card.card_id, card.text, card.written_at, card.day, card.outside ? 1 : 0);
    return true;
  },
  clear(): void { if (exists(sql)) sql.exec('DELETE FROM home_card'); },
});

// A forget the card carries removes it; the next wake writes a new one from what remains. Nothing is left to retry.
export const forgetHomeCard = (sql: Sql, texts: readonly string[]): number => {
  const topics = [...new Set(texts.map(text => text.trim().toLowerCase()).filter(Boolean))];
  const book = homeCardBook(sql), card = book.read();
  if (card && topics.some(topic => card.text.toLowerCase().includes(topic))) book.clear();
  return 0;
};

// What the app reads: the card for the owner's today, or none.
export const homeCardAnswer = (card: HomeCard | null, today: string): AppHomeCardV1 =>
  appHomeCardV1Schema.parse(card && card.day === today ? { state: 'written', card_id: card.card_id, text: card.text, written_at: card.written_at, day: card.day, from_outside: card.outside } : { state: 'none' });

const allowlist = triggerTypeSchema.options.filter(trigger => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes('write_home_card'));
export const homeCardHandler = (book: ReturnType<typeof homeCardBook>, clock: Readonly<{ now(): number; today(): string; newId?(): string }>) => ({
  name: 'write_home_card',
  description: 'Write the one card the owner sees first on Home: what matters now, in a few plain lines, replacing the card before. Write it when what matters has changed. Never a reading or a number about the body.',
  schema: writeHomeCardArgsSchema,
  trigger_allowlist: allowlist,
  autonomy_gated: false,
  mutates_state: true,
  async handle(args, ctx) {
    // Shown on a screen as Waldo's words, so it meets what every owner-visible text meets: no secret-bearing link, no link to
    // an artifact this run did not make, and no canary (a canary here means the run was steered by injected text).
    const text = guardArtifactLinks(redactSecretUrls(args.text).text, new Set());
    const lower = text.toLowerCase();
    if ((ctx?.session?.canary_tokens ?? []).some(token => lower.includes(token.toLowerCase()))) return { ok: false, code: 'rejected', error: 'The card was not kept.' };
    const now = clock.now();
    const card: HomeCard = { card_id: `home:${clock.newId?.() ?? crypto.randomUUID()}`, text, written_at: now, day: clock.today(), outside: ctx?.toolArgSourceTaint === 'external' || ctx?.carriedOutside === true };
    return book.write(card)
      ? { ok: true, data: { card_id: card.card_id, written: true }, source_taint: null }
      : { ok: false, code: 'rejected', error: 'The card holds a reading or a number about the body, so it was not kept. Say it in words, without the number, and write it again.' };
  },
} satisfies ToolHandler<WriteHomeCardArgs, { card_id: string; written: true }, ToolDispatcherContext>);
