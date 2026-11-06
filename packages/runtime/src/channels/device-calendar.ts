import {
  DEVICE_CALENDAR_PURPOSES_V1, DEVICE_CONTEXT_CONSENT_VERSION_V1, DEVICE_PLACE_MAX_DEVICES_V1,
  deviceCalendarConsentGrantBatchV1Schema, deviceCalendarConsentWithdrawV1Schema, deviceCalendarSnapshotV1Schema,
  type DeviceCalendarSnapshotV1, type DeviceCalendarStoredV1, type DeviceContextConsentV1,
} from '../../../contracts/src/app/device-context';
import { md5Hex } from './md5';
import type { Change } from './update-cards';

// The owner's phone calendars (DEVICE_CALENDAR), held in the owner's object, the only writer: the calendar consent and its
// epochs, the latest snapshot per phone, and the changes between two snapshots waiting for the update judge. The contract is
// device-context.ts (device calendar). Consent and data live together so a withdrawal deletes in the same transaction.
// Nothing here logs an event, a title or a calendar name.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
// A phone not heard from in this long is dropped whole; events that ended a day ago are dropped at each snapshot.
const PHONE_KEPT_MS = 30 * DAY_MS;
const ENDED_KEPT_MS = DAY_MS;
const RECEIPTS_KEPT_MS = 7 * DAY_MS;
// The changes one snapshot hands the judge; past this, one line says how many more there were.
const CHANGES_PER_SNAPSHOT = 25;
// Changes waiting for a sweep that never comes (an owner with no Google account) are kept at most this long.
const PENDING_KEPT_MS = 2 * DAY_MS;

export type DeviceCalendarError = 'invalid_request' | 'consent_required' | 'consent_withdrawn' | 'epoch_conflict' | 'idempotency_conflict';
type Purpose = (typeof DEVICE_CALENDAR_PURPOSES_V1)[number];
type Sql = Pick<SqlStorage, 'exec'>;
type ConsentRow = { purpose: Purpose; epoch: number; granted_at: number | null; withdrawn_at: number | null };
type StoredEvent = { device_id: string; device_event_id: string; calendar_id: string; start_at: string; end_at: string; all_day: number;
  title: string | null; location: string | null; availability: string; ical_uid: string | null };
// A phone event as a read gives it, with its phone's number (1 is the phone heard from most recently) and its calendar.
export type PhoneEvent = Readonly<{ phone: number; calendar: string | null; account_type: string; start: string; end: string; all_day: boolean;
  title?: string; location?: string; availability: string; ical_uid?: string }>;
export type PhoneCalendarRead = Readonly<{ phones: readonly Readonly<{ phone: number; observed_at: number; times_only: boolean; complete: boolean }>[]; events: readonly PhoneEvent[] }>;

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
const instantOf = (time: string) => Date.parse(time.length === 10 ? `${time}T00:00:00Z` : time);
// The id a change names an event by: stable across snapshots, and no OS id reaches a prompt.
export const phoneEventRef = (deviceId: string, eventId: string) => `phone:${md5Hex(`${deviceId}\u0000${eventId}`).slice(0, 16)}`;

