import type { AppSend, ScheduledAppDelivery } from './surfaces/app';
import type { FinalRecord } from './telegram-final-outbox';

// Where Waldo's proactive messages go for an owner reachable on the app and on WhatsApp: the day cards (the Brief among them),
// reminders, follow-ups and update cards. The owner chooses in the console; the app is the default.
export const PROACTIVE_SURFACES = ['app', 'whatsapp', 'both'] as const;
export type ProactiveSurface = (typeof PROACTIVE_SURFACES)[number];
export type ProactiveTarget = 'app' | 'whatsapp';
export const PROACTIVE_SURFACE_KEY = 'proactive_surface_v1';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
const known = (value: unknown): value is ProactiveSurface => PROACTIVE_SURFACES.some(surface => surface === value);

export const proactiveSurface = (kv: Pick<Kv, 'get'>): ProactiveSurface => {
  const stored = kv.get<unknown>(PROACTIVE_SURFACE_KEY);
  return known(stored) ? stored : 'app';
};
export const setProactiveSurface = (kv: Kv, value: string): boolean => {
  if (!known(value)) return false;
  kv.put(PROACTIVE_SURFACE_KEY, value);
  return true;
};

// The setting chooses between the surfaces the owner can be reached on now. With only one of them, that one is used whatever
// the setting says: a WhatsApp that is unlinked or no longer bound falls back to the app, and an owner who has not used the
// app yet keeps WhatsApp.
export const proactiveTargets = (setting: ProactiveSurface, reachable: Readonly<{ app: boolean; whatsapp: boolean }>): readonly ProactiveTarget[] =>
  reachable.app && reachable.whatsapp ? (setting === 'both' ? ['app', 'whatsapp'] : [setting])
    : reachable.app ? ['app'] : reachable.whatsapp ? ['whatsapp'] : [];

// A WhatsApp copy of a message the app already has. Its id names the app delivery it copies, so each one is copied once.
export const WHATSAPP_COPY_PREFIX = 'whatsapp-copy:';

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

// A record addressed to one of those numbers that is not a copy. When WhatsApp stops being a proactive surface it goes to the
// app instead; a copy stays behind, since its message is in the app already.
export const waitingForWhatsApp = (subjects: ReadonlySet<string>) => (record: FinalRecord): boolean =>
  !record.id.startsWith(WHATSAPP_COPY_PREFIX) && subjects.has(record.ownerSubject) && record.payload.chat_id === Number(record.ownerSubject);
