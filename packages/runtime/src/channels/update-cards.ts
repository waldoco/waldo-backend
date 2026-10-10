import { calendarPromptProjection, mailPromptProjection, type CalendarChange, type GoogleClient } from '../connectors/google';
import { localIso } from './reminders';

const DAY_MS = 24 * 60 * 60_000;

type Sql = Pick<SqlStorage, 'exec'>;
type WatchKey = 'calendar_since' | 'mail_since';
export const changeLines = (changes: readonly Change[]): string => changes.map((change) => `- ${change.source} ${change.kind}: ${change.detail}${change.source_ref ? ` [source_ref ${change.source_ref}]` : ''}`).join('\n');

export type Change = Readonly<{ source: 'calendar' | 'mail'; kind: 'added' | 'changed' | 'cancelled' | 'new'; detail: string; source_message_id?: string; source_ref?: string; account_id?: string; calendar_id?: string }>;
type Collection = Readonly<{
  key: string; accountId: string | null; calendarId: string; through: number; calendarSince: number | null; mailSince: number | null;
  calendarToken: string | null; mailToken: string | null; calendarDone: boolean; mailDone: boolean; changes: readonly Change[];
  observations: readonly Readonly<{ sourceRef: string; threadId: string; at: number; messageId: string }>[]; cardId: number | null;
}>;
const stateKey = (key: WatchKey, scope?: string) => scope ? `${key}:${scope}` : key;

