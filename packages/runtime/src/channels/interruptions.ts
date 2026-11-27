import type { HealthCardAdmission } from '../health/trigger';
import type { Proactivity } from './loops';
import { localIso } from './reminders';

// The owner's limits on Waldo reaching out unasked, beyond the day cards: an update, a clash, something it noticed. By the
// owner's ruling of 27 November there is no notification cap: Waldo keeps no daily count and no gap between two messages of
// its own, and whether something is worth saying, whether it asks a question and whether it is urgent are the model's call,
// made from what Waldo already sent today and what became of each (send-outcomes.ts). Code holds only consent, quiet hours,
// the owner's day, one question waiting, and a daily number the owner set for themselves (set_proactivity), which is their
// choice: past it the model may call something urgent from a small daily allowance, never past the rest. An owner who sets
// no unasked messages gets none, urgent included. One owner-local day's spend and the open question live in the owner's own
// KV: an id, a day and times, never text.
export const INTERRUPTS_KEY = 'proactive_interrupts_v1';
export const QUESTION_KEY = 'proactive_question_v1';

export type InterruptLimits = Readonly<{ perDay: number; urgentPerDay: number }>;
// Closed, for traces and evals: never a title, a time or an id.
export type InterruptHold = 'consent' | 'quiet' | 'closed' | 'question' | 'budget';
export type InterruptSpend = 'counted' | 'urgent';
export type InterruptState = Readonly<{ day: string; count: number; urgent: number; last: number | null }>;
export type OpenQuestion = Readonly<{ ref: string; at: number; day: string }>;
export type InterruptEnv = Readonly<{ PROACTIVE_URGENT_PER_DAY?: string }>;

const count = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};
// The only daily count is the owner's own number (set_proactivity), at every volume; without one there is none (low volume
// already holds everything but the day cards, as consent). Past their number the deployment's urgent allowance applies; their
// 0 means no unasked message at all, so it leaves none. PROACTIVE_INTERRUPTS_PER_DAY and PROACTIVE_GAP_MIN are no longer read.
export const interruptLimits = (env: InterruptEnv, proactivity: Proactivity): InterruptLimits => {
  const own = proactivity.interruptions_per_day;
  return own === undefined ? { perDay: Number.POSITIVE_INFINITY, urgentPerDay: 0 } : { perDay: own, urgentPerDay: own === 0 ? 0 : count(env.PROACTIVE_URGENT_PER_DAY, 1) };
};

export type HoldInput = Readonly<{
  // closed: outside the owner's day (the caller's window, from the day plan); like quiet hours, urgent never passes it.
  consent: boolean; quiet: boolean; closed?: boolean; asks: boolean; urgent: boolean;
  open: OpenQuestion | null; spent: InterruptState; limits: InterruptLimits; now: number;
}>;
// What holds one more interruption now, first failing first; null when it may go.
export const interruptHold = (input: HoldInput): InterruptHold | null => {
  if (!input.consent) return 'consent';
  if (input.quiet) return 'quiet';
  if (input.closed) return 'closed';
  if (input.asks && input.open) return 'question';
  const urgentLeft = input.urgent && input.spent.urgent < input.limits.urgentPerDay;
  return input.spent.count >= input.limits.perDay && !urgentLeft ? 'budget' : null;
};
// What an interruption that went is charged as: the owner's number while it lasts; past it, the urgent allowance, whether or
// not the model marked it (a card raised unmarked still went), so the allowance runs out and the card tools with it. Only with
// none left is it counted over, so the record still says what went. Without a number of the owner's every one is counted.
export const withinBudget = (spent: InterruptState, limits: InterruptLimits): boolean => spent.count < limits.perDay;
export const spendOf = (spent: InterruptState, limits: InterruptLimits): InterruptSpend =>
  withinBudget(spent, limits) || spent.urgent >= limits.urgentPerDay ? 'counted' : 'urgent';

