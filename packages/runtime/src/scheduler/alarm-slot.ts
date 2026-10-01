// Reserved sole owner of the raw Durable Object alarm slot (ADR-0065: a DO has one
// alarm slot; scattered setAlarm calls silently overwrite each other, so all alarm
// registration flows through this single seam). This is the only `.setAlarm(` in the
// repo — guard-setalarm exempts this exact file and blocks the call everywhere else.
// setAlarm is awaited so the caller observes alarm registration completion, not fire-and-forget.
export async function armAlarm(storage: DurableObjectStorage, scheduledTimeMs: number): Promise<void> {
  await storage.setAlarm(scheduledTimeMs);
}

// One arbiter for schedule and Telegram transport. Every scheduler rearm includes
// persisted transport due time, including an empty schedule (formerly deleteAlarm).
export async function rearmSharedAlarm(storage: DurableObjectStorage, scheduleDue: number | null, now: number): Promise<void> {
  const outboxDue = (await storage.get<number | null>('telegram_final_outbox_due_v1')) ?? null;
  const bounds = [scheduleDue, outboxDue].filter((v): v is number => v !== null);
  if (!bounds.length) { await storage.deleteAlarm(); return; }
  await armAlarm(storage, Math.max(Math.min(...bounds), now + 250));
}

// Commit transport data and its wake together. Preserve an earlier scheduled alarm.
export async function persistTransportWake(storage: DurableObjectStorage, records: unknown, due: number | null): Promise<void> {
  await storage.transaction(async txn => {
    await txn.put({ telegram_final_outbox_v1: records, telegram_final_outbox_due_v1: due });
    if (due !== null) {
      const existing = await txn.getAlarm();
      await txn.setAlarm(Math.max(Date.now() + 250, existing === null ? due : Math.min(existing, due)));
    }
  });
}
