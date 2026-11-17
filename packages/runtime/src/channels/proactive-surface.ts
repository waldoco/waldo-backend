import { APP_PROACTIVE_SURFACE_RECEIPTS_V1 } from '../../../contracts/src/app/controls';
import type { AppSend, ScheduledAppDelivery } from './surfaces/app';
import type { OutboxRoute } from './delivery-routes';
import { telegramReceipt, tookPart, type FinalRecord } from './telegram-final-outbox';
import type { ReadsAs } from '../prompt/update-cards';

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
// What a surface shows the owner: the app shows the day's cards beside a message; a chat shows the message alone.
const READS: Readonly<Record<ProactiveTarget, ReadsAs>> = { app: 'cards', whatsapp: 'chat', imessage: 'chat' };
// How the owner reads the proactive work an app owner's runtime sends: by the surface that takes it first. Under
// PROACTIVE_BOTH_DEFAULT, one message goes to a chat too when the surface names one, and that chat has no card to lean on, so
// it is written to stand alone. With the switch off, owners who chose a surface before it read as they always did.
export const proactiveReads = (kv: Pick<Kv, 'get'>, bothDefault = false): ReadsAs => {
  const wanted = wantedTargets(proactiveSurface(kv, bothDefault));
  return bothDefault && wanted.some(target => READS[target] === 'chat') ? 'chat' : READS[wanted[0] ?? 'app'];
};
// Whether a surface's delivery of proactive work is written into the owner's own chain: the app transcript is that chain,
// while a chat surface's job runs on and writes that chat's chain.
const ON_OWNER_CHAIN: Readonly<Record<ProactiveTarget, boolean>> = { app: true, whatsapp: false, imessage: false };
export const proactiveOnOwnerChain = (kv: Pick<Kv, 'get'>, bothDefault = false): boolean =>
  ON_OWNER_CHAIN[wantedTargets(proactiveSurface(kv, bothDefault))[0] ?? 'app'];
// Whether a surface can take the work itself, so that its delivery settles the job; one that cannot only gets copies.
const SETTLES: Readonly<Record<ProactiveTarget, boolean>> = { app: true, whatsapp: true, imessage: false };
// The stored choice read as a list of surfaces, the one that takes the work first and then each that gets a copy. This is
// the only reader of the enum: everything after it works on the list, whatever surfaces it names.
export const wantedTargets = (setting: ProactiveSurface): readonly ProactiveTarget[] => WANTED[setting];
export const PROACTIVE_SURFACE_KEY = 'proactive_surface_v1';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
const known = (value: unknown): value is ProactiveSurface => (PROACTIVE_SURFACES as readonly unknown[]).includes(value);

// PROACTIVE_BOTH_DEFAULT: an owner who has chosen nothing and has a WhatsApp number bound gets proactive work on the app and
// WhatsApp both, instead of the app alone. A stored choice, whatever it is, always wins; the switch changes only the default.
export const proactiveBothDefault = (env: Readonly<{ PROACTIVE_BOTH_DEFAULT?: string }>): boolean => env.PROACTIVE_BOTH_DEFAULT === '1';
export const proactiveSurface = (kv: Pick<Kv, 'get'>, bothDefault = false): ProactiveSurface => {
  const stored = kv.get<unknown>(PROACTIVE_SURFACE_KEY);
  if (known(stored)) return stored;
  return bothDefault && kv.get<string>('whatsapp_subject') ? 'both' : 'app';
};
export const setProactiveSurface = (kv: Kv, value: string): boolean => {
  if (!known(value)) return false;
  kv.put(PROACTIVE_SURFACE_KEY, value);
  return true;
};

// Whether a surface reaches the owner only once the owner links it (a chat), or always (the app they are signed in to).
const LINKED: Readonly<Record<ProactiveTarget, boolean>> = { app: false, whatsapp: true, imessage: true };
type Chat = Exclude<ProactiveTarget, 'app'>;
// Whether each chat is linked to the owner now; null when that cannot be read.
export type ChatLinks = Readonly<Record<Chat, boolean | null>>;
// The chats a surface names that are not known to be linked now.
const unlinkedChats = (surface: ProactiveSurface, links: ChatLinks): readonly Chat[] =>
  wantedTargets(surface).filter((target): target is Chat => LINKED[target] && links[target as Chat] !== true);
// What the owner can choose now: a surface whose every chat is linked.
export const proactiveSurfaceChoices = (links: ChatLinks): readonly ProactiveSurface[] =>
  PROACTIVE_SURFACES.filter(surface => unlinkedChats(surface, links).length === 0);
