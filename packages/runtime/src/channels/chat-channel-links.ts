import type { AppChannelLinkCodeV1, AppChatProviderV1 } from '../../../contracts/src/app/onboarding';
import type { ConsoleAuth } from '../identity/console-auth';
import { telegramLinked } from './console';
import { iMessageSendUrl } from './imessage/send-url';

type Env = Readonly<{ IMESSAGE_WALDO_ADDRESS?: string; WHATSAPP_ACCESS_TOKEN?: string; WHATSAPP_PHONE_NUMBER_ID?: string; TELEGRAM_BOT_TOKEN?: string }>;
type Kv = Readonly<{ get<T>(key: string): T | undefined }>;
type LinkState = 'linked' | 'not_linked' | 'unknown';

// What the first run needs to let an owner link iMessage, WhatsApp or Telegram the same way. A code is issued only here, in
// the app route and in the console: the owner's own signed-in act, never a model tool, so a turn that read untrusted text has
// no way to link a channel.
export type ChatChannels = Readonly<{
  // Whether this server can link the provider. Telegram stops being offered when its bot token is removed.
  offered(provider: AppChatProviderV1): boolean;
  // Read live: the owner directory for iMessage and WhatsApp, the binding the console reads for Telegram. 'unknown' when the directory cannot say.
  linked(provider: AppChatProviderV1): Promise<LinkState>;
  // A fresh one-time code, or null when it is not offered or the directory gave none.
  issue(provider: AppChatProviderV1): Promise<AppChannelLinkCodeV1 | null>;
}>;

type Context = Readonly<{ env: Env; kv: Kv; doName: string; auth: ConsoleAuth }>;
// Each provider declares what it needs, how its link is read, which code it takes and what the owner sends, so nothing here
// branches on which surface it is.
type Provider = Readonly<{
  offered(context: Context): boolean;
  linked(context: Context): Promise<LinkState>;
  code(context: Context): Promise<string | null>;
  text(code: string): string;
  address(env: Env): string | null;
}>;

const hinted = async (hint: Promise<string | null> | undefined): Promise<LinkState> => {
  if (!hint) return 'unknown';
  try { return (await hint) === null ? 'not_linked' : 'linked'; } catch { return 'unknown'; }
};
const sendWaldo = (code: string) => `waldo ${code}`;

const PROVIDERS: Readonly<Record<AppChatProviderV1, Provider>> = {
  imessage: {
    offered: ({ env, auth }) => !!env.IMESSAGE_WALDO_ADDRESS && !!auth.issueProviderLinkCode,
    linked: ({ auth, doName }) => hinted(auth.iMessageHandleHint?.(doName)),
    code: ({ auth, doName }) => auth.issueProviderLinkCode!(doName, 'imessage'),
    text: sendWaldo,
    address: env => env.IMESSAGE_WALDO_ADDRESS ?? null,
  },
  whatsapp: {
    offered: ({ env, auth }) => !!env.WHATSAPP_ACCESS_TOKEN && !!env.WHATSAPP_PHONE_NUMBER_ID && !!auth.issueProviderLinkCode,
    linked: ({ auth, doName }) => hinted(auth.whatsAppHandleHint?.(doName)),
    code: ({ auth, doName }) => auth.issueProviderLinkCode!(doName, 'whatsapp'),
    text: sendWaldo,
    address: () => null,
  },
  telegram: {
    offered: ({ env }) => !!env.TELEGRAM_BOT_TOKEN,
    linked: ({ kv }) => Promise.resolve(telegramLinked(kv) ? 'linked' : 'not_linked'),
    code: ({ auth, doName }) => auth.issueLinkCode(doName),
    text: code => `/link ${code}`,
    address: () => null,
  },
};

export const chatChannelLinks = (deps: Readonly<{ env: Env; kv: Kv; doName: string; auth: ConsoleAuth | null }>): ChatChannels => {
  const { auth } = deps;
  const context = auth ? { ...deps, auth } : null;
  const offered = (provider: AppChatProviderV1) => context !== null && PROVIDERS[provider].offered(context);
  return {
    offered,
    linked: provider => context ? PROVIDERS[provider].linked(context) : Promise.resolve('unknown'),
    async issue(provider) {
      if (!context || !offered(provider)) return null;
      const { code, text, address } = PROVIDERS[provider];
      const issued = await code(context);
      if (!issued) return null;
      const where = address(context.env);
      return { provider, code: issued, text: text(issued), address: where, send_url: where ? iMessageSendUrl(where, issued) : null, expires_in_seconds: 600 };
    },
  };
};
