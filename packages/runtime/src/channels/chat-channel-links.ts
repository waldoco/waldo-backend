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
  // Whether this server can link the provider for this owner. Telegram stops being offered when its bot token is removed;
  // iMessage is offered only where the owner has a number to text.
  offered(provider: AppChatProviderV1): Promise<boolean>;
  // Read live: the owner directory for iMessage and WhatsApp, the binding the console reads for Telegram. 'unknown' when the directory cannot say.
  linked(provider: AppChatProviderV1): Promise<LinkState>;
  // A fresh one-time code, or null when it is not offered or the directory gave none.
  issue(provider: AppChatProviderV1): Promise<AppChannelLinkCodeV1 | null>;
}>;

type Context = Readonly<{ env: Env; kv: Kv; doName: string; auth: ConsoleAuth }>;
// Each provider declares what it needs, how its link is read, which code it takes and what the owner sends, so nothing here
// branches on which surface it is.
type Provider = Readonly<{
  // null where this server cannot link it for this owner; otherwise the address the owner texts, where Waldo knows it.
  ready(context: Context): Promise<Readonly<{ address: string | null }> | null>;
  linked(context: Context): Promise<LinkState>;
  code(context: Context): Promise<string | null>;
  text(code: string): string;
}>;

const hinted = async (hint: Promise<string | null> | undefined): Promise<LinkState> => {
  if (!hint) return 'unknown';
  try { return (await hint) === null ? 'not_linked' : 'linked'; } catch { return 'unknown'; }
};
const sendWaldo = (code: string) => `waldo ${code}`;
// The number this owner texts, as the console and the app's own link route read it: with Photon, the owner's assigned pool
// number, which an owner who has not enrolled does not have yet; without it, the one configured address. Loaded lazily: this
// module also runs in plain Node, where the Durable Object classes behind it cannot load.
const iMessageNumber = async ({ env, doName }: Context): Promise<string | null> => {
  try {
    const { iMessageNumberView } = await import('./imessage/enrollment');
    return (await iMessageNumberView(env as never, doName)).number;
  } catch {
    console.error(JSON.stringify({ hop: 'app_onboarding', ok: false, code: 'imessage_number' }));
    return null;
  }
};
const always = { address: null } as const;

const PROVIDERS: Readonly<Record<AppChatProviderV1, Provider>> = {
  imessage: {
    ready: async context => { if (!context.auth.issueProviderLinkCode) return null; const address = await iMessageNumber(context); return address ? { address } : null; },
    linked: ({ auth, doName }) => hinted(auth.iMessageHandleHint?.(doName)),
    code: ({ auth, doName }) => auth.issueProviderLinkCode!(doName, 'imessage'),
    text: sendWaldo,
  },
  whatsapp: {
    ready: async ({ env, auth }) => env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && auth.issueProviderLinkCode ? always : null,
    linked: ({ auth, doName }) => hinted(auth.whatsAppHandleHint?.(doName)),
    code: ({ auth, doName }) => auth.issueProviderLinkCode!(doName, 'whatsapp'),
    text: sendWaldo,
  },
  telegram: {
    ready: async ({ env }) => env.TELEGRAM_BOT_TOKEN ? always : null,
    linked: ({ kv }) => Promise.resolve(telegramLinked(kv) ? 'linked' : 'not_linked'),
    code: ({ auth, doName }) => auth.issueLinkCode(doName),
    text: code => `/link ${code}`,
  },
};

export const chatChannelLinks = (deps: Readonly<{ env: Env; kv: Kv; doName: string; auth: ConsoleAuth | null }>): ChatChannels => {
  const { auth } = deps;
  const context = auth ? { ...deps, auth } : null;
  return {
    offered: async provider => context !== null && await PROVIDERS[provider].ready(context) !== null,
    linked: provider => context ? PROVIDERS[provider].linked(context) : Promise.resolve('unknown'),
    async issue(provider) {
      if (!context) return null;
      const { ready, code, text } = PROVIDERS[provider];
      const where = await ready(context);
      if (!where) return null;
      const issued = await code(context);
      if (!issued) return null;
      return { provider, code: issued, text: text(issued), address: where.address, send_url: where.address ? iMessageSendUrl(where.address, issued) : null, expires_in_seconds: 600 };
    },
  };
};
