import { createOwnerResponder, ownerToolApproval, type OwnerContextIntegration, type OwnerSkillHost } from './owner-turn';
import { ownerTurnTrace, type OwnerTurnEnvelope, type ReminderTiming } from './owner-turn-envelope';
import type { TelegramInboundTurn } from './telegram-polling';
import { loadTelegramMedia, type MediaReaders } from './telegram-media';
import type { TelegramOwnerListenerOptions, TurnTimer } from './telegram-listener';
import { TELEGRAM_REACTIONS } from './reactions';
import { surfaceChatRef } from '../context-composer/owner-turn';

// Compatibility exports keep the durable object and existing callers stable.
// Only this adapter knows Telegram's numeric update/chat IDs and media formats.
export const telegramOwnerApproval = ownerToolApproval;
// Telegram's own inbox claims a message sent mid-turn as a steer of the running turn and reacts on its own.
export const telegramTurnEnvelope = (turn: TelegramInboundTurn, surface = 'telegram'): OwnerTurnEnvelope => {
  const telegram = surface === 'telegram';
  return {
    traceId: ownerTurnTrace(surface, turn.updateId),
    conversationRef: surfaceChatRef(surface, turn.chatId),
    surface,
    presentation: { surface, delivery: { text: true, approval: telegram || surface === 'app' ? 'native_buttons' : surface === 'whatsapp' ? 'text_callback' : 'none', reactions: telegram, attachments: turn.canAttach === true && turn.runScope !== undefined, ...(telegram ? { steer: true } : {}) } },
    text: turn.text,
    parts: turn.parts,
    ...(turn.runScope ? { runScope: turn.runScope } : {}),
    ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
    ...(turn.replyStream ? { replyStream: turn.replyStream } : {}),
  };
};
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
    const members = [...(turn.earlier ?? []), turn];
    const media = members.some(one => one.media)
      ? await time('media', () => Promise.all(members.map(one => one.media ? loadTelegramMedia(one.media, readers ?? {}) : undefined)))
      : [];
    turn.runScope?.admit();
    const parts = members.flatMap((one, index) => [...one.parts, ...(media[index]?.parts ?? [])]);
    const files = media.flatMap(loaded => loaded?.attachment ? [loaded.attachment] : []);
    const attachments = [...(turn.attachments ?? []), ...files];
    return core.respond({ ...envelope(turn), parts,
      ...(attachments.length === 1 && !turn.attachments?.length ? { attachment: attachments[0]! } : attachments.length ? { attachments } : {}) }, time);
  };
  return {
    ...core, respond,
    chooseReaction: (turn: TelegramInboundTurn) => core.chooseReaction(envelope(turn)),
    remind: (id: string, chatId: number, note: string, time: TurnTimer, timing?: ReminderTiming) => core.remind(id, surfaceChatRef(surface, chatId), note, time, surface, timing),
    prompt: (id: string, chatId: number, said: string, time: TurnTimer, toolNames?: Parameters<typeof core.prompt>[5], current?: Parameters<typeof core.prompt>[6], decision?: Parameters<typeof core.prompt>[7], turnContext?: string, sourceTaint?: Parameters<typeof core.prompt>[9], ownerModel?: boolean, attachments?: Parameters<typeof core.prompt>[11], directTools?: Parameters<typeof core.prompt>[12]) => core.prompt(id, surfaceChatRef(surface, chatId), said, time, surface, toolNames, current, decision, turnContext, sourceTaint, ownerModel, attachments, directTools),
  };
};