export const deviceCalendarBook = (sql: Sql, now: () => number) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS device_calendar_consent (purpose TEXT PRIMARY KEY, epoch INTEGER NOT NULL, granted_at INTEGER, withdrawn_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS device_calendar_requests (request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS device_calendar_phones (device_id TEXT PRIMARY KEY, platform TEXT NOT NULL, timezone TEXT NOT NULL, times_only INTEGER NOT NULL,
    complete INTEGER NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL, calendars TEXT NOT NULL)`);
  // The same shape as calendar_last_seen (times, all-day, kept since), with what Waldo reads of the event in place of a digest.
  sql.exec(`CREATE TABLE IF NOT EXISTS device_calendar_events (device_id TEXT NOT NULL, device_event_id TEXT NOT NULL, calendar_id TEXT NOT NULL,
    start_at TEXT NOT NULL, end_at TEXT NOT NULL, all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)), title TEXT, location TEXT, availability TEXT NOT NULL,
    ical_uid TEXT, seen_at INTEGER NOT NULL, PRIMARY KEY (device_id, device_event_id))`);
  sql.exec('CREATE TABLE IF NOT EXISTS device_calendar_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, change TEXT NOT NULL)');

  const consent = (purpose: Purpose): ConsentRow | null => sql.exec<ConsentRow>('SELECT purpose, epoch, granted_at, withdrawn_at FROM device_calendar_consent WHERE purpose = ?', purpose).toArray()[0] ?? null;
  const live = (purpose: Purpose) => { const row = consent(purpose); return row !== null && row.granted_at !== null && row.withdrawn_at === null; };
  const view = (purpose: Purpose): DeviceContextConsentV1 => {
    const row = consent(purpose);
    return { signal: 'calendar', purpose, version: DEVICE_CONTEXT_CONSENT_VERSION_V1, status: row === null || row.granted_at === null ? 'not_granted' : row.withdrawn_at === null ? 'granted' : 'withdrawn',
      epoch: row?.epoch ?? 0, granted_at: iso(row?.granted_at ?? null), withdrawn_at: iso(row?.withdrawn_at ?? null) };
  };
  // A withdrawal beats "not asked yet", as for place.
  const refusal = (): DeviceCalendarError | null => DEVICE_CALENDAR_PURPOSES_V1.every(live) ? null
    : DEVICE_CALENDAR_PURPOSES_V1.some(purpose => consent(purpose)?.withdrawn_at != null) ? 'consent_withdrawn' : 'consent_required';
  // A replayed request answers from its receipt; the same id with other content is refused.
  const prior = (requestId: string, operation: string, digest: string): object | DeviceCalendarError | null => {
    const row = sql.exec<{ operation: string; digest: string; response: string }>('SELECT operation, digest, response FROM device_calendar_requests WHERE request_id = ?', requestId).toArray()[0];
    if (!row) return null;
    if (row.operation !== operation || row.digest !== digest) return 'idempotency_conflict';
    return { ...JSON.parse(row.response) as object, replayed: true };
  };
  const keep = (requestId: string, operation: string, digest: string, response: object) => {
    sql.exec('DELETE FROM device_calendar_requests WHERE at < ?', now() - RECEIPTS_KEPT_MS);
    sql.exec('INSERT INTO device_calendar_requests (request_id, operation, digest, response, at) VALUES (?, ?, ?, ?, ?)', requestId, operation, digest, JSON.stringify(response), now());
  };
  const purge = () => {
    for (const table of ['device_calendar_phones', 'device_calendar_events', 'device_calendar_changes']) sql.exec(`DELETE FROM ${table}`);
    sql.exec("DELETE FROM device_calendar_requests WHERE operation = 'ingest'");
  };
  const dropPhone = (deviceId: string) => {
    sql.exec('DELETE FROM device_calendar_events WHERE device_id = ?', deviceId);
    sql.exec('DELETE FROM device_calendar_phones WHERE device_id = ?', deviceId);
  };
  const prune = () => {
    for (const { device_id } of sql.exec<{ device_id: string }>('SELECT device_id FROM device_calendar_phones WHERE received_at < ?', now() - PHONE_KEPT_MS).toArray()) dropPhone(device_id);
    sql.exec('DELETE FROM device_calendar_changes WHERE at < ?', now() - PENDING_KEPT_MS);
  };

  return {
    consents: (): readonly DeviceContextConsentV1[] => DEVICE_CALENDAR_PURPOSES_V1.map(view),
    // Each purpose at the epoch the app last read for it, storage first, all or none. A purpose already granted, sent at its
    // current epoch, is answered as it stands. Model use sits on top of storage.
    grant(body: Readonly<{ request_id: string; purposes: readonly Readonly<{ purpose: Purpose; expected_epoch: number }>[] }>, digest: string): object | DeviceCalendarError {
      const replay = prior(body.request_id, 'consent_grant_batch', digest);
      if (replay !== null) return replay;
      const ordered = [...body.purposes].sort((a, b) => DEVICE_CALENDAR_PURPOSES_V1.indexOf(a.purpose) - DEVICE_CALENDAR_PURPOSES_V1.indexOf(b.purpose));
      if (ordered.some(item => (consent(item.purpose)?.epoch ?? 0) !== item.expected_epoch)) return 'epoch_conflict';
      if (ordered.some(item => item.purpose === 'model_processing') && !live('storage_compute') && !ordered.some(item => item.purpose === 'storage_compute')) return 'consent_required';
      for (const { purpose } of ordered) if (!live(purpose)) {
        sql.exec(`INSERT INTO device_calendar_consent (purpose, epoch, granted_at, withdrawn_at) VALUES (?, 1, ?, NULL)
          ON CONFLICT (purpose) DO UPDATE SET epoch = epoch + 1, granted_at = excluded.granted_at, withdrawn_at = NULL`, purpose, now());
      }
      const response = { consents: ordered.map(item => view(item.purpose)), replayed: false };
      keep(body.request_id, 'consent_grant_batch', digest, response);
      return response;
    },
    // The calendar is kept only for Waldo to read, so withdrawing either purpose withdraws both and deletes what every phone
    // sent, in this same write. A snapshot already on its way carries the old epoch and is refused.
    withdraw(body: Readonly<{ request_id: string; purpose: Purpose; expected_epoch: number }>, digest: string): object | DeviceCalendarError {
      const replay = prior(body.request_id, 'consent_withdraw', digest);
      if (replay !== null) return replay;
      const row = consent(body.purpose);
      if ((row?.epoch ?? 0) !== body.expected_epoch) return 'epoch_conflict';
      if (row === null) return 'consent_required';
      const withdrawing = DEVICE_CALENDAR_PURPOSES_V1.filter(live);
      for (const purpose of withdrawing) sql.exec('UPDATE device_calendar_consent SET epoch = epoch + 1, withdrawn_at = ? WHERE purpose = ?', now(), purpose);
      if (withdrawing.length) purge();
      const response = { consent: view(body.purpose), replayed: false, deletion_routed: withdrawing.length > 0 };
      keep(body.request_id, 'consent_withdraw', digest, response);
      return response;
    },
    // One phone's snapshot: refused without both consents at the epoch the phone read, or outside now; superseded by a later
    // one already kept. Otherwise it replaces the phone's events, and what changed since its last snapshot waits for the judge.
    // A phone's first snapshot is its baseline: nothing in it is news.
    ingest(snapshot: DeviceCalendarSnapshotV1, digest: string): object | DeviceCalendarError {
      const replay = prior(snapshot.request_id, 'ingest', digest);
      if (replay !== null) return replay;
      const refused = refusal();
      if (refused !== null) return refused;
      if (consent('storage_compute')!.epoch !== snapshot.expected_epoch) return 'epoch_conflict';
      const at = now(), observed = Date.parse(snapshot.observed_at), from = Date.parse(snapshot.window.from), to = Date.parse(snapshot.window.to);
      if (observed > at + 10 * 60_000 || observed < at - DAY_MS || from > at + HOUR_MS || to < at || from < at - 2 * DAY_MS || to > at + 16 * DAY_MS) return 'invalid_request';
      prune();
      const answer = (status: 'accepted' | 'superseded') => { const response = { request_id: snapshot.request_id, replayed: false, status }; keep(snapshot.request_id, 'ingest', digest, response); return response; };
      const phone = sql.exec<{ observed_at: number }>('SELECT observed_at FROM device_calendar_phones WHERE device_id = ?', snapshot.device_id).toArray()[0];
      if (phone && phone.observed_at > observed) return answer('superseded');
      if (!phone) {
        const phones = sql.exec<{ device_id: string }>('SELECT device_id FROM device_calendar_phones ORDER BY received_at').toArray();
        for (const { device_id } of phones.slice(0, Math.max(0, phones.length - DEVICE_PLACE_MAX_DEVICES_V1 + 1))) dropPhone(device_id);
      }
      const before = new Map(sql.exec<StoredEvent>('SELECT * FROM device_calendar_events WHERE device_id = ?', snapshot.device_id).toArray().map(row => [row.device_event_id, row]));
      const names = new Map(snapshot.calendars.map(calendar => [calendar.calendar_id, calendar]));
      const changes = phone ? changesBetween(snapshot, before, names, at) : [];
      sql.exec('DELETE FROM device_calendar_events WHERE device_id = ?', snapshot.device_id);
      for (const event of snapshot.events) {
        if (instantOf(event.end) < at - ENDED_KEPT_MS) continue;
        sql.exec(`INSERT INTO device_calendar_events (device_id, device_event_id, calendar_id, start_at, end_at, all_day, title, location, availability, ical_uid, seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, snapshot.device_id, event.device_event_id, event.calendar_id, event.start, event.end, event.all_day ? 1 : 0,
          event.title ?? null, event.location ?? null, event.availability, event.ical_uid ?? null, at);
      }
      sql.exec(`INSERT INTO device_calendar_phones (device_id, platform, timezone, times_only, complete, window_from, window_to, observed_at, received_at, calendars)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET platform = excluded.platform, timezone = excluded.timezone, times_only = excluded.times_only,
          complete = excluded.complete, window_from = excluded.window_from, window_to = excluded.window_to, observed_at = excluded.observed_at, received_at = excluded.received_at,
          calendars = excluded.calendars`,
        snapshot.device_id, snapshot.platform, snapshot.timezone, snapshot.times_only ? 1 : 0, snapshot.complete ? 1 : 0, from, to, observed, at, JSON.stringify(snapshot.calendars));
      for (const change of changes) sql.exec('INSERT INTO device_calendar_changes (at, change) VALUES (?, ?)', at, JSON.stringify(change));
      return answer('accepted');
    },
    // What the update sweep takes in its own transaction: the waiting changes, oldest first, once.
    takeChanges(): readonly Change[] {
      const rows = sql.exec<{ id: number; change: string }>('SELECT id, change FROM device_calendar_changes ORDER BY id').toArray();
      if (rows.length) sql.exec('DELETE FROM device_calendar_changes WHERE id <= ?', rows[rows.length - 1]!.id);
      return rows.map(row => JSON.parse(row.change) as Change);
    },
    stored(): DeviceCalendarStoredV1 {
      prune();
      return { devices: sql.exec<{ device_id: string; platform: 'ios' | 'android'; received_at: number; observed_at: number; times_only: number; complete: number; calendars: string; events: number }>(
        `SELECT p.*, (SELECT count(*) FROM device_calendar_events e WHERE e.device_id = p.device_id) AS events FROM device_calendar_phones p ORDER BY received_at DESC`).toArray()
        .map(row => ({ device_id: row.device_id, platform: row.platform, received_at: iso(row.received_at)!, observed_at: iso(row.observed_at)!, times_only: row.times_only === 1,
          complete: row.complete === 1, calendars: JSON.parse(row.calendars) as DeviceCalendarStoredV1['devices'][number]['calendars'], events: row.events })) };
    },
    // The events overlapping [from, to) for the model, while both consents stand; null without them.
    read(from: number, to: number): PhoneCalendarRead | null {
      if (refusal() !== null) return null;
      prune();
      const phones = sql.exec<{ device_id: string; observed_at: number; times_only: number; complete: number; calendars: string }>(
        'SELECT device_id, observed_at, times_only, complete, calendars FROM device_calendar_phones ORDER BY received_at DESC').toArray();
      const events = phones.flatMap((phone, index) => {
        const calendars = new Map((JSON.parse(phone.calendars) as { calendar_id: string; name?: string; account_type: string }[]).map(calendar => [calendar.calendar_id, calendar]));
        return sql.exec<StoredEvent>('SELECT * FROM device_calendar_events WHERE device_id = ? ORDER BY start_at', phone.device_id).toArray()
          .filter(row => instantOf(row.start_at) < to && instantOf(row.end_at) > from)
          .map((row): PhoneEvent => ({ phone: index + 1, calendar: calendars.get(row.calendar_id)?.name ?? null, account_type: calendars.get(row.calendar_id)?.account_type ?? 'other',
            start: row.start_at, end: row.end_at, all_day: row.all_day === 1, ...(row.title ? { title: row.title } : {}), ...(row.location ? { location: row.location } : {}),
            availability: row.availability, ...(row.ical_uid ? { ical_uid: row.ical_uid } : {}) }));
      }).sort((a, b) => instantOf(a.start) - instantOf(b.start));
      return { phones: phones.map((phone, index) => ({ phone: index + 1, observed_at: phone.observed_at, times_only: phone.times_only === 1, complete: phone.complete === 1 })), events };
    },
  };
};
export type DeviceCalendarBook = ReturnType<typeof deviceCalendarBook>;

