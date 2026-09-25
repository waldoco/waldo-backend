import type { ModelUsage } from '../llm/pricing';
import { telegramReaction } from './reactions';
import type { TelegramInboundTurn, TelegramPollingAdapter, TelegramUnsupportedTurn } from './telegram-polling';


export const TURN_TIMEOUT_MS = 150_000;
// Reactions are best-effort UX; one hung call must never gate the turn that follows it.
export const REACTION_TIMEOUT_MS = 5_000;

class TurnTimeout extends Error {
  constructor(ms: number) { super(`turn timed out after ${ms} ms`); }
}

export type TelegramOwnerApi = Readonly<{
  setMessageReaction(request: Readonly<{ chat_id: number; message_id: number; reaction: readonly Readonly<{ type: 'emoji'; emoji: string }>[] }>): Promise<unknown>;
  sendChatAction(request: Readonly<{ chat_id: number; action: 'typing' }>): Promise<unknown>;
  sendMessage(request: Readonly<{ chat_id: number; text: string }>): Promise<unknown>;
}>;

export type TurnLogEntry = Readonly<{ trace: string; hop: string; ms: number; ok: boolean; error?: string; detail?: string; usage?: ModelUsage; shape?: Readonly<{ system_bytes: number; request_bytes: number }>; text?: TurnText }>;
export type TurnText = Readonly<{ input: string; output?: string; reasoning?: string }>;
export type TurnTimer = <T>(hop: string, work: () => Promise<T>) => Promise<T>;

export type TelegramOwnerListenerOptions = Readonly<{
  ownerTelegramId: number;
  api: TelegramOwnerApi;
  respond(turn: TelegramInboundTurn, time: TurnTimer): Promise<string>;
  turnTimeoutMs?: number;
  reactionTimeoutMs?: number;
  chooseReaction?(turn: TelegramInboundTurn): Promise<string | null>;
  saveOffset(offset: number): Promise<void>;
  log?(entry: TurnLogEntry): void;
  now?(): number;
  progressAfterMs?: number;
  typingEveryMs?: number;
  ackEmoji?: string;
  doneEmoji?: string;
  failedEmoji?: string;
  progressText?: string;
  failureText?: string;
  unsupportedText?: string;
}>;

export type TelegramTurnOutcome = 'answered' | 'failed' | 'ignored' | 'unsupported';

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
    await api.sendMessage({ chat_id, text: this.options.unsupportedText ?? 'I can read text, photos, documents and voice notes here. Videos, stickers, forwards and some formatting do not come through yet.' }).catch(() => undefined);
    if (turn.messageId !== null) {
      await api.setMessageReaction({ chat_id, message_id: turn.messageId, reaction: [{ type: 'emoji', emoji: '🤷' }] }).catch(() => undefined);
    }
    return 'unsupported';
  }

  async handle(turn: TelegramInboundTurn): Promise<TelegramTurnOutcome> {
    const owner = this.options.ownerTelegramId;
    if (turn.senderId !== owner || turn.chatId !== owner) return 'ignored';
    const { api } = this.options;
    const now = this.options.now ?? Date.now;
    const trace = `tg-${turn.updateId}`;
    const log = (hop: string, ms: number, ok: boolean, error?: string) =>
      this.options.log?.(error === undefined ? { trace, hop, ms, ok } : { trace, hop, ms, ok, error });
    const time: TurnTimer = async (hop, work) => {
      const start = now();
      try {
        const value = await work();
        log(hop, now() - start, true);
        return value;
      } catch (error) {
        log(hop, now() - start, false, error instanceof Error ? error.message : String(error));
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(() => { log(hop, limit, false, 'telegram reaction timed out'); resolve(undefined); }, limit);
      });
      const attempt = time(hop, () => api.setMessageReaction({ chat_id, message_id, reaction: [{ type: 'emoji', emoji }] })).then(() => undefined, () => undefined);
      return Promise.race([attempt, bounded]).finally(() => clearTimeout(timer));
    };
    await react('receipt', ack);
    const choice = message_id === null || !this.options.chooseReaction
      ? Promise.resolve(null)
      : time('choose_reaction', () => this.options.chooseReaction!(turn)).catch(() => null);
    const typing = () => api.sendChatAction({ chat_id, action: 'typing' }).catch(() => undefined);
    await time('typing', typing);
    const typingTimer = setInterval(typing, this.options.typingEveryMs ?? 4_000);
    const progressTimer = setTimeout(() => {
      void time('progress', () => api.sendMessage({ chat_id, text: this.options.progressText ?? 'On it - still working on this, reply coming shortly.' })).catch(() => undefined);
    }, this.options.progressAfterMs ?? 8_000);
    try {
      const limit = this.options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TurnTimeout(limit)), limit); });
      const text = (await time('respond', () => Promise.race([this.options.respond(turn, time), timeout]).finally(() => clearTimeout(timer)))).trim();
      if (text.length === 0) throw new Error('empty reply');
      clearTimeout(progressTimer);
      await time('send', () => api.sendMessage({ chat_id, text }));
      const chosen = telegramReaction(await choice);
      await react('resolved', chosen !== null && chosen !== ack ? chosen : this.options.doneEmoji ?? '👌');
      this.options.log?.({ trace, hop: 'turn', ms: now() - started, ok: true, text: { input: turn.text, output: text } });
      return 'answered';
    } catch (error) {
      clearTimeout(progressTimer);
      const failure = error instanceof TurnTimeout
        ? 'That took too long, so I stopped working on it. Try again, or split it into smaller asks.'
        : this.options.failureText ?? 'Sorry - I hit a problem answering that. Please try again in a moment.';
      await api.sendMessage({ chat_id, text: failure }).catch(() => undefined);
      await react('failed', this.options.failedEmoji ?? '😢');
      log('turn', now() - started, false, error instanceof Error ? error.message : String(error));
      return 'failed';
    } finally {
      clearInterval(typingTimer);
    }
  }
}
