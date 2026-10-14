// Reserved sole owner of the raw Durable Object alarm slot (ADR-0065: a DO has one
// alarm slot; scattered setAlarm calls silently overwrite each other, so all alarm
// registration flows through this single seam). This is the only `.setAlarm(` in the
// repo — guard-setalarm exempts this exact file and blocks the call everywhere else.
// setAlarm is awaited so the caller observes alarm registration completion, not fire-and-forget.
export async function armAlarm(storage: Pick<DurableObjectStorage, 'setAlarm'>, scheduledTimeMs: number): Promise<void> {
  await storage.setAlarm(scheduledTimeMs);
}

export const APP_INBOX_DUE_KEY = 'app_inbox_due_v1';

// Admission publishes its payload and wake atomically before acknowledging the send.
export async function persistAppInboxWake(txn: DurableObjectTransaction, due: number): Promise<void> {
  await txn.put(APP_INBOX_DUE_KEY, due);
  const existing = await txn.getAlarm();
  await armAlarm(txn, existing === null ? due : Math.min(existing, due));
}

export const COMMON_EXECUTION_DUE_KEY = 'common_execution_due_v1';

export const WHATSAPP_PENDING_DUE_KEY = 'whatsapp_pending_due_v1';

// The owner alarm handler's own retry after a failed pass; the pass that is that retry consumes it.
export const ALARM_RETRY_DUE_KEY = 'owner_alarm_retry_due_v1';
// The lane whose failure that retry is for. A retry recorded with no lane, as before lanes were kept, is the whole pass's.
export const ALARM_FAILED_LANE_KEY = 'owner_alarm_failed_lane_v1';

// Every wake the owner object keeps, one persisted due key per lane. The arbiter arms the earliest of them, so a lane that
// arms a wake writes its key first and no re-arm can drop it. guard-wake-due-keys fails on a due key written in the
// runtime but missing here, and on a lane that arms the alarm without naming one.
export const WAKE_DUE_KEYS = [
  'imessage_owner_inbox_due_v1', 'imessage_final_outbox_due_v1', APP_INBOX_DUE_KEY, COMMON_EXECUTION_DUE_KEY,
  'telegram_final_outbox_due_v1', 'telegram_owner_inbox_due_v1', 'telegram_link_due_v1',
  'browser_owner_task_due_v1', 'common_browser_due_v1', 'common_browser_lease_due_v1', WHATSAPP_PENDING_DUE_KEY,
  'mac_results_due_v1', ALARM_RETRY_DUE_KEY,
] as const;

// The lanes of an owner alarm pass, each with the wakes of the work it runs; 'schedule' owns the schedule's next entry.
// A failure inside a lane holds that lane until its retry while the others run; a failure outside every lane, or in a
// second lane while one is held, holds the whole pass ('pass'). The retry's own key is the held lane's, and the common
// execution wake is the run-loop object's alarm, not an owner lane's.
export const ALARM_LANES = {
  inbox: ['telegram_owner_inbox_due_v1', 'telegram_link_due_v1'],
  transport: ['telegram_final_outbox_due_v1'],
  schedule: [],
  browser: ['browser_owner_task_due_v1', 'common_browser_due_v1', 'common_browser_lease_due_v1'],
  app: [APP_INBOX_DUE_KEY],
  imessage: ['imessage_owner_inbox_due_v1', 'imessage_final_outbox_due_v1'],
  mac: ['mac_results_due_v1'],
  whatsapp: [WHATSAPP_PENDING_DUE_KEY],
} as const satisfies Readonly<Record<string, readonly (typeof WAKE_DUE_KEYS)[number][]>>;
export type AlarmLane = keyof typeof ALARM_LANES | 'pass';
const LANE_OF = new Map<string, AlarmLane>(Object.entries(ALARM_LANES).flatMap(([lane, keys]) => keys.map(key => [key, lane as AlarmLane])));

// The lane a failed pass left waiting, while its retry is still ahead. The one test of it: the handler's, on whether a pass
// is that retry, and the arbiter's, on whose wakes wait.
export function heldLane(retryDue: number | null | undefined, lane: AlarmLane | null | undefined, now: number): AlarmLane | null {
  return retryDue != null && retryDue > now ? lane ?? 'pass' : null;
}

// What a lane of an alarm pass throws, so the handler holds that lane: keyed by the lane, never by the error's message.
export class AlarmLaneFailure extends Error {
  constructor(readonly lane: Exclude<AlarmLane, 'pass'>, cause: unknown) { super(`alarm lane ${lane} failed`, { cause }); }
}
// Runs one lane of a pass unless it is the held one.
export async function runLane(lane: Exclude<AlarmLane, 'pass'>, held: AlarmLane | null, work: () => Promise<unknown>): Promise<void> {
  if (held === lane || held === 'pass') return;
  try { await work(); } catch (error) { throw error instanceof AlarmLaneFailure ? error : new AlarmLaneFailure(lane, error); }
}