// What one phone's snapshot changed against its last: an event new to it, one whose times, title, place or availability moved,
// and, when the snapshot is complete, one gone from inside its window. Only events that have not ended are news. Titles are
// compared only when both snapshots carried one, so turning "times only" on or off is not a change.
const changesBetween = (snapshot: DeviceCalendarSnapshotV1, before: ReadonlyMap<string, StoredEvent>, names: ReadonlyMap<string, Readonly<{ name?: string; account_type: string }>>, at: number): readonly Change[] => {
  const from = Date.parse(snapshot.window.from), to = Date.parse(snapshot.window.to);
  const detail = (id: string, event: Readonly<{ calendar_id: string; start: string; end: string; all_day: boolean; title?: string | null; location?: string | null; availability: string }>) => JSON.stringify({
    id, ...(event.title ? { title: event.title } : {}), start: event.start, end: event.end, all_day: event.all_day, ...(event.location ? { location: event.location } : {}),
    availability: event.availability, source: 'phone', ...(names.get(event.calendar_id)?.name ? { calendar: names.get(event.calendar_id)!.name } : {}), account_type: names.get(event.calendar_id)?.account_type ?? 'other' });
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const event of snapshot.events) {
    seen.add(event.device_event_id);
    if (instantOf(event.end) <= at) continue;
    const id = phoneEventRef(snapshot.device_id, event.device_event_id), was = before.get(event.device_event_id);
    if (!was) { changes.push({ source: 'calendar', kind: 'added', detail: detail(id, event), ref: id }); continue; }
    const titleChanged = !!was.title && !!event.title && was.title !== event.title;
    const moved = was.start_at !== event.start || was.end_at !== event.end || (was.all_day === 1) !== event.all_day;
    const placeChanged = !!was.location && !!event.location && was.location !== event.location;
    if (!moved && !titleChanged && !placeChanged && was.availability === event.availability) continue;
    changes.push({ source: 'calendar', kind: 'changed', detail: detail(id, event), ref: id, before: { start: was.start_at, end: was.end_at, all_day: was.all_day === 1, title_changed: titleChanged } });
  }
  if (snapshot.complete) for (const was of before.values()) {
    if (seen.has(was.device_event_id) || instantOf(was.end_at) <= at || instantOf(was.start_at) >= to || instantOf(was.end_at) <= from) continue;
    const id = phoneEventRef(snapshot.device_id, was.device_event_id);
    changes.push({ source: 'calendar', kind: 'cancelled', detail: detail(id, { ...was, start: was.start_at, end: was.end_at, all_day: was.all_day === 1 }), ref: id,
      before: { start: was.start_at, end: was.end_at, all_day: was.all_day === 1, title_changed: false } });
  }
  if (changes.length <= CHANGES_PER_SNAPSHOT) return changes;
  return [...changes.slice(0, CHANGES_PER_SNAPSHOT), { source: 'calendar', kind: 'more', detail: JSON.stringify({ more_phone_changes: changes.length - CHANGES_PER_SNAPSHOT }) }];
};



