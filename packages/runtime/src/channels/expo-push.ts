import { withRequestTimeout } from '../identity/request-timeout';
import { pushNotificationSchema, type PushNotification } from '../../../contracts/src/ui/notification';

// Expo's push service, which delivers through APNs and FCM. The directory releases only tokens registered under expo.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Each push has a fixed line per trigger and the ids the app opens, never health, email content or names. An approval push
// names the approval it opens, which the caller adds; the text never says what it suggests or why. A prep push may carry a
// caller's body in place of its fixed line (channels/event-briefs.ts prepPushBody decides what that body may say).
export const PUSHES = {
  brief: { body: 'Your Brief is ready', data: { trigger: 'brief', variant: 'morning', card_ref: 'card:brief' } },
  approval: { body: 'Waldo has a suggestion for your day', data: { trigger: 'approval' } },
  prep: { body: 'Waldo has a note before your next meeting', data: { trigger: 'pre_activity_spot' } },
} as const satisfies Record<string, Readonly<{ body: string; data: Omit<PushNotification, 'approval_id'> }>>;
export type PushKind = keyof typeof PUSHES;
export const PUSH_DAILY_LIMIT = 3;
// Pushes for anything but a day card or an approval have their own ceiling: a backstop against a runaway sender. Whether one
// is sent at all is the model's judgment.
export const PROACTIVE_PUSH_DAILY_LIMIT = 6;
const CARD_PUSHES: ReadonlySet<PushKind> = new Set(['brief', 'approval']);
const BUDGET_KEY = 'app_push_budget_v1';
const PROACTIVE_BUDGET_KEY = 'app_push_proactive_budget_v1';
// The owner-day the Brief was last pushed, which opens the day's last slot to approval pushes.
const BRIEF_DAY_KEY = 'app_push_brief_day_v1';
const MAX_TARGETS = 10;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type PushTarget = Readonly<{ installation_id: string; device_epoch: number; token: string }>;
export type OwnerPushDeps = Readonly<{
  // Expo's access token for the project. Without it push is not configured and nothing is sent.
  accessToken: string | undefined;
  kv: Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
  // The owner's active Expo devices with their tokens, read for this send and never kept.
  targets(): Promise<unknown>;
  // Drops a registration Expo says its device no longer holds, fenced on the epoch that was read.
  retire(target: PushTarget): Promise<unknown>;
  send: typeof fetch;
  today(): string;
  quiet(): boolean;
  log(code: string, count: number): void;
}>;

const readTargets = (value: unknown): readonly PushTarget[] => {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) throw new Error('push targets unavailable');
  return value.map(row => {
    const target = row as Partial<PushTarget>;
    if (!target || typeof target.installation_id !== 'string' || !uuid.test(target.installation_id) || !Number.isSafeInteger(target.device_epoch)
      || target.device_epoch! < 1 || typeof target.token !== 'string' || !target.token || target.token.length > 4096) throw new Error('push targets unavailable');
    return { installation_id: target.installation_id, device_epoch: target.device_epoch!, token: target.token };
  });
};
const unregistered = (ticket: unknown) => {
  const answer = ticket as { status?: unknown; details?: { error?: unknown } } | null;
  return answer?.status === 'error' && answer.details?.error === 'DeviceNotRegistered';
};

// Sends one push to the owner's Expo devices, within its day's budget and never in quiet hours. A push is
// counted before it is sent, so an unknown outcome never lets a retry pass the limit. Failures are logged as a code and
// never thrown, so the work that triggered the push is not affected. The last slot of the day is the Brief's: approval pushes
// stop one short of the limit until the Brief has been pushed that day. The send and the read of its receipt are bounded.
export const ownerPush = (deps: OwnerPushDeps) => async (kind: PushKind, approvalId?: string, prepBody?: string): Promise<void> => {
  if (!deps.accessToken) return deps.log('not_configured', 0);
  const { data: fixed } = PUSHES[kind];
  const body = kind === 'prep' && prepBody ? prepBody : PUSHES[kind].body;
  const data = pushNotificationSchema.safeParse({ ...fixed, ...(approvalId === undefined ? {} : { approval_id: approvalId }) });
  if (!data.success) return deps.log('invalid_payload', 0);
  if (deps.quiet()) return deps.log('quiet', 0);
  const card = CARD_PUSHES.has(kind), key = card ? BUDGET_KEY : PROACTIVE_BUDGET_KEY;
  const day = deps.today(), budget = deps.kv.get<{ day: string; sent: number }>(key);
  const sent = budget?.day === day ? budget.sent : 0;
  const limit = !card ? PROACTIVE_PUSH_DAILY_LIMIT : kind === 'approval' && deps.kv.get<string>(BRIEF_DAY_KEY) !== day ? PUSH_DAILY_LIMIT - 1 : PUSH_DAILY_LIMIT;
  if (sent >= limit) return deps.log('daily_limit', 0);
  let devices: readonly PushTarget[];
  try { devices = readTargets(await deps.targets()); } catch { return deps.log('targets_unavailable', 0); }
  if (!devices.length) return deps.log('no_devices', 0);
  deps.kv.put(key, { day, sent: sent + 1 });
  if (kind === 'brief') deps.kv.put(BRIEF_DAY_KEY, day);
  let response: Response;
  try {
    response = await withRequestTimeout(signal => deps.send(EXPO_PUSH_URL, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${deps.accessToken}` },
      body: JSON.stringify(devices.map(device => ({ to: device.token, body, data: data.data, sound: 'default' }))) }));
  } catch { return deps.log('send_failed', 0); }
  if (!response.ok) return deps.log('send_refused', 0);
  let answer: unknown;
  try { answer = ((await withRequestTimeout(() => response.json())) as { data?: unknown }).data; } catch { return deps.log('receipt_unreadable', 0); }
  if (!Array.isArray(answer) || answer.length !== devices.length) return deps.log('receipt_unreadable', 0);
  const tickets: readonly unknown[] = answer;
  const accepted = tickets.filter(ticket => (ticket as { status?: unknown } | null)?.status === 'ok').length;
  deps.log(accepted === devices.length ? 'sent' : 'partial', accepted);
  // Expo answers in the order the messages were sent, so a ticket names its device by position.
  const gone = devices.filter((_device, index) => unregistered(tickets[index]));
  if (!gone.length) return;
  const failed = (await Promise.allSettled(gone.map(device => deps.retire(device)))).filter(outcome => outcome.status === 'rejected').length;
  deps.log(failed ? 'retire_failed' : 'retired', failed || gone.length);
};
