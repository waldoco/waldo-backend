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

// Every wake the owner object keeps, one persisted due key per lane. The arbiter arms the earliest of them, so a lane that
// arms a wake writes its key first and no re-arm can drop it. guard-wake-due-keys fails on a due key written in the
// runtime but missing here, and on a lane that arms the alarm without naming one.
export const WAKE_DUE_KEYS = [
  'imessage_owner_inbox_due_v1', 'imessage_final_outbox_due_v1', APP_INBOX_DUE_KEY, COMMON_EXECUTION_DUE_KEY,
  'telegram_final_outbox_due_v1', 'telegram_owner_inbox_due_v1', 'telegram_link_due_v1',
  'browser_owner_task_due_v1', 'common_browser_due_v1', 'common_browser_lease_due_v1', WHATSAPP_PENDING_DUE_KEY,
] as const;

// Wake for a WhatsApp payload admitted but not finished. Keeps an earlier alarm; never touches the Telegram due keys.
export async function armWhatsappPendingWake(storage: DurableObjectStorage, due: number): Promise<void> {
  const existing = await storage.getAlarm();
  await armAlarm(storage, existing === null ? due : Math.min(existing, due));
}

// The alarm handler's last resort after a throw: an earlier future wake already armed stands, otherwise the owner wakes
// again after delayMs. Whatever threw, the object is never left without a next alarm.
export async function armFallbackWake(storage: Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm'>, now: number, delayMs: number): Promise<void> {
  const existing = await storage.getAlarm();
  await armAlarm(storage, existing !== null && existing > now ? Math.min(existing, now + delayMs) : now + delayMs);
}

// The one arbiter: arms the earliest of the schedule's next entry and every listed lane's wake, never sooner than the
// retry delay, and clears the alarm when nothing is due.
export async function rearmSharedAlarm(storage: DurableObjectStorage, scheduleDue: number | null, now: number, retryDelayMs = 250): Promise<void> {
  const bounds = scheduleDue === null ? [] : [scheduleDue];
  for (const key of WAKE_DUE_KEYS) {
    const due = (await storage.get<number | null>(key)) ?? null;
    if (due !== null) bounds.push(due);
  }
  if (!bounds.length) { await storage.deleteAlarm(); return; }
  await armAlarm(storage, Math.max(Math.min(...bounds), now + retryDelayMs));
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
