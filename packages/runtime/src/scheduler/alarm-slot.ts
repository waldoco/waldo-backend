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