export type ProactiveSurfaceChoice = 'saved' | 'unchanged' | 'unchecked' | 'invalid' | `${Chat}_not_linked`;
// The owner choosing a surface in the app or the console: what proactiveSurfaceChoices offers is stored, through the one
// writer, and nothing else. The first run's channel.set comes before any chat is linked, so it stores its choice as is.
export const chooseProactiveSurface = (kv: Kv, value: string, links: ChatLinks, bothDefault = false): ProactiveSurfaceChoice => {
  if (!known(value)) return 'invalid';
  const missing = unlinkedChats(value, links);
  const unlinked = missing.find(chat => links[chat] === false);
  if (unlinked) return `${unlinked}_not_linked`;
  if (missing.length) return 'unchecked';
  // Under the default, choosing what is shown still stores it, so the owner's choice outlives the switch.
  if (proactiveSurface(kv, bothDefault) === value && (known(kv.get<unknown>(PROACTIVE_SURFACE_KEY)) || !bothDefault)) return 'unchanged';
  setProactiveSurface(kv, value);
  return 'saved';
};
export const proactiveSurfaceReceipt = (choice: ProactiveSurfaceChoice) => choice === 'invalid' ? false : APP_PROACTIVE_SURFACE_RECEIPTS_V1[choice];

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
export const withCopy = (prefix: string, deliver: ScheduledAppDelivery, queue: (id: string, text: string, until?: number) => Promise<void>, report: (code: 'copy_failed') => void): ScheduledAppDelivery =>
  async (text: string, send?: AppSend) => {
    const row = await deliver(text, send);
    if (send?.nowOnly) return row;
    try { await queue(`${prefix}${row}`, text, send?.copyUntil); } catch { report('copy_failed'); }
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

// Whether a message is Waldo's own initiative, which the owner did not ask for: a day card, an update, meeting prep, a pause
// notice, a mail follow-up, a health note, a check-back on an open loop, news of a new capability, or a copy of one of those the
// app already has. This is where a message comes from, not what it says, and it picks the door-knock template (whatsapp-window.ts):
// the reply template says the owner asked.
const unaskedKind = (record: FinalRecord): boolean => !!(record.mailFollowup || record.update || record.calendarPrep || record.scheduleNotice || record.dayCard || record.healthNotice || record.heartbeat || record.announcement);
export const unaskedRecord = (record: FinalRecord): boolean => unaskedKind(record) || record.id.startsWith(WHATSAPP_COPY_PREFIX);

// What a scheduled job queued for one of those numbers: a reminder, a loop's check-back, a mail follow-up, an update card,
// meeting prep, a pause notice, a day card or a standing order's report. When WhatsApp stops taking proactive work it goes to the app instead. A copy of an app message stays behind,
// since the app has it already, and so would a reply to the owner's own message, which belongs where the owner wrote. So does a
// message WhatsApp took any part of: it is on the owner's phone in part, and the app would get only the rest.
// A record that answers work the owner asked for, addressed to this chat.
export const answersOwnerIn = (subject: string) => (record: FinalRecord): boolean =>
  record.answersOwner === true && record.ownerSubject === subject && record.payload.chat_id === Number(subject);
// The surfaces with a chat of their own that the owner's answers go back to, where the owner asked; the app answers in its own
// thread chain, and every other surface answers where Waldo's own messages go.
export const ANSWERS_WHERE_ASKED: ReadonlySet<string> = new Set(['whatsapp']);

// A message of Waldo's own, nothing of it sent yet, still addressed to a chat surface that no longer takes this owner's
// proactive work (an old WhatsApp number, or Telegram once PROACTIVE_OVER_TELEGRAM decides): a scheduled one and, with
// `notices`, a notice a turn queued there.
export const waldoFirstWaitingFor = (subjects: ReadonlySet<string>, notices = false) => (record: FinalRecord): boolean =>
  !!((notices && record.notice) || record.reminder || record.heartbeat || record.mailFollowup || record.update || record.calendarPrep || record.scheduleNotice || record.dayCard || record.standingOrder || record.announcement)
  && subjects.has(record.ownerSubject) && record.payload.chat_id === Number(record.ownerSubject) && !tookPart(record);

// A day card, an update card or a card's revision that reaches the app through this route links the app message it became,
// as a card sent straight to the app does. `row`, when given, links every app message the route delivers to the trace of
// the job that queued it.
export type AppRowLinks = Readonly<{
  card(card: NonNullable<FinalRecord['dayCard']>, appRow: string): void;
  update(recordId: number, appRow: string): void;
  revision?(revision: NonNullable<FinalRecord['revision']>, appRow: string, record: string): void;
  row?(appRow: string, trace: string): void;
}>;
export const linkingAppRows = (route: OutboxRoute, link: AppRowLinks): OutboxRoute => ({
  ...route,
  receipt: (result, record) => {
    const ack = route.receipt ? route.receipt(result, record) : telegramReceipt(result, record.payload.chat_id);
    const appRow = (result as { app_row_id?: unknown } | null)?.app_row_id;
    if (ack !== null && ack !== 'held' && typeof appRow === 'string') {
      if (record.dayCard) link.card(record.dayCard, appRow);
      if (record.update) link.update(record.update.recordId, appRow);
      if (record.revision) link.revision?.(record.revision, appRow, record.id);
      link.row?.(appRow, record.trace);
    }
    return ack;
  },
});
