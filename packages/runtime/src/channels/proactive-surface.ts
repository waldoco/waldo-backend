import type { AppSend, ScheduledAppDelivery } from './surfaces/app';
import type { OutboxRoute } from './delivery-routes';
import { telegramReceipt, type FinalRecord } from './telegram-final-outbox';

// Where Waldo's proactive messages go for an owner reachable on the app and on a chat surface: the day cards (the Brief among
// them), reminders, follow-ups and update cards. The owner chooses in the console; the app is the default. Each chat surface
// has the same two choices: instead of the app (whatsapp, imessage) or with the app (both, app_imessage).
export const PROACTIVE_SURFACES = ['app', 'whatsapp', 'both', 'imessage', 'app_imessage'] as const;
export type ProactiveSurface = (typeof PROACTIVE_SURFACES)[number];
export type ProactiveTarget = 'app' | 'whatsapp' | 'imessage';
const WANTED: Readonly<Record<ProactiveSurface, readonly ProactiveTarget[]>> = {
  app: ['app'], whatsapp: ['whatsapp'], both: ['app', 'whatsapp'], imessage: ['imessage'], app_imessage: ['app', 'imessage'],
};
export const PROACTIVE_SURFACE_KEY = 'proactive_surface_v1';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
const known = (value: unknown): value is ProactiveSurface => (PROACTIVE_SURFACES as readonly unknown[]).includes(value);

export const proactiveSurface = (kv: Pick<Kv, 'get'>): ProactiveSurface => {
  const stored = kv.get<unknown>(PROACTIVE_SURFACE_KEY);
  return known(stored) ? stored : 'app';
};
export const setProactiveSurface = (kv: Kv, value: string): boolean => {
  if (!known(value)) return false;
  kv.put(PROACTIVE_SURFACE_KEY, value);
  return true;
};

// The setting chooses among the surfaces the owner can be reached on now. When none it names is reachable, the first
// reachable one is used, the app first: a chat surface that is unlinked or no longer bound falls back to the app, and an
// owner who has not used the app yet keeps WhatsApp.
export const proactiveTargets = (setting: ProactiveSurface, reachable: Readonly<{ app: boolean; whatsapp: boolean; imessage?: boolean }>): readonly ProactiveTarget[] => {
  const can = (target: ProactiveTarget) => reachable[target] === true;
  const wanted = WANTED[setting].filter(can);
  return wanted.length ? wanted : (['app', 'whatsapp', 'imessage'] as const).filter(can).slice(0, 1);
};

// A WhatsApp copy of a message the app already has. Its id names the app delivery it copies, so each one is copied once.
export const WHATSAPP_COPY_PREFIX = 'whatsapp-copy:';
// How long a copy may wait for WhatsApp, from the moment the app got the message. The app keeps the message either way; a
// copy left waiting for a closed window would otherwise wait out Meta's 30 days in the shared delivery outbox, which never
// evicts a pending record, so a month of copies could leave no room for the owner's own messages.
export const WHATSAPP_COPY_FRESH_MS = 24 * 60 * 60 * 1000;

// Delivers to the app first, and only a message the app took is copied. A send worth delivering only now (a one-time code, a
// short-lived link) is never queued for WhatsApp, which may hold it for days. A copy that cannot be queued is reported by its
// code alone and never fails or repeats the app delivery.
export const withWhatsAppCopy = (deliver: ScheduledAppDelivery, queue: (id: string, text: string) => Promise<void>, report: (code: 'copy_failed') => void): ScheduledAppDelivery =>
  async (text: string, send?: AppSend) => {
    const row = await deliver(text, send);
    if (send?.nowOnly) return row;
    try { await queue(`${WHATSAPP_COPY_PREFIX}${row}`, text); } catch { report('copy_failed'); }
    return row;
  };

// The WhatsApp numbers this owner's proactive messages may still wait for, newest last. Unlinking clears the bound number and
// a new number replaces it, so the earlier ones are kept here to find what still waits for them.
export const WHATSAPP_SUBJECTS_KEY = 'proactive_whatsapp_subjects_v1';
const SUBJECTS_KEPT = 8;
export const rememberWhatsAppSubject = (kv: Kv, subject: string): void => {
  const seen = kv.get<string[]>(WHATSAPP_SUBJECTS_KEY) ?? [];
  if (seen.at(-1) !== subject) kv.put(WHATSAPP_SUBJECTS_KEY, [...seen.filter(earlier => earlier !== subject), subject].slice(-SUBJECTS_KEPT));
};
export const whatsappSubjects = (kv: Pick<Kv, 'get'>): ReadonlySet<string> => new Set(kv.get<string[]>(WHATSAPP_SUBJECTS_KEY) ?? []);

// What a scheduled job queued for one of those numbers: a reminder, a loop's check-back, a mail follow-up, meeting prep, a
// pause notice, a day card or a standing order's report. When WhatsApp stops taking proactive work it goes to the app instead. A copy of an app message stays behind,
// since the app has it already, and so would a reply to the owner's own message, which belongs where the owner wrote.
export const waitingForWhatsApp = (subjects: ReadonlySet<string>) => (record: FinalRecord): boolean =>
  !!(record.reminder || record.heartbeat || record.mailFollowup || record.calendarPrep || record.scheduleNotice || record.dayCard || record.standingOrder)
  && subjects.has(record.ownerSubject) && record.payload.chat_id === Number(record.ownerSubject);

// A day card that reaches the app through this route links the app message it became, as a card sent straight to the app does.
export const linkingCards = (route: OutboxRoute, link: (card: NonNullable<FinalRecord['dayCard']>, appRow: string) => void): OutboxRoute => ({
  ...route,
  receipt: (result, record) => {
    const ack = route.receipt ? route.receipt(result, record) : telegramReceipt(result, record.payload.chat_id);
    const appRow = (result as { app_row_id?: unknown } | null)?.app_row_id;
    if (ack !== null && ack !== 'held' && record.dayCard && typeof appRow === 'string') link(record.dayCard, appRow);
    return ack;
  },
});
