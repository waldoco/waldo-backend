import {
  isHealthSignal, OWNER_SIGNAL_SECRET_HEADER, ownerSignalSchema, type HealthSignalEvent, type OwnerSignal,
} from '@waldo/contracts';
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

// A proactive turn starts from a device signal, from Waldo's own morning deadline when no
// wake-up arrived (a fallback, not the schedule), or from a check-back the model asked for in an
// earlier proactive turn.
export type ProactiveTrigger =
  | Readonly<{ origin: 'signal'; signal: OwnerSignal }>
  | Readonly<{ origin: 'morning_deadline' }>
  | Readonly<{ origin: 'check_back'; id: string; why: string }>;

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

// Idempotency, not judgment: the same moment never runs twice. Waking up and winding down are
// once-a-day moments; the morning deadline shares the wake-up key so a late wake-up after the
// fallback brief stays quiet. Other signals dedupe by the sender's id, or else by content within
// the hour, which absorbs automation retries.
export const triggerKey = async (trigger: ProactiveTrigger, clock: LocalClock): Promise<string> => {
  switch (trigger.origin) {
    case 'morning_deadline':
      return 'morning';
    case 'check_back':
      return `check:${trigger.id}`;
    case 'signal': {
      const { signal } = trigger;
      if (signal.source === 'health' && signal.event === 'woke_up') return 'morning';
      if (signal.source === 'health' && signal.event === 'wind_down') return 'evening';
      if (signal.id !== undefined) return `id:${signal.source}:${signal.id}`;
      return `signal:${await digest(JSON.stringify(signal))}:${clock.time.slice(0, 2)}`;
    }
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

// The persisted conversation entry: what happened and the context the sender attached. It
// carries no clock time, so the transcript does not record when the owner woke or trained.
export const triggerEntry = (trigger: ProactiveTrigger): string => {
  switch (trigger.origin) {
    case 'morning_deadline':
      return "[Not written by the owner. Waldo's own morning check-in.] No wake-up signal arrived from the owner's devices this morning.";
    case 'check_back':
      return `[Not written by the owner. A check-back you scheduled earlier.] You wanted to look again: ${trigger.why}`;
    case 'signal': {
      const { signal } = trigger;
      const lines = [`[Not written by the owner. Signal from ${signal.source}: ${signal.event}.]`];
      if (isHealthSignal(signal)) {
        lines.push(HEALTH_EVENT[signal.event] + (signal.activity ? ` Activity: ${signal.activity}.` : ''));
      } else if (signal.detail !== undefined) {
        lines.push(signal.detail);
      }
      for (const [key, value] of Object.entries(signal.context ?? {})) lines.push('', `${key}:`, value);
      return lines.join('\n');
    }
  }
};

const HEALTH_EVENT: Readonly<Record<HealthSignalEvent, string>> = {
  woke_up: "The owner's watch reports they just woke up.",
  wind_down: "The owner's wind-down for sleep has started.",
  workout_started: 'The owner just started a workout.',
  workout_ended: 'The owner just finished a workout.',
};

export const CHECK_BACK = 'CHECK_BACK';

// One frame for every moment. It says what spontaneity is for and what tends to help; which
// moments matter, whether to speak and whether to look again later stay the model's call.
export const proactiveInstruction = (clock: LocalClock): string => [
  `Owner's local time now: ${clock.label} (${clock.timeZone}).`,
  "This turn was started by something happening in the owner's day, reported by their devices or apps, or by your own check-in. It was not a message from the owner.",
  'Work out what this moment changes for them: the next few hours, commitments that moved, things to prepare, loops to close, energy and recovery. Life is not on a fixed schedule; respond to what actually happened.',
  'If a message would genuinely help now, reply with exactly the message to send: short, warm, specific, plain text, bullets written as "• ". Use the calendar, notes, conversation and memory you have. Never invent events or facts you were not given, and never quote health measurements.',
  `If nothing is worth saying right now, reply with exactly ${NO_MESSAGE}.`,
  `If it would help to look again later (when a meeting should be over, before they need to leave, to see whether something arrived), add a final line "${CHECK_BACK} HH:MM <what to look at>" using the owner's local time within the next 24 hours. You may do this with or without a message.`,
].join('\n');

export type CheckBackRequest = Readonly<{ at: string; why: string }>;
export type ParsedReply = Readonly<{ message: string | null; checkBacks: readonly CheckBackRequest[] }>;

// Separates the protocol lines the instruction defines from the message itself.
export const parseReply = (raw: string): ParsedReply => {
  const checkBacks: CheckBackRequest[] = [];
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*CHECK_BACK:?\s+([01]\d|2[0-3]):([0-5]\d)\s+(.+?)\s*$/.exec(line);
    if (match) checkBacks.push({ at: `${match[1]}:${match[2]}`, why: match[3]!.slice(0, 500) });
    else kept.push(line);
  }
  const message = kept.join('\n').trim();
  return { message: message.length === 0 || message === NO_MESSAGE ? null : message, checkBacks };
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
