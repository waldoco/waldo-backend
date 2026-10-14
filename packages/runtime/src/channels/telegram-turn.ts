import { createOwnerResponder, ownerToolApproval, type OwnerContextIntegration, type OwnerSkillHost } from './owner-turn';
import { ownerTurnTrace, type OwnerTurnEnvelope } from './owner-turn-envelope';
import type { TelegramInboundTurn } from './telegram-polling';
import { loadTelegramMedia, type MediaReaders } from './telegram-media';
import type { TelegramOwnerListenerOptions, TurnTimer } from './telegram-listener';
import { TELEGRAM_REACTIONS } from './reactions';
import { surfaceChatRef } from '../context-composer/owner-turn';

// Compatibility exports keep the durable object and existing callers stable.
// Only this adapter knows Telegram's numeric update/chat IDs and media formats.
export const telegramOwnerApproval = ownerToolApproval;
export const telegramTurnEnvelope = (turn: TelegramInboundTurn, surface = 'telegram'): OwnerTurnEnvelope => ({
  traceId: ownerTurnTrace(surface, turn.updateId),
  conversationRef: surfaceChatRef(surface, turn.chatId),
  surface,
  presentation: { surface, delivery: { text: true, approval: surface === 'telegram' || surface === 'app' ? 'native_buttons' : surface === 'whatsapp' ? 'text_callback' : 'none', reactions: surface === 'telegram', attachments: false }, commands: surface === 'telegram' ? ['/stop','/ledger'] : [] },
  text: turn.text,
  parts: turn.parts,
  ...(turn.runScope ? { runScope: turn.runScope } : {}),
  ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
});
type CoreArgs = Parameters<typeof createOwnerResponder>;
type AdapterArgs = [key: CoreArgs[0], store?: CoreArgs[1], memory?: CoreArgs[2], log?: CoreArgs[3], readers?: MediaReaders, ...rest: CoreArgs extends [unknown, unknown?, unknown?, unknown?, ...infer Rest] ? Rest extends [...infer Public, unknown?, unknown?, unknown?] ? Public : never : never];
export const createTelegramResponder = (...args: [...AdapterArgs, surface?: string, privateSkillHost?: OwnerSkillHost, contextIntegration?: OwnerContextIntegration]) => {
  const surface = args[20] ?? 'telegram';
  const readers = args[4];
  const coreArgs: CoreArgs = [args[0], args[1], args[2], args[3], args[5], args[6], args[7], args[8], args[9], args[10], args[11], args[12], args[13], args[14], args[15], args[16], args[17], args[18], args[19]];
  coreArgs[18] = coreArgs[18] ?? TELEGRAM_REACTIONS;
  coreArgs[21] = args[21] || args[22] ? { ...(args[21] ? { skillHost: args[21] } : {}), ...args[22] } : undefined;
  const core = createOwnerResponder(...coreArgs);
  const envelope = (turn: TelegramInboundTurn) => telegramTurnEnvelope(turn, surface);
  const respond: TelegramOwnerListenerOptions['respond'] = async (turn, time) => {
    turn.runScope?.admit();
    const media = turn.media ? await time('media', () => loadTelegramMedia(turn.media!, readers ?? {})) : undefined;
    turn.runScope?.admit();
    return core.respond({ ...envelope(turn), parts: [...turn.parts, ...(media?.parts ?? [])], ...(media?.attachment ? { attachment: media.attachment } : {}) }, time);
  };
  return {
    ...core, respond,
    chooseReaction: (turn: TelegramInboundTurn) => core.chooseReaction(envelope(turn)),
    remind: (id: string, chatId: number, note: string, time: TurnTimer) => core.remind(id, surfaceChatRef(surface, chatId), note, time, surface),
    prompt: (id: string, chatId: number, said: string, time: TurnTimer, toolNames?: Parameters<typeof core.prompt>[5], current?: Parameters<typeof core.prompt>[6], decision?: Parameters<typeof core.prompt>[7], turnContext?: string, sourceTaint?: Parameters<typeof core.prompt>[9]) => core.prompt(id, surfaceChatRef(surface, chatId), said, time, surface, toolNames, current, decision, turnContext, sourceTaint),
  };
};