export const updateBook = (sql: Sql, transaction: <T>(work: () => T) => T = work => work()) => {
  sql.exec('CREATE TABLE IF NOT EXISTS observed_mail (source_ref TEXT PRIMARY KEY, thread_id TEXT NOT NULL, observed_at INTEGER NOT NULL, message_id TEXT NOT NULL, judged INTEGER NOT NULL DEFAULT 0, update_id INTEGER, attached INTEGER NOT NULL DEFAULT 0)');
  sql.exec('CREATE TABLE IF NOT EXISTS watch_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL,
    text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
  try {
    sql.exec('ALTER TABLE update_cards ADD COLUMN feedback TEXT');
  } catch {
    // column already exists
  }
  const state = (key: string) => sql.exec<{ value: string }>('SELECT value FROM watch_state WHERE key = ?', key).toArray()[0]?.value ?? null;
  const setState = (key: string, value: string) => sql.exec('INSERT INTO watch_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  const insertCard = (day: string, at: number, changes: readonly Change[], text: string | null): number => {
    const id = sql.exec<{ id: number }>('INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (?, ?, ?, ?, ?) RETURNING id', at, day, JSON.stringify(changes), text, text === null ? 0 : 1).one().id;
    for (const change of changes) if (change.source_ref) sql.exec('UPDATE observed_mail SET update_id = ? WHERE source_ref = ? AND message_id = ? AND update_id IS NULL', id, change.source_ref, change.source_message_id ?? change.source_ref);
    return id;
  };
  return {
    observeMail(source_ref: string, thread_id: string, at: number, message_id = source_ref): void {
      sql.exec('INSERT INTO observed_mail (source_ref, thread_id, observed_at, message_id) VALUES (?, ?, ?, ?) ON CONFLICT (source_ref) DO UPDATE SET observed_at = excluded.observed_at, message_id = excluded.message_id, judged = 0, update_id = NULL WHERE observed_mail.message_id != excluded.message_id AND observed_mail.observed_at <= excluded.observed_at', source_ref, thread_id, at, message_id);
    },
    pendingMail(): readonly Change[] {
      return sql.exec<{ source_ref: string; detail: string; source_message_id: string }>(`SELECT m.source_ref, json_extract(j.value, '$.detail') AS detail, m.message_id AS source_message_id
        FROM observed_mail m JOIN update_cards c ON c.id = m.update_id, json_each(c.changes) j
        WHERE m.judged = 0 AND json_extract(j.value, '$.source_ref') = m.source_ref AND json_extract(j.value, '$.source_message_id') = m.message_id
        ORDER BY m.observed_at LIMIT 3`).toArray().map(row => ({ source: 'mail', kind: 'new', ...row }));
    },
    judgedMail(changes: readonly Change[]): void {
      for (const change of changes) if (change.source_ref) sql.exec('UPDATE observed_mail SET judged = 1 WHERE source_ref = ? AND message_id = ?', change.source_ref, change.source_message_id ?? change.source_ref);
    },
    pruneMail(now: number): void {
      sql.exec('DELETE FROM observed_mail WHERE attached = 0 AND observed_at < ?', now - 7 * DAY_MS);
    },
    since(key: WatchKey, scope?: string): number | null {
      const value = state(stateKey(key, scope));
      return value === null ? null : Number(value);
    },
    mark(key: WatchKey, now: number, scope?: string): void {
      setState(stateKey(key, scope), String(now));
    },
    collection(key: string): Collection | null { const value = state(`collection:${key}`); return value === null ? null : JSON.parse(value) as Collection; },
    stageCollection(value: Collection): void { setState(`collection:${value.key}`, JSON.stringify(value)); },
    completeCollection(value: Collection): Collection {
      if (!value.calendarDone || !value.mailDone) throw new Error('collection coverage incomplete');
      return transaction(() => {
        for (const observation of value.observations) this.observeMail(observation.sourceRef, observation.threadId, observation.at, observation.messageId);
        // Persist the accepted change list before advancing either watermark. A crash can
        // replay this card, rather than silently skipping source changes after the old cap.
        const cardId = value.changes.length ? insertCard(new Date(value.through).toISOString().slice(0, 10), value.through, value.changes, null) : null;
        const complete = { ...value, cardId }; this.stageCollection(complete);
        if (value.calendarSince !== null) this.mark('calendar_since', value.through, value.accountId ? JSON.stringify([value.accountId, value.calendarId]) : undefined);
        if (value.mailSince !== null) this.mark('mail_since', value.through, value.accountId ?? undefined);
        if (value.changes.length === 0) sql.exec('DELETE FROM watch_state WHERE key = ?', `collection:${value.key}`);
        return complete;
      });
    },
    record(day: string, at: number, changes: readonly Change[], text: string | null): number {
      return transaction(() => {
        const pending = sql.exec<{ key: string; value: string }>("SELECT key, value FROM watch_state WHERE key LIKE 'collection:%'").toArray().map(row => ({ key: row.key, collection: JSON.parse(row.value) as Collection }));
        const previous = pending.find(row => row.collection.cardId !== null && JSON.stringify(row.collection.changes) === JSON.stringify(changes));
        if (previous) {
          const id = previous.collection.cardId!;
          sql.exec('UPDATE update_cards SET day = ?, text = ?, pushed = ? WHERE id = ?', day, text, text === null ? 0 : 1, id);
          sql.exec('DELETE FROM watch_state WHERE key = ?', previous.key);
          return id;
        }
        return insertCard(day, at, changes, text);
      });
    },
    pushed(id: number, text: string): void { sql.exec('UPDATE update_cards SET text = ?, pushed = 1 WHERE id = ?', text, id); },
    rate(id: number, feedback: 'useful' | 'not useful'): boolean {
      return sql.exec('UPDATE update_cards SET feedback = ? WHERE id = ? AND pushed = 1 RETURNING id', feedback, id).toArray().length > 0;
    },
    feedback(limit = 8): string {
      return sql.exec<{ text: string; feedback: string }>('SELECT text, feedback FROM update_cards WHERE feedback IS NOT NULL ORDER BY at DESC LIMIT ?', limit).toArray()
        .map((row) => `- ${row.feedback}: ${row.text.replace(/\n/g, ' ')}`).join('\n');
    },
    unfolded(timezone: string): string {
      return sql.exec<{ at: number; changes: string; text: string | null }>('SELECT at, changes, text FROM update_cards WHERE folded = 0 ORDER BY at').toArray()
        .map((row) => `[${localIso(row.at, timezone)}] ${row.text ? `sent as update: ${row.text.replace(/\n/g, ' ')}` : 'not sent'}\n${changeLines(JSON.parse(row.changes) as Change[])}`)
        .join('\n');
    },
    fold(upTo: number): void {
      sql.exec('UPDATE update_cards SET folded = 1 WHERE at <= ?', upTo);
    },
  };
};
export type UpdateBook = ReturnType<typeof updateBook>;

const toChange = (item: CalendarChange, since: number): Change => {
  const { status, created, ...event } = item;
  const kind = status === 'cancelled' ? 'cancelled' : Date.parse(created) >= since ? 'added' : 'changed';
  return { source: 'calendar', kind, detail: JSON.stringify(calendarPromptProjection(event)) };
};

export const collectChanges = async (book: UpdateBook, google: GoogleClient, now: number, sourceFollowups = false, options: Readonly<{ accountId?: string; calendarId?: string; calendar?: boolean; mail?: boolean; maxPages?: number }> = {}): Promise<readonly Change[]> => {
  const accountId = options.accountId ?? google.account?.connection_id ?? google.account?.email ?? null, calendarId = options.calendarId ?? 'primary';
  const calendarScope = accountId ? JSON.stringify([accountId, calendarId]) : undefined, mailScope = accountId ?? undefined;
  const collectionKey = JSON.stringify([accountId, calendarId, options.calendar !== false, options.mail !== false, sourceFollowups]);
  const durable = typeof book.collection === 'function';
  let collection = durable ? book.collection(collectionKey) : null;
  if (collection?.cardId !== null && collection?.cardId !== undefined) return collection.changes;
  if (!collection) {
    const calendarSince = options.calendar === false ? null : book.since('calendar_since', calendarScope), mailSince = options.mail === false ? null : book.since('mail_since', mailScope);
    if (options.calendar !== false && calendarSince === null) book.mark('calendar_since', now, calendarScope);
    if (options.mail !== false && mailSince === null) book.mark('mail_since', now, mailScope);
    collection = { key: collectionKey, accountId, calendarId, through: now, calendarSince, mailSince, calendarToken: null, mailToken: null, calendarDone: calendarSince === null, mailDone: mailSince === null, changes: [], observations: [], cardId: null };
    if (durable) book.stageCollection(collection);
  }
  const persist = (next: Collection) => { collection = next; if (durable) book.stageCollection(next); };
  for (let page = 0; page < (options.maxPages ?? 4) && !collection.calendarDone; page++) {
    const since = collection.calendarSince!;
    const result = google.changedEventsPage
      ? await google.changedEventsPage(calendarId, since, collection.through, collection.through + 2 * DAY_MS, 50, collection.calendarToken ?? undefined)
      : { events: await google.changedEvents(since, collection.through, collection.through + 2 * DAY_MS), next_page_token: null, calendar_id: calendarId, account: google.account };
    if (!google.changedEventsPage && result.events.length >= 50) throw new Error('Calendar change coverage needs the resumable page adapter');
    if (result.calendar_id !== calendarId || google.account?.connection_id && result.account?.connection_id !== google.account.connection_id || result.next_page_token && result.next_page_token === collection.calendarToken) throw new Error('Calendar change page does not match its source or make progress');
    const changes = result.events.map(item => ({ ...toChange(item, since), ...(accountId ? { account_id: accountId, calendar_id: calendarId } : {}) }));
    persist({ ...collection, changes: [...collection.changes, ...changes], calendarToken: result.next_page_token, calendarDone: result.next_page_token === null });
  }
  for (let page = 0; page < (options.maxPages ?? 4) && !collection.mailDone; page++) {
    const since = collection.mailSince!;
    // Freeze both bounds across all pages. The one-second overlap covers subsecond
    // watermark precision; source IDs and observed-mail identity suppress repeated work.
    const query = `in:inbox category:primary after:${Math.max(0, Math.floor(since / 1000) - 1)} before:${Math.ceil(collection.through / 1000) + 1}`;
    const result = google.mailPage
      ? await google.mailPage(query, 100, collection.mailToken ?? undefined)
      : { messages: await google.newMail(since, 10), next_page_token: null };
    if (!google.mailPage && result.messages.length >= 10) throw new Error('Gmail change coverage needs the resumable page adapter');
    if (result.next_page_token && result.next_page_token === collection.mailToken) throw new Error('Gmail change pagination made no progress');
    const changes: Change[] = [], observations: Collection['observations'][number][] = [];
    for (const item of result.messages) {
      const at = Date.parse(item.at);
      if (!Number.isFinite(at)) throw new Error('Gmail change date unavailable');
      if (at < since || at > collection.through) continue;
      const detail = JSON.stringify(mailPromptProjection(item)), source_ref = accountId ? `mail:${encodeURIComponent(accountId)}:${item.thread_id || item.id}` : `mail:${item.thread_id || item.id}`;
      changes.push({ source: 'mail', kind: 'new', detail, ...(accountId ? { account_id: accountId } : {}), ...(sourceFollowups ? { source_ref, source_message_id: item.id } : {}) });
      if (sourceFollowups) observations.push({ sourceRef: source_ref, threadId: item.thread_id, at, messageId: item.id });
    }
    persist({ ...collection, changes: [...collection.changes, ...changes], observations: [...collection.observations, ...observations], mailToken: result.next_page_token, mailDone: result.next_page_token === null });
  }
  if (!collection.calendarDone || !collection.mailDone) {
    if (!durable) throw new Error('Change coverage needs durable continuation');
    return [];
  }
  if (durable) return book.completeCollection(collection).changes;
  // Minimal injected books are used by pure prompt-projection callers. Production books
  // always persist a card and page continuation before advancing source watermarks.
  if (collection.calendarSince !== null) book.mark('calendar_since', collection.through, calendarScope);
  if (collection.mailSince !== null) book.mark('mail_since', collection.through, mailScope);
  return collection.changes;
};

// One candidate, one existing responder turn, one frozen owner-only intent. The
// ten-minute update lane also calls this when there is no new inbox mail.
export const reviewMailFollowup = async (deps: Readonly<{
  loops: import('./loops').LoopBook;
  now: number;
  timezone: string;
  allowed: boolean;
  ledger(): Promise<string>;
  prompt(text: string): Promise<string>;
  enqueue(text: string, receipt: import('./telegram-final-outbox').MailFollowupReceipt): Promise<void>;
}>): Promise<boolean> => {
  if (!deps.allowed) return false;
  const loop = deps.loops.reviewDue(localIso(deps.now + 60 * 60_000, deps.timezone).slice(0, 16), deps.timezone, deps.now)[0];
  if (!loop?.source_ref || !loop.due) return false;
  const { mailFollowupPrompt, SKIP_UPDATE } = await import('../prompt/update-cards');
  const text = (await deps.prompt(mailFollowupPrompt(localIso(deps.now, deps.timezone), loop, await deps.ledger()))).trim();
  const receipt = { loopId: loop.id, due: loop.due, sourceRef: loop.source_ref, timezone: deps.timezone, messageId: loop.source_message_id! };
  if (!deps.loops.reviewEligible(receipt, deps.timezone)) return false;
  if (!text || text === SKIP_UPDATE) { deps.loops.reviewSkipped(receipt, deps.now); return false; }
  await deps.enqueue(text, receipt);
  return true;
};
