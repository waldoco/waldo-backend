import { describe, expect, it, vi } from 'vitest';
import { chatChannelLinks } from '../src/channels/chat-channel-links';

type Kv = Readonly<{ get<T>(key: string): T | undefined }>;
const kv = (values: Record<string, unknown> = {}): Kv => ({ get: <T>(key: string) => values[key] as T | undefined });
const ALL_ENV = { IMESSAGE_WALDO_ADDRESS: '+15550100', WHATSAPP_ACCESS_TOKEN: 'synthetic-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', TELEGRAM_BOT_TOKEN: '123456:synthetic' };
const CODE = 'ABCDEFGHJK';
const auth = (over: Record<string, unknown> = {}) => ({
  issueLinkCode: vi.fn(async () => CODE), issueProviderLinkCode: vi.fn(async () => CODE),
  iMessageHandleHint: vi.fn(async () => null), whatsAppHandleHint: vi.fn(async () => null), ...over,
}) as never;
const links = (over: { env?: Record<string, string>; kv?: Kv; auth?: ReturnType<typeof auth> | null } = {}) =>
  chatChannelLinks({ env: over.env ?? ALL_ENV, kv: over.kv ?? kv(), doName: 'owner-name', auth: over.auth === undefined ? auth() : over.auth });

describe('chat channel links', () => {
  it('offers a provider only where this server can link it, and offers none without the owner directory', async () => {
    const offered = (over: Parameters<typeof links>[0] = {}) => Promise.all(['imessage', 'whatsapp', 'telegram'].map(p => links(over).offered(p as never)));
    expect(await offered()).toEqual([true, true, true]);
    expect(await offered({ env: {} })).toEqual([false, false, false]);
    expect(await offered({ auth: null })).toEqual([false, false, false]);
    const { IMESSAGE_WALDO_ADDRESS: _drop, ...noImessage } = ALL_ENV;
    expect(await offered({ env: noImessage })).toEqual([false, true, true]);
    const { TELEGRAM_BOT_TOKEN: _retired, ...noTelegram } = ALL_ENV;
    expect(await links({ env: noTelegram }).offered('telegram')).toBe(false);
    expect(await links({ env: { ...ALL_ENV, WHATSAPP_PHONE_NUMBER_ID: '' } }).offered('whatsapp')).toBe(false);
  });

  it('reads iMessage and WhatsApp from the owner directory, and Telegram from the binding the console reads', async () => {
    expect(await links().linked('imessage')).toBe('not_linked');
    expect(await links({ auth: auth({ iMessageHandleHint: async () => '42' }) }).linked('imessage')).toBe('linked');
    expect(await links({ auth: auth({ whatsAppHandleHint: async () => '4242' }) }).linked('whatsapp')).toBe('linked');
    expect(await links().linked('telegram')).toBe('not_linked');
    expect(await links({ kv: kv({ telegram_subject: '555' }) }).linked('telegram')).toBe('linked');
    expect(await links({ kv: kv({ telegram_subject: '555', telegram_unlinked: true }) }).linked('telegram')).toBe('not_linked');
  });

  it('says unknown, never linked, when the directory cannot be read', async () => {
    expect(await links({ auth: auth({ iMessageHandleHint: async () => { throw new Error('directory down'); } }) }).linked('imessage')).toBe('unknown');
    expect(await links({ auth: auth({ whatsAppHandleHint: undefined }) }).linked('whatsapp')).toBe('unknown');
    expect(await links({ auth: null }).linked('whatsapp')).toBe('unknown');
  });

  it('issues the code and the text to send for each provider', async () => {
    expect(await links().issue('imessage')).toEqual({ provider: 'imessage', code: CODE, text: `waldo ${CODE}`, address: '+15550100', send_url: `sms:+15550100&body=waldo%20${CODE}`, expires_in_seconds: 600 });
    expect(await links().issue('whatsapp')).toEqual({ provider: 'whatsapp', code: CODE, text: `waldo ${CODE}`, address: null, send_url: null, expires_in_seconds: 600 });
    expect(await links().issue('telegram')).toEqual({ provider: 'telegram', code: CODE, text: `/link ${CODE}`, address: null, send_url: null, expires_in_seconds: 600 });
  });

  it('asks the directory for a code of the provider asked for, bound to this owner', async () => {
    const directory = auth();
    await links({ auth: directory }).issue('whatsapp');
    await links({ auth: directory }).issue('telegram');
    expect((directory as unknown as { issueProviderLinkCode: ReturnType<typeof vi.fn> }).issueProviderLinkCode.mock.calls).toEqual([['owner-name', 'whatsapp']]);
    expect((directory as unknown as { issueLinkCode: ReturnType<typeof vi.fn> }).issueLinkCode.mock.calls).toEqual([['owner-name']]);
  });

  it('issues nothing for a provider that is not offered, and nothing when the directory refuses', async () => {
    const directory = auth();
    expect(await links({ env: {}, auth: directory }).issue('whatsapp')).toBeNull();
    expect((directory as unknown as { issueProviderLinkCode: ReturnType<typeof vi.fn> }).issueProviderLinkCode).not.toHaveBeenCalled();
    expect(await links({ auth: auth({ issueProviderLinkCode: async () => null }) }).issue('imessage')).toBeNull();
    expect(await links({ auth: auth({ issueLinkCode: async () => null }) }).issue('telegram')).toBeNull();
  });
});

// A turn that read untrusted text must not create a channel link without the owner's approval. The structural answer is that no
// model tool can issue a link code: only the owner's own sign-in, console and app routes do. A new caller has to be named here,
// which is the prompt to check it is an owner act or goes through an approval card.
describe('who can issue a channel link code', () => {
  const OWNER_ACT_FILES = [
    'channels/app-api.ts', 'channels/chat-channel-links.ts', 'channels/imessage/console.ts', 'channels/owner-do.ts', 'identity/console-auth.ts',
  ];
  // Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directive.
  // @ts-expect-error vite-only API
  const sources: Record<string, string> = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
  it('is limited to the owner-act files, and never a tool, hook or turn module', () => {
    const callers = Object.entries(sources).filter(([, text]) => /\bissue(Provider)?LinkCode\b/.test(text)).map(([path]) => path.replace('../src/', '')).sort();
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(callers).toEqual(OWNER_ACT_FILES);
  });
});
