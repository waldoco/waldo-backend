// Keep component-test alarms under the test's control while retaining real Workers KV/SQL.
export const manualAlarmStorage = (storage: DurableObjectStorage): DurableObjectStorage => ({
  kv: storage.kv, get: storage.get.bind(storage),
  setAlarm: async () => undefined, deleteAlarm: async () => undefined,
}) as unknown as DurableObjectStorage;