// The app's phone-calendar routes, answered by the owner's object behind the Worker's session check. Each body is checked
// against the contract here, so nothing outside it is kept, and every write runs in one transaction with no I/O.
export const APP_DEVICE_CALENDAR_PATH = '/app/v1/device/calendar';
const STATUS: Readonly<Record<DeviceCalendarError, number>> = { invalid_request: 400, consent_required: 403, consent_withdrawn: 403, epoch_conflict: 409, idempotency_conflict: 409 };
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type Parse<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
export const deviceCalendarRequest = async (request: Request, book: DeviceCalendarBook, transaction: <T>(work: () => T) => T): Promise<Response> => {
  const route = new URL(request.url).pathname.slice(APP_DEVICE_CALENDAR_PATH.length);
  if (request.method === 'GET' && route === '/consents') return reply({ consents: book.consents() });
  if (request.method === 'GET' && route === '') return reply(book.stored());
  const writes: Readonly<Record<string, Readonly<{ schema: Parse<never>; write: (body: never, digest: string) => object | DeviceCalendarError }>>> = {
    '/consents/batch': { schema: deviceCalendarConsentGrantBatchV1Schema as Parse<never>, write: (body, digest) => book.grant(body, digest) },
    '/consents/withdraw': { schema: deviceCalendarConsentWithdrawV1Schema as Parse<never>, write: (body, digest) => book.withdraw(body, digest) },
    '': { schema: deviceCalendarSnapshotV1Schema as Parse<never>, write: (body, digest) => book.ingest(body, digest) },
  };
  const write = writes[route];
  if (!write) return reply({ error: 'unavailable' }, 404);
  if (request.method !== 'POST') return reply({ error: 'unavailable' }, 405);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return reply({ error: 'invalid_request' }, 400);
  const text = await request.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return reply({ error: 'invalid_request' }, 400); }
  const parsed = write.schema.safeParse(value);
  if (!parsed.success) return reply({ error: 'invalid_request' }, 400);
  // The request id is the idempotency key. A client may also send it as a header; the two must agree.
  const key = request.headers.get('idempotency-key');
  if (key !== null && key !== (parsed.data as { request_id: string }).request_id) return reply({ error: 'invalid_request' }, 400);
  const answer = transaction(() => write.write(parsed.data, md5Hex(text)));
  return typeof answer === 'string' ? reply({ error: answer }, STATUS[answer]) : reply(answer);
};
