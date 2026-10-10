// Ordered effects of the device-bridge trace. The dry run prints this list; the flow asserts it walks
// exactly these keys in this order, so the printed plan cannot drift from what a real run does.
// No imports: the dry run must not load network code.
export const TRACE_PLAN = [
  { key: 'healthz', effect: 'GET /healthz without cookie; expect 200, no redirect' },
  { key: 'unsigned_redeem', effect: 'POST /devices/redeem unsigned; expect exact generic 401' },
  { key: 'console_devices', effect: 'GET /console/devices with owner cookie; expect 200, no redirect; read CSRF' },
  { key: 'pair', effect: 'POST /console/action device.pair; creates ONE single-use pairing code (10 min expiry)' },
  { key: 'malformed_redeem', effect: 'POST /devices/redeem signed but malformed body; expect exact generic 401' },
  { key: 'foreign_signed_redeem', effect: 'POST /devices/redeem with the new code signed by a foreign key; expect exact generic 401, code not consumed' },
  { key: 'redeem', effect: 'POST /devices/redeem signed; creates ONE test device "Staging Trace Device"' },
  { key: 'redeem_replay', effect: 'POST /devices/redeem replaying the used code; expect exact generic 401' },
  { key: 'connect', effect: 'WS /devices/connect contract 0.2.3 (machine_state_query,notify_local); expect 101' },
  { key: 'heartbeat_online', effect: 'signed heartbeat; poll /console/devices until the device shows online' },
  { key: 'query', effect: 'POST /console/action device.query session_status; device acks and answers "unknown"; expect receipt' },
  { key: 'replace_socket', effect: 'second WS connect for the same device; first socket must close 1008' },
  { key: 'disconnect', effect: 'device closes its socket normally (1000)' },
  { key: 'notify_offline', effect: 'POST /console/action device.notify preset "Waldo status" / "Your Mac is connected." while offline; queued' },
  { key: 'reconnect', effect: 'WS reconnect; expect 101 and no delivery before a heartbeat' },
  { key: 'notify_round_trip', effect: 'heartbeat; expect only the queued notify_local (no re-delivery of the receipted query); ack, delivered, receipt' },
  { key: 'idempotency_conflict', effect: 'reuse a heartbeat message_id with an altered body; socket must close 1008' },
  { key: 'connect_for_revoke', effect: 'WS connect + heartbeat for the revoke check' },
  { key: 'revoke', effect: 'POST /console/action device.revoke; socket must close 1008' },
  { key: 'revoked_reconnect', effect: 'WS reconnect with the revoked key; expect exact generic 401' },
];