// The owner's day for unasked messages, from their Brief to their Close on their own calendar day (dayPlanBook.window).
export type DayWindow = (day: string) => Readonly<{ opens: number; closes: number }>;
export const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 24 * 3_600_000).toISOString().slice(0, 10);
// When the owner's day opens again, or null inside it: nothing unasked goes before their Brief or from their Close on.
export const reopensAt = (now: number, timezone: string, window: DayWindow): number | null => {
  const day = localIso(now, timezone).slice(0, 10), { opens, closes } = window(day);
  return now < opens ? opens : now >= closes ? window(nextDay(day)).opens : null;
};

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }>;
export const interruptBook = (kv: Kv, deps: Readonly<{
  now(): number; timezone(): string;
  // Whether the owner has said anything, on any surface, since `at`: their next message answers or skips the question.
  ownerSpokeSince(at: number): boolean;
}>) => {
  const today = () => localIso(deps.now(), deps.timezone()).slice(0, 10);
  const spent = (): InterruptState => {
    const day = today(), stored = kv.get<InterruptState>(INTERRUPTS_KEY);
    return stored?.day === day ? stored : { day, count: 0, urgent: 0, last: stored?.last ?? null };
  };
  // A question waits until the owner next speaks, or until their day ends.
  const question = (): OpenQuestion | null => {
    const open = kv.get<OpenQuestion>(QUESTION_KEY) ?? null;
    return open && open.day === today() && !deps.ownerSpokeSince(open.at) ? open : null;
  };
  return {
    spent, question,
    hold: (input: Omit<HoldInput, 'open' | 'spent' | 'now'>): InterruptHold | null =>
      interruptHold({ ...input, open: question(), spent: spent(), now: deps.now() }),
    // Charges one interruption that went; run it in the transaction that records the delivery. ref names what went (a job,
    // a card), so the open question can be traced to it.
    spend(limits: InterruptLimits, asks: boolean, ref: string): InterruptSpend {
      const now = deps.now(), state = spent(), kind = spendOf(state, limits);
      kv.put(INTERRUPTS_KEY, { ...state, count: state.count + (kind === 'counted' ? 1 : 0), urgent: state.urgent + (kind === 'urgent' ? 1 : 0), last: now });
      if (asks) kv.put(QUESTION_KEY, { ref, at: now, day: state.day });
      return kind;
    },
    // A question asked at a fixed moment (the planning Brief's answers to tap): it waits like any other, and costs no budget.
    ask(ref: string): void {
      kv.put(QUESTION_KEY, { ref, at: deps.now(), day: today() });
    },
    // A line for the turn deciding whether to reach out: no count of Waldo's own, the owner's own number if they set one, and
    // whether a question is waiting. What already went today is the ledger's (send-outcomes.ts).
    line(limits: InterruptLimits): string {
      const state = spent(), left = Math.max(0, limits.perDay - state.count), urgentLeft = Math.max(0, limits.urgentPerDay - state.urgent);
      const own = Number.isFinite(limits.perDay);
      return [
        !own ? 'There is no daily count of unasked messages and no gap between them: judge whether this is worth the owner\'s attention now from what Waldo already sent today and what became of each, and from the owner\'s day. Raise an open loop again when it matters; do not nag.'
          : `The owner set ${limits.perDay} unasked messages a day for themselves: ${left ? `${left} more today` : 'none left today'}.`,
        ...(own ? [urgentLeft ? 'Only for something that truly cannot wait for the next day card, mark it urgent; that goes past their number, never past quiet hours.' : 'Nothing more can be marked urgent today.'] : []),
        question() ? 'A question to the owner is still waiting for their answer: do not ask another.' : 'You may ask the owner at most one question.',
      ].join(' ');
    },
  };
};
export type InterruptBook = ReturnType<typeof interruptBook>;

// A card budget of its own (the delivery gate's for health proposals) that also draws on the owner's limits: a health card
// stops at the owner's own number and holds outside the owner's day like any other unasked message. Quiet hours and consent
// stay with the caller.
export const drawingOn = (inner: Readonly<{ admit(id: string): HealthCardAdmission; charge(id: string): void }>, book: InterruptBook, limits: () => InterruptLimits, reopens: () => number | null) => ({
  admit: (id: string): HealthCardAdmission => {
    const until = reopens();
    if (until !== null) return { verdict: 'wait', until };
    const now = limits(), held = book.hold({ consent: true, quiet: false, asks: false, urgent: false, limits: now });
    if (held === 'budget') return { verdict: 'spent' };
    return inner.admit(id);
  },
  charge: (id: string): void => { inner.charge(id); book.spend(limits(), false, id); },
});
