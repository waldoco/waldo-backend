import {telegramRichReply} from './rich-format';
import { sendTelegramFinal, type TelegramFinalPayload } from './telegram-api';
import { redactSecretUrls } from './egress-guard';
import { ownerTurnTrace } from './owner-turn-envelope';
import { telegramReaction } from './reactions';
import type { TelegramInboundTurn, TelegramPollingAdapter, TelegramUnsupportedTurn } from './telegram-polling';


export const TURN_TIMEOUT_MS = 150_000;
// Reactions are best-effort UX; one hung call must never gate the turn that follows it.
import { turnFailureCode } from './turn-failure-code';

export const REACTION_TIMEOUT_MS = 5_000;

class TurnTimeout extends Error {
  constructor(ms: number) { super(`turn timed out after ${ms} ms`); }
}

export type TelegramOwnerApi = Readonly<{
  setMessageReaction(request: Readonly<{ chat_id: number; message_id: number; reaction: readonly Readonly<{ type: 'emoji'; emoji: string }>[] }>): Promise<unknown>;
  sendChatAction(request: Readonly<{ chat_id: number; action: 'typing' }>): Promise<unknown>;
  sendMessage(request: Readonly<{ chat_id: number; text: string; parse_mode?: 'HTML' }>): Promise<unknown>;
}>;

export type { TurnLogEntry, TurnText, TurnTimer } from './owner-turn-types';
import type { TurnLogEntry, TurnTimer } from './owner-turn-types';

export type TelegramOwnerListenerOptions = Readonly<{
  ownerTelegramId: number;
  surface?: 'telegram' | 'whatsapp';
  api: TelegramOwnerApi;
  respond(turn: TelegramInboundTurn, time: TurnTimer): Promise<string>;
  queueFinal?(turn: TelegramInboundTurn, payload: TelegramFinalPayload, reaction: string): Promise<void>;
  clearTurnReceipts?(trace: string): void;
  turnTimeoutMs?: number;
  reactionTimeoutMs?: number;
  chooseReaction?(turn: TelegramInboundTurn): Promise<string | null>;
  saveOffset(offset: number): Promise<void>;
  log?(entry: TurnLogEntry): void;
  now?(): number;
  typingEveryMs?: number;
  ackEmoji?: string;
  doneEmoji?: string;
  failedEmoji?: string;
  failureText?: string;
  unsupportedText?: string;
}>;

export type TelegramTurnOutcome = 'queued' | 'answered' | 'failed' | 'ignored' | 'unsupported';

export class TelegramOwnerListener {
  constructor(private readonly options: TelegramOwnerListenerOptions) {
    if (!Number.isSafeInteger(options.ownerTelegramId) || options.ownerTelegramId <= 0) {
      throw new Error('telegram owner id is invalid');
    }
  }

  async pollOnce(adapter: TelegramPollingAdapter, timeout = 25): Promise<readonly TelegramTurnOutcome[]> {
    const polled = await adapter.poll(timeout);
    const outcomes: TelegramTurnOutcome[] = [];
    for (const turn of polled.accepted) outcomes.push(await this.handle(turn));
    for (const turn of polled.unsupported) outcomes.push(await this.handleUnsupported(turn));
    await this.options.saveOffset(polled.nextOffset);
    return outcomes;
  }

  async handleUnsupported(turn: TelegramUnsupportedTurn): Promise<TelegramTurnOutcome> {
    const owner = this.options.ownerTelegramId;
    if (turn.senderId !== owner || turn.chatId !== owner) return 'ignored';
    const { api } = this.options;
    const chat_id = turn.chatId;
    this.options.log?.({ trace: ownerTurnTrace(this.options.surface ?? 'telegram', turn.updateId), hop: 'unsupported', ms: 0, ok: true, ...(turn.note === undefined ? {} : { detail: turn.note }) });
    await api.sendMessage({ chat_id, text: this.options.unsupportedText ?? 'I can read text, photos, documents and voice notes here. Videos, stickers, forwards and some formatting do not come through yet.' }).catch(() => undefined);
    if (turn.messageId !== null) {
      await api.setMessageReaction({ chat_id, message_id: turn.messageId, reaction: [{ type: 'emoji', emoji: '🤷' }] }).catch(() => undefined);
    }
    return 'unsupported';
  }

