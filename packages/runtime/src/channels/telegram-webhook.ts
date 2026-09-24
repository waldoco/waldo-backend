import { ownerDirectory, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { createTelegramCaller } from './telegram-api';

export type TelegramWebhookEnv = Readonly<{
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  WALDO_OWNER_TELEGRAM_ID?: string;
  WALDO_OWNER_TIMEZONE?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_CAPTURE_TEXT?: string;
  WALDO_ENVIRONMENT?: string;
  WALDO_RELEASE?: string;
  OPENAI_API_KEY?: string;
  SMALLEST_AI_API_KEY?: string;
  BRAVE_SEARCH_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  WALDO_STT_PROVIDER?: string;
  WALDO_TOOL_OFFLOAD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}> & OwnerDirectoryEnv;

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

const sameSecret = (given: string, expected: string): boolean => {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

type SenderUpdate = {
  message?: { from?: { id?: number }; chat?: { id?: number; type?: string }; text?: string };
  callback_query?: { from?: { id?: number } };
};

const sender = (update: SenderUpdate): string | null => {
  const id = update.message?.from?.id ?? update.callback_query?.from?.id;
  return id === undefined ? null : String(id);
};

const linkCode = (update: SenderUpdate): string | null => {
  if (update.message?.chat?.type !== 'private') return null;
  const [command, code] = (update.message.text ?? '').trim().split(/\s+/, 2);
  return (command === '/start' || command === '/link') && code ? code : null;
};

// The webhook resolves which owner a Telegram sender belongs to and wakes only that owner's Durable Object.
// A sender with no owner can only redeem a one-time link code issued from the console.
export const handleTelegramWebhook = async (
  request: Request,
  env: TelegramWebhookEnv,
  waitUntil: (work: Promise<unknown>) => void,
  directory: OwnerDirectory = ownerDirectory(env),
): Promise<Response> => {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (request.method !== 'POST' || !secret || !env.TELEGRAM_OWNER_DO) {
    return new Response('not found', { status: 404 });
  }
  if (!sameSecret(request.headers.get('x-telegram-bot-api-secret-token') ?? '', secret)) {
    return new Response('forbidden', { status: 403 });
  }
  const body = await request.text();
  const update = JSON.parse(body) as SenderUpdate;
  const subject = sender(update);
  if (!subject) return new Response('ok');
  const owners = env.TELEGRAM_OWNER_DO;
  const origin = new URL(request.url).origin;
  waitUntil((async () => {
    const route = await directory.byPresence('telegram', subject);
    if (route) {
      const headers: Record<string, string> = { 'x-waldo-origin': origin, 'x-waldo-telegram-subject': route.subject };
      if (route.timezone) headers['x-waldo-timezone'] = route.timezone;
      return owners.get(owners.idFromName(route.doName)).fetch('https://telegram-owner/turn', { method: 'POST', body, headers });
    }
    const code = linkCode(update);
    if (!code || !env.TELEGRAM_BOT_TOKEN) return undefined;
    const linked = await directory.redeem('telegram', subject, code).catch(() => null);
    return createTelegramCaller(env.TELEGRAM_BOT_TOKEN)('sendMessage', {
      chat_id: Number(subject),
      text: linked ? 'Linked. This chat now talks to your Waldo.' : 'That code did not work. Get a new one from your console.',
    });
  })().catch((error: unknown) => console.log(JSON.stringify({ hop: 'telegram_route', ok: false, error: String(error) }))));
  return new Response('ok');
};
