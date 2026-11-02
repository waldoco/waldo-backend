import {
  admit, ledgerFor, localClock, nextLocalTime, parseHhmm, parseReply, proactiveInstruction, settle, triggerEntry,
  triggerKey, type CheckBackRequest, type ProactiveLedger, type ProactiveTrigger,
} from './owner-signals';
import type { TelegramResponder } from './telegram-turn';

const LEDGER_KEY = 'proactive-ledger';
const CHECK_BACKS_KEY = 'proactive-check-backs';
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
export const MAX_PENDING_CHECK_BACKS = 6;
export const DEFAULT_MORNING_DEADLINE = '09:30';

export type ProactiveOutcome = 'sent' | 'quiet' | 'already_handled' | 'daily_cap' | 'failed';

type CheckBack = Readonly<{ id: string; at: number; why: string }>;

export type ProactiveOwnerOptions = Readonly<{
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'getAlarm'>;
  arm(at: number): Promise<void>;
  responder: Pick<TelegramResponder, 'proactive'>;
  send(text: string): Promise<unknown>;
  ownerChatId: number;
  // Unset means the owner has not told Waldo their timezone: signals still work, but there is no
  // local clock to hold a morning deadline or a check-back time against.
  timeZone: string | null;
  // Local HH:MM safety net for days with no wake-up signal; null turns it off (shift workers).
  morningDeadline: string | null;
  now(): number;
  log(entry: object): void;
  newId?(): string;
}>;

// Owns the owner DO's single alarm slot: it always points at the earliest of the next morning
// deadline and the earliest pending check-back.
export class ProactiveOwner {
  constructor(private readonly options: ProactiveOwnerOptions) {
    if (options.morningDeadline !== null) parseHhmm(options.morningDeadline);
    if (options.timeZone !== null) localClock(0, options.timeZone);
  }

  async handle(trigger: ProactiveTrigger): Promise<ProactiveOutcome> {
    const outcome = await this.#run(trigger);
    await this.#rearm();
    return outcome;
  }

  async onAlarm(): Promise<void> {
    const { timeZone, morningDeadline, now, storage } = this.options;
    if (timeZone === null) return;
    let retryAt: number | null = null;

    const pending = await this.#checkBacks();
    const due = pending.filter((check) => check.at <= now());
    await storage.put(CHECK_BACKS_KEY, pending.filter((check) => check.at > now()));
    for (const check of due) await this.#run({ origin: 'check_back', id: check.id, why: check.why });

    const clock = localClock(now(), timeZone);
    const ledger = ledgerFor(await storage.get<ProactiveLedger>(LEDGER_KEY), clock.date);
    if (morningDeadline !== null && !ledger.done.includes('morning') && clock.time >= morningDeadline) {
      if (await this.#run({ origin: 'morning_deadline' }) === 'failed') retryAt = now() + RETRY_AFTER_FAILURE_MS;
    }
    await this.#rearm(retryAt);
  }

  async ensureArmed(): Promise<void> {
    if ((await this.options.storage.getAlarm()) === null) await this.#rearm();
  }

  async #run(trigger: ProactiveTrigger): Promise<ProactiveOutcome> {
    const { storage, responder, now, log } = this.options;
    const kind = trigger.origin === 'signal' ? `${trigger.signal.source}:${trigger.signal.event}` : trigger.origin;
    const clock = localClock(now(), this.options.timeZone ?? 'UTC');
    const key = await triggerKey(trigger, clock);
    let ledger = ledgerFor(await storage.get<ProactiveLedger>(LEDGER_KEY), clock.date);
    const admission = admit(ledger, key);
    if (!admission.admit) {
      log({ hop: 'proactive', kind, outcome: admission.reason });
      return admission.reason;
    }
    // Count the attempt before the model call so a failing provider cannot loop past the cap.
    ledger = { ...ledger, count: ledger.count + 1 };
    await storage.put(LEDGER_KEY, ledger);
    try {
      const reply = await responder.proactive({
        id: this.#newId(),
        chatId: this.options.ownerChatId,
        entryText: triggerEntry(trigger),
        instruction: proactiveInstruction(clock),
      });
      const parsed = parseReply(reply.text);
      if (parsed.message !== null) {
        await this.options.send(parsed.message);
        await reply.commit();
      }
      await storage.put(LEDGER_KEY, { ...settle(ledger, key), count: ledger.count });
      const scheduled = await this.#schedule(parsed.checkBacks);
      const outcome = parsed.message === null ? 'quiet' : 'sent';
      log({ hop: 'proactive', kind, outcome, check_backs: scheduled });
      return outcome;
    } catch (error) {
      log({ hop: 'proactive', kind, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
      return 'failed';
    }
  }

  async #schedule(requests: readonly CheckBackRequest[]): Promise<number> {
    const { timeZone, now, storage, log } = this.options;
    if (requests.length === 0) return 0;
    if (timeZone === null) {
      log({ hop: 'proactive', outcome: 'check_back_dropped', reason: 'no_timezone' });
      return 0;
    }
    const pending = [...await this.#checkBacks()];
    let scheduled = 0;
    for (const request of requests) {
      if (pending.length >= MAX_PENDING_CHECK_BACKS) {
        log({ hop: 'proactive', outcome: 'check_back_dropped', reason: 'too_many_pending' });
        break;
      }
      pending.push({ id: this.#newId(), at: nextLocalTime(now(), timeZone, request.at), why: request.why });
      scheduled += 1;
    }
    await storage.put(CHECK_BACKS_KEY, pending);
    return scheduled;
  }

  async #rearm(retryAt: number | null = null): Promise<void> {
    const { timeZone, morningDeadline, now, storage } = this.options;
    if (timeZone === null) return;
    // Once today's morning moment is handled, the next deadline worth waking for is tomorrow's.
    const clock = localClock(now(), timeZone);
    const morningDone = ledgerFor(await storage.get<ProactiveLedger>(LEDGER_KEY), clock.date).done.includes('morning');
    const candidates = (await this.#checkBacks()).map((check) => check.at);
    if (morningDeadline !== null) {
      let deadline = nextLocalTime(now(), timeZone, morningDeadline);
      if (morningDone && localClock(deadline, timeZone).date === clock.date) deadline = nextLocalTime(deadline, timeZone, morningDeadline);
      candidates.push(deadline);
    }
    if (retryAt !== null) candidates.push(retryAt);
    if (candidates.length > 0) await this.options.arm(Math.min(...candidates));
  }

  async #checkBacks(): Promise<readonly CheckBack[]> {
    return (await this.options.storage.get<readonly CheckBack[]>(CHECK_BACKS_KEY)) ?? [];
  }

  #newId(): string {
    return (this.options.newId ?? (() => crypto.randomUUID()))();
  }
}
