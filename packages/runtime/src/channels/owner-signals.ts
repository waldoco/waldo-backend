import { OWNER_SIGNAL_SECRET_HEADER, ownerSignalSchema, type OwnerSignal } from '@waldo/contracts';
import { sameSecret } from './telegram-webhook';

export const OWNER_SIGNAL_PATH = '/signals';
export const NO_MESSAGE = 'NO_MESSAGE';
export const MAX_PROACTIVE_TURNS_PER_DAY = 12;
const MAX_SIGNAL_BYTES = 256_000;

export type OwnerSignalEnv = Readonly<{
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
  WALDO_OWNER_TELEGRAM_ID?: string;
  WALDO_SIGNAL_SECRET?: string;
}>;

// A proactive turn is either a device signal or Waldo's own morning deadline firing because no
// wake-up signal arrived. The deadline is a fallback, not the schedule.
export type ProactiveTrigger = OwnerSignal | Readonly<{ kind: 'morning_deadline' }>;

export const handleOwnerSignal = async (
  request: Request,
  env: OwnerSignalEnv,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response> => {
  const secret = env.WALDO_SIGNAL_SECRET;
  if (request.method !== 'POST' || !secret || secret.length < 16 || !env.TELEGRAM_OWNER_DO || !env.WALDO_OWNER_TELEGRAM_ID) {
    return new Response('not found', { status: 404 });
  }
  if (!sameSecret(request.headers.get(OWNER_SIGNAL_SECRET_HEADER) ?? '', secret)) {
    return new Response('forbidden', { status: 403 });
  }
  const body = await request.text();
  if (body.length > MAX_SIGNAL_BYTES) return new Response('payload too large', { status: 413 });
  let parsed: ReturnType<typeof ownerSignalSchema.safeParse>;
  try {
    parsed = ownerSignalSchema.safeParse(JSON.parse(body));
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (!parsed.success) return new Response('bad request', { status: 400 });
  const stub = env.TELEGRAM_OWNER_DO.get(env.TELEGRAM_OWNER_DO.idFromName(env.WALDO_OWNER_TELEGRAM_ID));
  waitUntil(stub.fetch('https://telegram-owner/signal', { method: 'POST', body: JSON.stringify(parsed.data) }));
  return new Response('accepted', { status: 202 });
};

export type LocalClock = Readonly<{ date: string; time: string; label: string; timeZone: string }>;

export const localClock = (nowMs: number, timeZone: string): LocalClock => {
  const parts = wallParts(nowMs, timeZone);
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(nowMs);
  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
    label,
    timeZone,
  };
};

// Epoch ms of the next occurrence of local wall time `hhmm` in `timeZone`, strictly after now.
export const nextLocalTime = (nowMs: number, timeZone: string, hhmm: string): number => {
  const [hour, minute] = parseHhmm(hhmm);
  const today = wallParts(nowMs, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timeZone);
    if (at > nowMs) return at;
  }
  throw new Error('no next local time');
};

export const parseHhmm = (hhmm: string): readonly [number, number] => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error('local time must be HH:MM');
  return [Number(match[1]), Number(match[2])];
};

// Bounded per-day bookkeeping. It records which proactive moments already happened today so a
// retried Shortcut or a late wake-up after the deadline brief never produces a second message.
// It holds date keys and counts only, never times or readings.
export type ProactiveLedger = Readonly<{ date: string; done: readonly string[]; count: number }>;

export const ledgerFor = (stored: ProactiveLedger | undefined, date: string): ProactiveLedger =>
  stored?.date === date ? stored : { date, done: [], count: 0 };

export const triggerKey = async (trigger: ProactiveTrigger, clock: LocalClock): Promise<string> => {
  switch (trigger.kind) {
    case 'woke_up':
    case 'morning_deadline':
      return 'morning';
    case 'winding_down':
      return 'evening';
    case 'workout_ended':
      return `workout:${clock.time.slice(0, 2)}`;
    case 'meeting_notes':
      return `meeting:${trigger.id ?? await digest(trigger.notes)}`;
  }
};

