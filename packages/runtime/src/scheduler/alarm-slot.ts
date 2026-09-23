// Reserved sole owner of the raw Durable Object alarm slot (ADR-0065: a DO has one
// alarm slot; scattered setAlarm calls silently overwrite each other, so all alarm
// registration flows through this single seam). This is the only `.setAlarm(` in the
// repo — guard-setalarm exempts this exact file and blocks the call everywhere else.
// setAlarm is awaited so the caller observes alarm registration completion, not fire-and-forget.
export async function armAlarm(storage: DurableObjectStorage, scheduledTimeMs: number): Promise<void> {
  await storage.setAlarm(scheduledTimeMs);
}
