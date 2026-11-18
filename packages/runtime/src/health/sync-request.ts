import {
  HEALTH_SYNC_DAILY_LIMIT_V1, HEALTH_SYNC_MIN_GAP_MINUTES_V1, healthSyncPushV1Schema,
} from '../../../contracts/src/app/health-ingest';
import { withRequestTimeout } from '../identity/request-timeout';
import { EXPO_PUSH_URL, readTargets, unregistered, type OwnerPushDeps, type PushTarget } from '../channels/expo-push';

// Asks the owner's phones to sync their health store now, with a silent push that shows nothing: the phone reads and uploads
// as on its own schedule, and the readings reach the owner's object through the usual ingest and recompute. A request is
// counted before it is sent, so an unknown outcome never lets a retry pass the day's limit or the gap.
const REQUESTS_KEY = 'health_sync_requests_v1';
const GAP_MS = HEALTH_SYNC_MIN_GAP_MINUTES_V1 * 60_000;
export type HealthSyncOutcome = 'requested' | 'too_soon' | 'daily_limit' | 'no_phone' | 'not_configured' | 'failed';
export type HealthSyncDeps = Pick<OwnerPushDeps, 'accessToken' | 'kv' | 'targets' | 'retire' | 'send' | 'today' | 'log'> & Readonly<{ now(): number }>;

export const healthSyncRequester = (deps: HealthSyncDeps) => async (): Promise<HealthSyncOutcome> => {
  if (!deps.accessToken) return 'not_configured';
  const now = deps.now(), day = deps.today(), held = deps.kv.get<{ day: string; sent: number; last_at: number }>(REQUESTS_KEY);
  if (held && now - held.last_at < GAP_MS) return 'too_soon';
  const sent = held?.day === day ? held.sent : 0;
  if (sent >= HEALTH_SYNC_DAILY_LIMIT_V1) return 'daily_limit';
  let devices: readonly PushTarget[];
  try { devices = readTargets(await deps.targets()); } catch { deps.log('health_sync_targets_unavailable', 0); return 'failed'; }
  if (!devices.length) return 'no_phone';
  deps.kv.put(REQUESTS_KEY, { day, sent: sent + 1, last_at: now });
  const data = healthSyncPushV1Schema.parse({ trigger: 'health_sync' });
  let response: Response;
  try {
    // No title, body or sound: iOS starts the app in the background (content-available), and normal priority is the one APNs
    // takes for a background push.
    response = await withRequestTimeout(signal => deps.send(EXPO_PUSH_URL, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${deps.accessToken}` },
      body: JSON.stringify(devices.map(device => ({ to: device.token, data, contentAvailable: true, priority: 'normal' }))) }));
  } catch { deps.log('health_sync_send_failed', 0); return 'failed'; }
  if (!response.ok) { deps.log('health_sync_send_refused', 0); return 'failed'; }
  let answer: unknown;
  try { answer = ((await withRequestTimeout(() => response.json())) as { data?: unknown }).data; } catch { deps.log('health_sync_receipt_unreadable', 0); return 'failed'; }
  if (!Array.isArray(answer) || answer.length !== devices.length) { deps.log('health_sync_receipt_unreadable', 0); return 'failed'; }
  const tickets: readonly unknown[] = answer;
  const accepted = tickets.filter(ticket => (ticket as { status?: unknown } | null)?.status === 'ok').length;
  deps.log(accepted ? 'health_sync_sent' : 'health_sync_refused', accepted);
  const gone = devices.filter((_device, index) => unregistered(tickets[index]));
  if (gone.length) await Promise.allSettled(gone.map(device => deps.retire(device)));
  return accepted ? 'requested' : 'failed';
};
