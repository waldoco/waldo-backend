import type { AppSend, ScheduledAppDelivery } from './surfaces/app';
import type { OutboxRoute } from './delivery-routes';
import { telegramReceipt, tookPart, type FinalRecord } from './telegram-final-outbox';

// Where Waldo's proactive messages go for an owner reachable on the app and on a chat surface: the day cards (the Brief among
// them), reminders, follow-ups and update cards. The owner chooses in the console; the app is the default. WhatsApp can take
// them instead of the app (whatsapp) or with it (both). With the app, iMessage gets a copy (app_imessage): the app's delivery
// settles the job. An owner whose only surface is iMessage gets proactive work there, outside this setting, through the
// delivery outbox (imessage/scheduled-route.ts).
export const PROACTIVE_SURFACES = ['app', 'whatsapp', 'both', 'app_imessage'] as const;
export type ProactiveSurface = (typeof PROACTIVE_SURFACES)[number];
export type ProactiveTarget = 'app' | 'whatsapp' | 'imessage';
const WANTED: Readonly<Record<ProactiveSurface, readonly ProactiveTarget[]>> = {
  app: ['app'], whatsapp: ['whatsapp'], both: ['app', 'whatsapp'], app_imessage: ['app', 'imessage'],
};
// Whether a surface can take the work itself, so that its delivery settles the job; one that cannot only gets copies.
const SETTLES: Readonly<Record<ProactiveTarget, boolean>> = { app: true, whatsapp: true, imessage: false };
// The stored choice read as a list of surfaces, the one that takes the work first and then each that gets a copy. This is
// the only reader of the enum: everything after it works on the list, whatever surfaces it names.
export const wantedTargets = (setting: ProactiveSurface): readonly ProactiveTarget[] => WANTED[setting];
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

// The wanted surfaces the owner can be reached on now, in order: the first takes the work, the rest get a copy. When the
// first of them cannot take the work, the first reachable surface that can is used alone, the app first: a chat surface that
// is unlinked or no longer bound falls back to the app, and an owner who has not used the app yet keeps WhatsApp.
export const proactiveTargets = (wanted: readonly ProactiveTarget[], reachable: Readonly<Partial<Record<ProactiveTarget, boolean>>>): readonly ProactiveTarget[] => {
  const can = (target: ProactiveTarget) => reachable[target] === true;
  const kept = wanted.filter(can);
  return kept[0] !== undefined && SETTLES[kept[0]] ? kept : (['app', 'whatsapp'] as const).filter(can).slice(0, 1);
};

// A call whose effect is a message Waldo sends first, later: a reminder, a scheduled standing order, a loop with a date to
// check back on, a background task (it reports when it finishes). An owner with no surface that takes proactive work (one whose
// iMessage sender the directory no longer binds, with no other surface) would be promised a message that never comes, so such
// a call is refused with that reason and nothing is scheduled. A
// standing order for every turn and a loop with no date still work: they need no message from Waldo first.
const startsLaterMessage = (tool: string, args: unknown): boolean => {
  const given = (args ?? {}) as { trigger?: unknown; due?: unknown };
  return tool === 'set_reminder' || tool === 'start_task'
    || (tool === 'set_standing_order' && given.trigger !== 'every_turn')
    || (tool === 'open_loop' && given.due !== null && given.due !== undefined);
};
export const UNREACHABLE_CHECK_BACK = 'Nothing was scheduled: Waldo cannot message this owner first here, because no surface Waldo can write to first is '
  + 'linked to them now. Tell the owner that, and that a loop with no date stays on the list for when they write.';
export const refusingUnreachableCheckBacks = <H extends Readonly<{ name: string; handle(args: never, ctx: never): Promise<unknown> }>>(handlers: readonly H[], reachable: () => boolean | Promise<boolean>): H[] =>
  handlers.map(handler => ['set_reminder', 'set_standing_order', 'open_loop', 'start_task'].includes(handler.name)
    ? { ...handler, handle: async (args: never, ctx: never) => startsLaterMessage(handler.name, args) && !(await reachable())
      ? { ok: false as const, code: 'rejected' as const, error: UNREACHABLE_CHECK_BACK, source_taint: null }
      : handler.handle(args, ctx) }
    : handler);

// A copy of a message the app already has. Its id names the app delivery it copies, so each one is copied once.
export const WHATSAPP_COPY_PREFIX = 'whatsapp-copy:';
export const IMESSAGE_COPY_PREFIX = 'imessage-copy:';
// How long a copy may wait for WhatsApp, from the moment the app got the message. The app keeps the message either way; a
// copy left waiting for a closed window would otherwise wait out Meta's 30 days in the shared delivery outbox, which never
// evicts a pending record, so a month of copies could leave no room for the owner's own messages.
export const WHATSAPP_COPY_FRESH_MS = 24 * 60 * 60 * 1000;

// Delivers to the app first, and only a message the app took is copied, under that app message's id. A send worth delivering
// only now (a one-time code, a short-lived link) is never queued for a chat surface, which may hold it for days. A copy that
// cannot be queued is reported by its code alone and never fails or repeats the app delivery.
export const withCopy = (prefix: string, deliver: ScheduledAppDelivery, queue: (id: string, text: string) => Promise<void>, report: (code: 'copy_failed') => void): ScheduledAppDelivery =>
  async (text: string, send?: AppSend) => {
    const row = await deliver(text, send);
    if (send?.nowOnly) return row;
    try { await queue(`${prefix}${row}`, text); } catch { report('copy_failed'); }
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

// What a scheduled job queued for one of those numbers: a reminder, a loop's check-back, a mail follow-up, an update card,
// meeting prep, a pause notice, a day card or a standing order's report. When WhatsApp stops taking proactive work it goes to the app instead. A copy of an app message stays behind,
// since the app has it already, and so would a reply to the owner's own message, which belongs where the owner wrote. So does a
// message WhatsApp took any part of: it is on the owner's phone in part, and the app would get only the rest.
export const waitingForWhatsApp = (subjects: ReadonlySet<string>) => (record: FinalRecord): boolean =>
  !!(record.reminder || record.heartbeat || record.mailFollowup || record.update || record.calendarPrep || record.scheduleNotice || record.dayCard || record.standingOrder)
  && subjects.has(record.ownerSubject) && record.payload.chat_id === Number(record.ownerSubject) && !tookPart(record);

// A day card or an update card that reaches the app through this route links the app message it became, as a card sent
// straight to the app does.
export type AppRowLinks = Readonly<{
  card(card: NonNullable<FinalRecord['dayCard']>, appRow: string): void;
  update(recordId: number, appRow: string): void;
}>;
export const linkingAppRows = (route: OutboxRoute, link: AppRowLinks): OutboxRoute => ({
  ...route,
  receipt: (result, record) => {
    const ack = route.receipt ? route.receipt(result, record) : telegramReceipt(result, record.payload.chat_id);
    const appRow = (result as { app_row_id?: unknown } | null)?.app_row_id;
    if (ack !== null && ack !== 'held' && typeof appRow === 'string') {
      if (record.dayCard) link.card(record.dayCard, appRow);
      if (record.update) link.update(record.update.recordId, appRow);
    }
    return ack;
  },
});