  async handle(turn: TelegramInboundTurn): Promise<TelegramTurnOutcome> {
    const owner = this.options.ownerTelegramId;
    if (turn.senderId !== owner || turn.chatId !== owner) return 'ignored';
    const originalApi = this.options.api;
    const api: TelegramOwnerApi = turn.runScope ? {
      sendMessage: payload => { turn.runScope!.admit(); return originalApi.sendMessage(payload); },
      setMessageReaction: payload => { turn.runScope!.admit(); return originalApi.setMessageReaction(payload); },
      sendChatAction: payload => { turn.runScope!.admit(); return originalApi.sendChatAction(payload); },
    } : originalApi;
    const now = this.options.now ?? Date.now;
    const trace = ownerTurnTrace(this.options.surface ?? 'telegram', turn.updateId);
    const log = (hop: string, ms: number, ok: boolean, error?: string, code?: string) =>
      this.options.log?.(error === undefined ? { trace, hop, ms, ok } : { trace, hop, ms, ok, error, ...(code === undefined ? {} : { code }) });
    const time: TurnTimer = async (hop, work) => {
      const start = now();
      try {
        const value = await work();
        log(hop, now() - start, true);
        return value;
      } catch (error) {
        // The typed code is what survives capture-off: the privacy gate drops error text but
        // keeps `code`, so a failed hop stays diagnosable without free-form content.
        log(hop, now() - start, false, error instanceof Error ? error.message : String(error), turnFailureCode(error));
        throw error;
      }
    };
    const started = now();
    if (turn.sentAt !== null) log('pickup', Math.max(0, started - turn.sentAt), true);
    const chat_id = turn.chatId;
    const ack = this.options.ackEmoji ?? '👀';
    const message_id = turn.messageId;
    const react = (hop: string, emoji: string): Promise<void> => {
      if (message_id === null) return Promise.resolve();
      const limit = this.options.reactionTimeoutMs ?? REACTION_TIMEOUT_MS;
      const t0 = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // One span per reaction: whichever of success, failure, or the timeout lands first wins,
      // so a hung reaction does not log a second misleading span when the API abort fires later.
      let settled = false;
      const done = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        log(hop, Math.max(0, now() - t0), ok, error);
      };
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(() => { done(false, 'telegram reaction timed out'); resolve(undefined); }, limit);
      });
      const attempt = api.setMessageReaction({ chat_id, message_id, reaction: [{ type: 'emoji', emoji }] })
        .then(() => done(true), (error) => done(false, error instanceof Error ? error.message : String(error)));
      return Promise.race([attempt, bounded]).finally(() => clearTimeout(timer));
    };
    await react('receipt', ack);
    let readyChoice: string | null = null;
    const choice = message_id === null || !this.options.chooseReaction
      ? Promise.resolve(null)
      : time('choose_reaction', () => this.options.chooseReaction!(turn)).catch(() => null).then(value => { readyChoice = value; return value; });
    const typing = async () => { try { await api.sendChatAction({ chat_id, action: 'typing' }); } catch { /* bounded UX only */ } };
    await time('typing', typing);
    const typingTimer = setInterval(typing, this.options.typingEveryMs ?? 4_000);
    const clearRunTimers = () => { clearInterval(typingTimer); };
    turn.runScope?.signal.addEventListener('abort', clearRunTimers, { once: true });
    try {
      const limit = turn.runScope ? Math.max(0, turn.runScope.deadline - now()) : this.options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TurnTimeout(limit)), limit); });
      const text = (await time('respond', () => Promise.race([this.options.respond(turn, time), timeout]).finally(() => clearTimeout(timer)))).trim();
      if (text.length === 0) throw new Error('empty reply');
      // The responder has already applied current-turn artifact receipt admission.
      // Rich formatting is confined to this final reply, never progress/events/errors.
      const guardedText = redactSecretUrls(text).text;
      const rich = telegramRichReply(guardedText);
      if (this.options.queueFinal) {
        const chosen = telegramReaction(readyChoice);
        const finalReaction = chosen !== null && chosen !== ack ? chosen : this.options.doneEmoji ?? '👌';
        await time('outbox_enqueue', () => this.options.queueFinal!(turn, { chat_id, ...(rich.text === guardedText ? { text: guardedText } : rich) }, finalReaction));
        this.options.log?.({ trace, hop: 'delivery_pending', ms: now() - started, ok: true });
        return 'queued';
      }
      // A blocked send (unlinked or rebound owner) returns no message: the turn did not reach the owner.
      const delivered = await time('send', () => sendTelegramFinal(payload => api.sendMessage(payload), { chat_id, ...(rich.text===guardedText ? {text: guardedText} : rich) }));
      if (delivered === undefined) throw new Error('telegram send blocked');
      const chosen = telegramReaction(await choice);
      await react('resolved', chosen !== null && chosen !== ack ? chosen : this.options.doneEmoji ?? '👌');
      this.options.log?.({ trace, hop: 'turn', ms: now() - started, ok: true, text: { input: turn.text, output: text } });
      return 'answered';
    } catch (error) {
      const failure = error instanceof TurnTimeout
        ? 'That took too long. In-flight changes may still finish. Try again, or split it into smaller asks.'
        : this.options.failureText ?? 'Sorry - I hit a problem answering that. Please try again in a moment.';
      if (turn.runScope) throw error;
      await api.sendMessage({ chat_id, text: failure }).catch(() => undefined);
      await react('failed', this.options.failedEmoji ?? '😢');
      log('turn', now() - started, false, error instanceof Error ? error.message : String(error), turnFailureCode(error));
      return 'failed';
    } finally {
      turn.runScope?.signal.removeEventListener('abort', clearRunTimers);
      this.options.clearTurnReceipts?.(trace);
      clearInterval(typingTimer);
    }
  }
}
