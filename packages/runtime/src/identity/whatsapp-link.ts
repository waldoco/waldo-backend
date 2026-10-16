import { hex, signedRpc, type OwnerDirectoryEnv } from './owner-directory';

// Text-first WhatsApp linking. An unlinked sender texts the Waldo number and gets a one-tap link to
// /console/whatsapp/link/<token>. The token is 32 random bytes; only its sha256 reaches the database, where the
// request is bound to that sender and to the one owner with that number on file, lives 10 minutes and is
// single-use. Binding needs that owner's signed-in console session and an explicit confirm of the full number.
export const WHATSAPP_LINK_PATH = '/console/whatsapp/link';
export const WHATSAPP_LINK_TARGET = /^\/console\/whatsapp\/link\/([A-Za-z0-9_-]{43})$/;

export const newWhatsAppLinkToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const whatsappLinkTokenHash = async (token: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
/** The token in an exact link path, else null: a sign-in continuation is this locator and nothing broader. */
export const whatsappLinkToken = (path: string): string | null => WHATSAPP_LINK_TARGET.exec(path)?.[1] ?? null;
export const whatsappLinkUrl = (origin: string, token: string): string => `${origin}${WHATSAPP_LINK_PATH}/${token}`;

export type WhatsAppLinkOpen = 'opened' | 'linked' | 'waitlist';
export type WhatsAppLinkConsume = 'linked' | 'rejected' | 'claimed';
export type WhatsAppLinkDirectory = Readonly<{
  open(subject: string, tokenHash: string): Promise<WhatsAppLinkOpen>;
  subject(doName: string, tokenHash: string): Promise<string | null>;
  consume(doName: string, tokenHash: string, subject: string): Promise<WhatsAppLinkConsume>;
}>;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error('whatsapp link directory answered unexpectedly');
  return value as T;
};

// Null without a Supabase directory: text-first linking has no single-owner fallback, like WhatsApp routing.
export const whatsappLinkDirectory = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): WhatsAppLinkDirectory | null => {
  const rpc = signedRpc(env, fetcher, now);
  if (!rpc) return null;
  return {
    open: async (subject, tokenHash) => oneOf(await rpc('open_presence_link_request', `linkreq.open.whatsapp.${subject}.${tokenHash}`,
      { p_provider: 'whatsapp', p_subject: subject, p_token_hash: tokenHash }), ['opened', 'linked', 'waitlist'] as const),
    subject: async (doName, tokenHash) => {
      const subject = await rpc('presence_link_request_subject', `linkreq.view.${doName}.${tokenHash}`, { p_do_name: doName, p_token_hash: tokenHash });
      if (subject === null) return null;
      if (typeof subject !== 'string' || !/^[1-9]\d{5,14}$/.test(subject)) throw new Error('whatsapp link directory answered unexpectedly');
      return subject;
    },
    consume: async (doName, tokenHash, subject) => oneOf(await rpc('consume_presence_link_request', `linkreq.consume.${doName}.${tokenHash}.${subject}`,
      { p_do_name: doName, p_token_hash: tokenHash, p_subject: subject }), ['linked', 'rejected', 'claimed'] as const),
  };
};