// Wake for a WhatsApp payload admitted but not finished. Keeps an earlier alarm; never touches the Telegram due keys.
export async function armWhatsappPendingWake(storage: DurableObjectStorage, due: number): Promise<void> {
  const existing = await storage.getAlarm();
  await armAlarm(storage, existing === null ? due : Math.min(existing, due));
}

// How long a failed alarm pass waits before the next attempt: the platform's own retry curve (2 s, doubling) plus a fixed
// share of up to a quarter more, taken from the object's id so owners that fail together retry apart, capped at capMs.
export function alarmRetryDelay(streak: number, objectId: string, capMs: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < objectId.length; i++) hash = Math.imul(hash ^ objectId.charCodeAt(i), 0x01000193) >>> 0;
  return Math.min(Math.floor(2_000 * 2 ** Math.min(streak - 1, 20) * (1 + hash / 2 ** 32 / 4)), capMs);
}

type PassRearm = Readonly<{ scheduleDue: number | null; retryDelayMs: number }>;
// The re-arms of an alarm pass in flight, keyed by its object's storage. Inside the handler the arbiter only records them,
// and the pass applies the last one once its work completes. A delete there could cancel the platform's retry of a pass
// that then dies, and an arm made mid-pass would outlive a later re-arm that holds the schedule. A pass that completes
// while a lane waits always re-arms, so the retry it holds stays in the slot whatever the work re-armed.
const passRearms = new WeakMap<DurableObjectStorage, PassRearm | null>();
export async function alarmPass(storage: DurableObjectStorage, work: () => Promise<void>): Promise<void> {
  passRearms.set(storage, null);
  let last: PassRearm | null | undefined;
  try { await work(); last = passRearms.get(storage); } finally { passRearms.delete(storage); }
  const now = Date.now();
  if (last || heldLane(await storage.get<number>(ALARM_RETRY_DUE_KEY), null, now)) await arbitrate(storage, last?.scheduleDue ?? null, now, last?.retryDelayMs ?? 250, false);
}

// The one arbiter: arms the earliest of the schedule's next entry and every listed lane's wake, never sooner than the
// retry delay. While a failed pass's lane waits for its retry, that lane's wakes arm no sooner than the retry, and the
// other lanes' arm as due; a whole-pass hold holds them all. Outside a pass, with only the held lane's work due, an earlier
// wake already in the slot stays (the platform's retry of a pass that died, or an admission's); otherwise the retry goes in.
// With nothing due, a re-arm outside the handler clears the alarm; a pass leaves it.
export async function rearmSharedAlarm(storage: DurableObjectStorage, scheduleDue: number | null, now: number, retryDelayMs = 250): Promise<void> {
  if (passRearms.has(storage)) { passRearms.set(storage, { scheduleDue, retryDelayMs }); return; }
  await arbitrate(storage, scheduleDue, now, retryDelayMs, true);
}

async function arbitrate(storage: DurableObjectStorage, scheduleDue: number | null, now: number, retryDelayMs: number, outside: boolean): Promise<void> {
  const retryDue = (await storage.get<number | null>(ALARM_RETRY_DUE_KEY)) ?? null;
  const held = heldLane(retryDue, await storage.get<AlarmLane>(ALARM_FAILED_LANE_KEY), now);
  const bounds: number[] = [];
  let free = false;
  const add = (lane: AlarmLane | null | undefined, due: number) => {
    if (held === 'pass' || (held !== null && lane === held)) bounds.push(Math.max(due, retryDue!));
    else { bounds.push(due); free = true; }
  };
  if (scheduleDue !== null) add('schedule', scheduleDue);
  for (const key of WAKE_DUE_KEYS) {
    const due = (await storage.get<number | null>(key)) ?? null;
    if (due !== null) add(key === ALARM_RETRY_DUE_KEY ? held : LANE_OF.get(key), due);
  }
  if (!bounds.length) { if (outside) await storage.deleteAlarm(); return; }
  const wake = Math.max(Math.min(...bounds), now + retryDelayMs);
  if (outside && !free) {
    const armed = await storage.getAlarm();
    if (armed !== null && armed <= wake) return;
  }
  await armAlarm(storage, wake);
}

// Commit transport data and its wake together. Preserve an earlier scheduled alarm.
export async function persistTransportWake(storage: DurableObjectStorage, records: unknown, due: number | null): Promise<void> {
  await storage.transaction(async txn => {
    await txn.put({ telegram_final_outbox_v1: records, telegram_final_outbox_due_v1: due });
    if (due !== null) {
      const existing = await txn.getAlarm();
      await armAlarm(txn, Math.max(Date.now() + 250, existing === null ? due : Math.min(existing, due)));
    }
  });
}

// Inbox admission ACK is permitted only after this transaction commits its wake.
export async function persistInboxWake(txn: DurableObjectTransaction, records: unknown, due: number | null): Promise<void> {
  await txn.put({ telegram_owner_inbox_v1: records, telegram_owner_inbox_due_v1: due });
  if (due !== null) {
    const existing = await txn.getAlarm();
    await armAlarm(txn, Math.max(Date.now() + 250, existing === null ? due : Math.min(existing, due)));
  }
}
