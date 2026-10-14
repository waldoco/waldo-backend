import type { SendConsoleLinkResult } from '@waldo/contracts';
import { consoleAuth } from '../identity/console-auth';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import type { ConsoleLinkSend, ConsoleLinkTurn } from '../tools/live/console-link';
import { consoleAccess } from './console';
import type { TurnLogEntry } from './owner-turn-types';

export const consoleLinkText = (link: string): string => `Console (link works once, for 10 minutes): ${link}`;

// The one minting rule for console links. A directory-backed deploy signs a ticket naming this owner's object; without
// a directory the grant token itself is the link.
export const mintConsoleLink = async (storage: DurableObjectStorage, env: OwnerDirectoryEnv): Promise<string | null> => {
  const origin = await storage.get<string>('origin'), issuer = storage.kv.get<string>('do_name'), secret = env.WALDO_ROUTER_HMAC_SECRET;
  const configured = consoleAuth(env) !== null;
  return origin && (!configured || issuer && secret) ? consoleAccess(storage).mintLink(origin, configured ? { owner: issuer!, secret: secret! } : undefined) : null;
};

// How a turn's own surface carries the link, or why it cannot. `sent` reads an earlier send this turn already made
// durable, so a retried turn never mints a second link.
export type ConsoleLinkRoute =
  | Readonly<{ surface: 'telegram' | 'imessage'; sent(turn: ConsoleLinkTurn): boolean; deliver(text: string, turn: ConsoleLinkTurn): Promise<boolean> }>
  | Readonly<{ unsupported: 'app_unsupported' | 'surface_unsupported' }>;

export const consoleLinkSender = (deps: Readonly<{
  surface: string;
  route: ConsoleLinkRoute;
  // False while the host cannot hand a send to the owner, as in a capture probe that returns its sends to the caller.
  available(): boolean;
  mint(): Promise<string | null>;
  log(entry: Pick<TurnLogEntry, 'trace' | 'hop' | 'ms' | 'ok' | 'detail'>): void;
}>): ConsoleLinkSend => {
  // The owner holds one console grant, so a second mint voids the first link: a turn mints at most once.
  const minted = new Set<string>();
  return async (turn) => {
    const started = Date.now();
    const done = (result: SendConsoleLinkResult): SendConsoleLinkResult => {
      deps.log({ trace: turn.turnId, hop: 'console_link', ms: Date.now() - started, ok: result.sent, detail: deps.surface });
      return result;
    };
    const { route } = deps;
    if ('unsupported' in route) return done({ sent: false, reason: route.unsupported });
    if (minted.has(turn.turnId) || route.sent(turn)) return done({ sent: false, reason: 'already_sent' });
    if (!deps.available()) return done({ sent: false, reason: 'unavailable' });
    const link = await deps.mint();
    if (!link) return done({ sent: false, reason: 'unavailable' });
    minted.add(turn.turnId);
    let delivered: boolean;
    try { delivered = await route.deliver(consoleLinkText(link), turn); }
    catch (error) { minted.delete(turn.turnId); done({ sent: false, reason: 'send_failed' }); throw error; }
    if (!delivered) minted.delete(turn.turnId);
    return done(delivered ? { sent: true, surface: route.surface } : { sent: false, reason: 'send_failed' });
  };
};

// Every message that carried a console link, by chat and message id. Bounded: the oldest goes first, long after its link
// expired. A reply quotes the message it answers back into the next turn, so a reply to one of these keeps who sent it
// where, and a fixed note in place of its text, before the update is read.
const CREDENTIAL_MESSAGES_KEY = 'credential_messages_v1';
const CREDENTIAL_MESSAGES_MAX = 256;
export const CREDENTIAL_REPLY_TEXT = '[A one-time console sign-in link Waldo sent. The link is not shown.]';
type CredentialKv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
type CredentialMessage = Readonly<{ chat: number; message: number }>;

export const recordCredentialMessage = (kv: CredentialKv, sent: unknown): boolean => {
  const message = sent as { message_id?: unknown; chat?: { id?: unknown } } | null | undefined;
  const chat = message?.chat?.id, id = message?.message_id;
  if (typeof chat !== 'number' || !Number.isSafeInteger(chat) || typeof id !== 'number' || !Number.isSafeInteger(id)) return false;
  const rows = (kv.get<CredentialMessage[]>(CREDENTIAL_MESSAGES_KEY) ?? []).filter((row) => row.chat !== chat || row.message !== id);
  kv.put(CREDENTIAL_MESSAGES_KEY, [...rows, { chat, message: id }].slice(-CREDENTIAL_MESSAGES_MAX));
  return true;
};

export const maskCredentialReply = (update: unknown, kv: CredentialKv): unknown => {
  const message = (update as { message?: Record<string, unknown> } | null | undefined)?.message;
  const reply = message?.reply_to_message as { message_id?: unknown; from?: unknown; chat?: { id?: unknown }; date?: unknown } | null | undefined;
  if (!message || !reply || typeof reply !== 'object') return update;
  const chat = reply.chat?.id ?? (message.chat as { id?: unknown } | undefined)?.id;
  if (!(kv.get<CredentialMessage[]>(CREDENTIAL_MESSAGES_KEY) ?? []).some((row) => row.chat === chat && row.message === reply.message_id)) return update;
  const { quote: _quote, ...kept } = message;
  return { ...(update as object), message: { ...kept, reply_to_message: {
    message_id: reply.message_id, ...(reply.from === undefined ? {} : { from: reply.from }), ...(reply.chat === undefined ? {} : { chat: reply.chat }),
    ...(reply.date === undefined ? {} : { date: reply.date }), text: CREDENTIAL_REPLY_TEXT,
  } } };
};

// A Telegram send records the message it became, so a later reply to it never quotes the link back.
export const telegramConsoleRoute = (send: (body: Readonly<{ text: string; link_preview_options: Readonly<{ is_disabled: true }> }>) => Promise<unknown>, kv: CredentialKv): ConsoleLinkRoute => ({
  surface: 'telegram',
  sent: () => false,
  async deliver(text) {
    const message = await send({ text, link_preview_options: { is_disabled: true } });
    if (message === undefined) return false;
    recordCredentialMessage(kv, message);
    return true;
  },
});
