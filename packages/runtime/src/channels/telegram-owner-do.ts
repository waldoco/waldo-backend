import { DurableObject } from 'cloudflare:workers';
import { createTelegramCaller, createTelegramOwnerApi } from './telegram-api';
import { TelegramOwnerListener } from './telegram-listener';
import { TelegramPollingAdapter } from './telegram-polling';
import { createTelegramResponder } from './telegram-turn';
import type { TelegramWebhookEnv } from './telegram-webhook';

export class TelegramOwnerDO extends DurableObject<TelegramWebhookEnv> {
  private listener?: TelegramOwnerListener;
  private queue: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const update = JSON.parse(await request.text()) as unknown;
    const run = this.queue.then(() => this.turn(update));
    this.queue = run.catch(() => undefined);
    await run;
    return new Response('ok');
  }

  private async turn(update: unknown): Promise<void> {
    const { TELEGRAM_BOT_TOKEN: token, OPENAI_API_KEY: key, WALDO_OWNER_TELEGRAM_ID: owner } = this.env;
    if (!token || !key || !owner) throw new Error('telegram owner runtime is unconfigured');
    this.listener ??= new TelegramOwnerListener({
      ownerTelegramId: Number(owner),
      api: createTelegramOwnerApi(createTelegramCaller(token)),
      ...createTelegramResponder(key),
      log: (entry) => console.log(JSON.stringify(entry)),
      saveOffset: (offset) => this.ctx.storage.put('offset', offset),
    });
    const offset = (await this.ctx.storage.get<number>('offset')) ?? 0;
    await this.listener.pollOnce(new TelegramPollingAdapter({ getUpdates: async () => [update] }, offset), 0);
  }
}