export type Admission = Readonly<{ admit: true } | { admit: false; reason: 'already_handled' | 'daily_cap' }>;

export const admit = (ledger: ProactiveLedger, key: string): Admission => {
  if (ledger.done.includes(key)) return { admit: false, reason: 'already_handled' };
  if (ledger.count >= MAX_PROACTIVE_TURNS_PER_DAY) return { admit: false, reason: 'daily_cap' };
  return { admit: true };
};

export const settle = (ledger: ProactiveLedger, key: string): ProactiveLedger => ({
  date: ledger.date,
  done: [...ledger.done, key],
  count: ledger.count + 1,
});

const SOURCE = '[Not written by the owner. This turn was started by';

// The persisted conversation entry: what happened and the context the device sent. It carries no
// clock time, so the transcript does not record when the owner woke or trained.
export const triggerEntry = (trigger: ProactiveTrigger): string => {
  const lines = [headline(trigger)];
  if (trigger.kind === 'meeting_notes') lines.push('', 'Meeting notes:', trigger.notes);
  const context = 'context' in trigger ? trigger.context : undefined;
  if (context?.weather) lines.push('', `Weather now: ${context.weather}`);
  if (context?.calendar) lines.push('', "Today's calendar from the owner's iPhone:", context.calendar);
  return lines.join('\n');
};

const headline = (trigger: ProactiveTrigger): string => {
  switch (trigger.kind) {
    case 'woke_up':
      return `${SOURCE} the owner's iPhone.] Their Apple Watch reports they just woke up.`;
    case 'morning_deadline':
      return `${SOURCE} Waldo's own morning check-in.] No wake-up signal arrived from the owner's devices this morning.`;
    case 'winding_down':
      return `${SOURCE} the owner's iPhone.] Their wind-down for sleep has just started.`;
    case 'workout_ended':
      return `${SOURCE} the owner's Apple Watch.] They just finished a workout${trigger.activity ? `: ${trigger.activity}` : ''}.`;
    case 'meeting_notes':
      return `${SOURCE} the owner's meeting-notes app.] A meeting note just finished${trigger.title ? `: ${trigger.title}` : ''}.`;
  }
};

// Situation framing for the model. It describes the moment and what tends to help; whether to
// speak, and what to say, stays the model's call.
export const proactiveInstruction = (trigger: ProactiveTrigger, clock: LocalClock): string => [
  `Owner's local time now: ${clock.label} (${clock.timeZone}).`,
  'This turn was started by a signal from the owner\'s devices or by your own check-in, not by a message from the owner.',
  'Decide whether messaging the owner right now would genuinely help them. If it would, reply with exactly the message to send: short, warm, specific, plain text, bullets written as "• ". Use the calendar, weather, conversation and memory you have; never invent events or facts you were not given.',
  `If there is nothing worth saying right now, reply with exactly ${NO_MESSAGE} and nothing else.`,
  situation(trigger),
].join('\n');

const situation = (trigger: ProactiveTrigger): string => {
  switch (trigger.kind) {
    case 'woke_up':
    case 'morning_deadline':
      return 'This is the good-morning moment: how the day is shaped, what to get ready for first, and anything from memory or open follow-ups worth surfacing today.';
    case 'winding_down':
      return 'This is the end-of-day close: what got done or moved today if you know, anything still open, and what tomorrow starts with. Keep it light; they are heading to bed.';
    case 'workout_ended':
      return 'They just came out of a workout. A practical, everyday suggestion for eating and recovering that fits around their next commitments can help. No calorie, macro or dose numbers, and nothing clinical.';
    case 'meeting_notes':
      return 'Turn the notes into a few bullet action items, naming who owns each when the notes say so. If the calendar shows this meeting at a different time than when the note was taken, mention that it seems to have moved.';
  }
};

const pad = (value: number) => String(value).padStart(2, '0');

const wallParts = (ms: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
};

const zonedToUtc = (year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number => {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const seen = wallParts(guess, timeZone);
    const seenWall = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    guess += wall - seenWall;
  }
  return guess;
};

const digest = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
