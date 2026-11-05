import type { HealthCardAdmission } from '../health/trigger';
import type { Proactivity } from './loops';
import { localIso } from './reminders';

// The owner's limits on Waldo reaching out unasked, beyond the day cards: an update, a clash, something it noticed. Code holds
// only these limits (consent, quiet hours, one question waiting, the day's budget, the gap between two interruptions);
// whether something is worth an interruption, whether it asks a question and whether it is urgent are the model's call.
// The model may call something urgent to go past the budget and the gap, from a small daily allowance, never past consent,
// quiet hours or a question still waiting on the owner. One owner-local day's spend and the open question live in the
// owner's own KV: an id, a day and times, never text.
export const INTERRUPTS_KEY = 'proactive_interrupts_v1';
export const QUESTION_KEY = 'proactive_question_v1';

export type InterruptLimits = Readonly<{ perDay: number; urgentPerDay: number; gapMs: number }>;
// Closed, for traces and evals: never a title, a time or an id.
export type InterruptHold = 'consent' | 'quiet' | 'question' | 'budget' | 'cooldown';
export type InterruptSpend = 'counted' | 'urgent';
export type InterruptState = Readonly<{ day: string; count: number; urgent: number; last: number | null }>;
export type OpenQuestion = Readonly<{ ref: string; at: number; day: string }>;
export type InterruptEnv = Readonly<{ PROACTIVE_INTERRUPTS_PER_DAY?: string; PROACTIVE_URGENT_PER_DAY?: string; PROACTIVE_GAP_MIN?: string }>;

const count = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};
// The deployment's defaults, which the owner's own number (set_proactivity) replaces.
export const interruptLimits = (env: InterruptEnv, proactivity: Proactivity): InterruptLimits => ({
  perDay: proactivity.interruptions_per_day ?? count(env.PROACTIVE_INTERRUPTS_PER_DAY, 2),
  urgentPerDay: count(env.PROACTIVE_URGENT_PER_DAY, 1),
  gapMs: count(env.PROACTIVE_GAP_MIN, 60) * 60_000,
});

export type HoldInput = Readonly<{
  consent: boolean; quiet: boolean; asks: boolean; urgent: boolean;
  open: OpenQuestion | null; spent: InterruptState; limits: InterruptLimits; now: number;
}>;
// What holds one more interruption now, first failing first; null when it may go.
export const interruptHold = (input: HoldInput): InterruptHold | null => {
  if (!input.consent) return 'consent';
  if (input.quiet) return 'quiet';
  if (input.asks && input.open) return 'question';
  const urgentLeft = input.urgent && input.spent.urgent < input.limits.urgentPerDay;
  if (input.spent.count >= input.limits.perDay) return urgentLeft ? null : 'budget';
  const gap = input.spent.last !== null && input.now - input.spent.last < input.limits.gapMs;
  return gap && !urgentLeft ? 'cooldown' : null;
};
// What an interruption that went is charged as: the budget while it lasts and the gap has passed, the urgent allowance after.
export const spendOf = (spent: InterruptState, limits: InterruptLimits, now: number): InterruptSpend =>
  spent.count < limits.perDay && (spent.last === null || now - spent.last >= limits.gapMs) ? 'counted' : 'urgent';

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
      const now = deps.now(), state = spent(), kind = spendOf(state, limits, now);
      kv.put(INTERRUPTS_KEY, { ...state, count: state.count + (kind === 'counted' ? 1 : 0), urgent: state.urgent + (kind === 'urgent' ? 1 : 0), last: now });
      if (asks) kv.put(QUESTION_KEY, { ref, at: now, day: state.day });
      return kind;
    },
    // A line for the turn deciding whether to reach out: what is left today, and whether a question is waiting.
    line(limits: InterruptLimits): string {
      const state = spent(), left = Math.max(0, limits.perDay - state.count), urgentLeft = Math.max(0, limits.urgentPerDay - state.urgent);
      return [
        left ? `Waldo can reach the owner unasked ${left === 1 ? 'once more' : `${left} more times`} today.` : 'The owner\'s budget for unasked messages is spent for today.',
        urgentLeft ? 'Only for something that truly cannot wait for the next day card, mark it urgent; that goes past the budget, never past quiet hours.' : 'Nothing more can be marked urgent today.',
        question() ? 'A question to the owner is still waiting for their answer: do not ask another.' : 'You may ask the owner at most one question.',
      ].join(' ');
    },
  };
};
export type InterruptBook = ReturnType<typeof interruptBook>;

// A card budget of its own (the delivery gate's for health proposals) that also draws on the owner's limits: a health card
// waits out the gap and stops at the day's budget like any other unasked message. Quiet hours and consent stay with the caller.
export const drawingOn = (inner: Readonly<{ admit(id: string): HealthCardAdmission; charge(id: string): void }>, book: InterruptBook, limits: () => InterruptLimits) => ({
  admit: (id: string): HealthCardAdmission => {
    const now = limits(), held = book.hold({ consent: true, quiet: false, asks: false, urgent: false, limits: now });
    if (held === 'budget') return { verdict: 'spent' };
    if (held === 'cooldown') return { verdict: 'wait', until: book.spent().last! + now.gapMs };
    return inner.admit(id);
  },
  charge: (id: string): void => { inner.charge(id); book.spend(limits(), false, id); },
});
