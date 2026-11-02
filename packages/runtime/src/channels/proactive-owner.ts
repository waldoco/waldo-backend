import {
  admit, ledgerFor, localClock, nextLocalTime, parseHhmm, proactiveInstruction, settle, triggerEntry, triggerKey,
  type ProactiveLedger, type ProactiveTrigger,
} from './owner-signals';
import type { TelegramResponder } from './telegram-turn';

const LEDGER_KEY = 'proactive-ledger';
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
export const DEFAULT_MORNING_DEADLINE = '09:30';

export type ProactiveOutcome = 'sent' | 'quiet' | 'already_handled' | 'daily_cap' | 'failed';

export type ProactiveOwnerOptions = Readonly<{
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'getAlarm'>;
  arm(at: number): Promise<void>;
  responder: Pick<TelegramResponder, 'proactive'>;
  send(text: string): Promise<unknown>;
  ownerChatId: number;
  // Unset means the owner has not told Waldo their timezone: signals still work, but there is
  // no local morning to hold a deadline against.
  timeZone: string | null;
  morningDeadline: string;
  now(): number;
  log(entry: object): void;
  newId?(): string;
}>;

export class ProactiveOwner {
  constructor(private readonly options: ProactiveOwnerOptions) {
    parseHhmm(options.morningDeadline);
    if (options.timeZone !== null) localClock(0, options.timeZone);
  }

  async handle(trigger: ProactiveTrigger): Promise<ProactiveOutcome> {
    const { storage, responder, now, log } = this.options;
    const clock = localClock(now(), this.options.timeZone ?? 'UTC');
    const key = await triggerKey(trigger, clock);
    let ledger = ledgerFor(await storage.get<ProactiveLedger>(LEDGER_KEY), clock.date);
    const admission = admit(ledger, key);
    if (!admission.admit) {
      log({ hop: 'proactive', kind: trigger.kind, outcome: admission.reason });
      return admission.reason;
    }
    // Count the attempt before the model call so a failing provider cannot loop past the cap.
    ledger = { ...ledger, count: ledger.count + 1 };
    await storage.put(LEDGER_KEY, ledger);
    try {
      const reply = await responder.proactive({
        id: (this.options.newId ?? (() => crypto.randomUUID()))(),
        chatId: this.options.ownerChatId,
        entryText: triggerEntry(trigger),
        instruction: proactiveInstruction(trigger, clock),
      });
      if (reply !== null) {
        await this.options.send(reply.text);
        await reply.commit();
      }
      await storage.put(LEDGER_KEY, { ...settle(ledger, key), count: ledger.count });
      const outcome = reply === null ? 'quiet' : 'sent';
      log({ hop: 'proactive', kind: trigger.kind, outcome });
      return outcome;
    } catch (error) {
      log({ hop: 'proactive', kind: trigger.kind, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
      return 'failed';
    }
  }

  async onAlarm(): Promise<void> {
    const { timeZone, morningDeadline, now, storage } = this.options;
    if (timeZone === null) return;
    const clock = localClock(now(), timeZone);
    const ledger = ledgerFor(await storage.get<ProactiveLedger>(LEDGER_KEY), clock.date);
    let outcome: ProactiveOutcome | null = null;
    if (!ledger.done.includes('morning') && clock.time >= morningDeadline) {
      outcome = await this.handle({ kind: 'morning_deadline' });
    }
    await this.options.arm(
      outcome === 'failed' ? now() + RETRY_AFTER_FAILURE_MS : nextLocalTime(now(), timeZone, morningDeadline),
    );
  }

  async ensureArmed(): Promise<void> {
    const { timeZone, morningDeadline, now, storage } = this.options;
    if (timeZone === null || (await storage.getAlarm()) !== null) return;
    await this.options.arm(nextLocalTime(now(), timeZone, morningDeadline));
  }
}
