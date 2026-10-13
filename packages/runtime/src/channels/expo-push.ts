// Expo's push service, which delivers through APNs and FCM. A native token registered under apns or fcm is not Expo's to send.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Push text is fixed per trigger: never health, email content or names.
export const PUSH_TEXT = { brief: 'Your Brief is ready' } as const;
export type PushKind = keyof typeof PUSH_TEXT;
export const PUSH_DAILY_LIMIT = 3;
const BUDGET_KEY = 'app_push_budget_v1';
const MAX_TARGETS = 10;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type Target = Readonly<{ installation_id: string; provider: string; token: string }>;
export type OwnerPushDeps = Readonly<{
  kv: Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
  // The owner's active devices with their tokens, read for this send and never kept.
  targets(): Promise<unknown>;
  send: typeof fetch;
  today(): string;
  quiet(): boolean;
  log(code: string, sent: number): void;
}>;

const readTargets = (value: unknown): readonly Target[] => {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) throw new Error('push targets unavailable');
  return value.map(row => {
    const target = row as Partial<Target>;
    if (!target || typeof target.installation_id !== 'string' || !uuid.test(target.installation_id) || typeof target.provider !== 'string'
      || typeof target.token !== 'string' || !target.token || target.token.length > 4096) throw new Error('push targets unavailable');
    return { installation_id: target.installation_id, provider: target.provider, token: target.token };
  });
};

// Sends one fixed push to the owner's Expo devices, at most PUSH_DAILY_LIMIT a day and never in quiet hours. A push is
// counted before it is sent, so an unknown outcome never lets a retry pass the limit. Failures are logged as a code and
// never thrown, so the work that triggered the push is not affected.
export const ownerPush = (deps: OwnerPushDeps) => async (kind: PushKind): Promise<void> => {
  if (deps.quiet()) return deps.log('quiet', 0);
  const day = deps.today(), budget = deps.kv.get<{ day: string; sent: number }>(BUDGET_KEY);
  const sent = budget?.day === day ? budget.sent : 0;
  if (sent >= PUSH_DAILY_LIMIT) return deps.log('daily_limit', 0);
  let expo: readonly Target[];
  try { expo = readTargets(await deps.targets()).filter(target => target.provider === 'expo'); } catch { return deps.log('targets_unavailable', 0); }
  if (!expo.length) return deps.log('no_devices', 0);
  deps.kv.put(BUDGET_KEY, { day, sent: sent + 1 });
  let response: Response;
  try {
    response = await deps.send(EXPO_PUSH_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(expo.map(target => ({ to: target.token, body: PUSH_TEXT[kind], sound: 'default' }))) });
  } catch { return deps.log('send_failed', 0); }
  if (!response.ok) return deps.log('send_refused', 0);
  let tickets: unknown;
  try { tickets = ((await response.json()) as { data?: unknown }).data; } catch { return deps.log('receipt_unreadable', 0); }
  const accepted = Array.isArray(tickets) ? tickets.filter(ticket => (ticket as { status?: unknown })?.status === 'ok').length : 0;
  deps.log(accepted === expo.length ? 'sent' : 'partial', accepted);
};
