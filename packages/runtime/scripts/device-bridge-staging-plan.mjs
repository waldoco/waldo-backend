// Ordered effects of the device-bridge trace. The dry run prints this list; the flow asserts it walks
// exactly these keys in this order, so the printed plan cannot drift from what a real run does.
// No imports: the dry run must not load network code.
export const TRACE_PLAN = [
  { key: 'healthz', effect: 'GET /healthz without cookie; expect 200, no redirect' },
  { key: 'unsigned_redeem', effect: 'POST /devices/redeem unsigned; expect exact generic 401' },
  { key: 'console_devices', effect: 'GET /console/devices with owner cookie; expect 200, no redirect; read CSRF' },
  { key: 'pair', effect: 'POST /console/action device.pair; creates ONE single-use pairing code (10 min expiry)' },
  { key: 'redeem', effect: 'POST /devices/redeem signed; creates ONE test device "Staging Trace Device"' },
  { key: 'connect', effect: 'WS /devices/connect contract 0.2.3 (machine_state_query,notify_local); expect 101' },
  { key: 'heartbeat_online', effect: 'signed heartbeat; poll /console/devices until the device shows online' },
  { key: 'query', effect: 'POST /console/action device.query session_status; device acks and answers "unknown"; expect receipt' },
  { key: 'revoke', effect: 'POST /console/action device.revoke; socket must close 1008' },
  { key: 'revoked_reconnect', effect: 'WS reconnect with the revoked key; expect exact generic 401' },
];
