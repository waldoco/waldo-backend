export type TelegramWebhookEnv = Readonly<{
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  WALDO_OWNER_TELEGRAM_ID?: string;
  OPENAI_API_KEY?: string;
}>;

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

const sameSecret = (given: string, expected: string): boolean => {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

export const handleTelegramWebhook = async (
  request: Request,
  env: TelegramWebhookEnv,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response> => {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (request.method !== 'POST' || !secret || !env.TELEGRAM_OWNER_DO || !env.WALDO_OWNER_TELEGRAM_ID) {
    return new Response('not found', { status: 404 });
  }
  if (!sameSecret(request.headers.get('x-telegram-bot-api-secret-token') ?? '', secret)) {
    return new Response('forbidden', { status: 403 });
  }
  const body = await request.text();
  const stub = env.TELEGRAM_OWNER_DO.get(env.TELEGRAM_OWNER_DO.idFromName(env.WALDO_OWNER_TELEGRAM_ID));
  waitUntil(stub.fetch('https://telegram-owner/turn', { method: 'POST', body }));
  return new Response('ok');
};
