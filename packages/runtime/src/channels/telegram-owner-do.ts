import { DurableObject } from 'cloudflare:workers';
import { coreFileStore } from '../memory/core-files';
import { langfuseOtlpConfig, otlpTurnExporter } from '../observability/otlp-turns';
import { durableConversationStore } from './conversation-store';
import { createTelegramCaller, createTelegramOwnerApi } from './telegram-api';
import { createTelegramFileDownloader } from './telegram-media';
import { selectTranscriber } from '../llm/transcriber';
import { TelegramOwnerListener, type TurnLogEntry } from './telegram-listener';
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
    const otlp = langfuseOtlpConfig(this.env);
    const exportTurn = otlp ? otlpTurnExporter(otlp, {
      environment: this.env.WALDO_ENVIRONMENT ?? 'development', release: this.env.WALDO_RELEASE ?? 'unknown',
      channel: 'telegram', userId: `telegram:${owner}`, sessionId: `telegram-dm:${owner}`,
      captureText: this.env.LANGFUSE_CAPTURE_TEXT === 'true',
    }) : undefined;
    const log = (entry: TurnLogEntry) => {
      console.log(JSON.stringify({ ...entry, text: undefined }));
      if (exportTurn) this.ctx.waitUntil(exportTurn(entry).catch((error: unknown) => console.log(JSON.stringify({ trace: entry.trace, hop: 'otlp_export', ok: false, error: String(error) }))));
    };
    this.listener ??= new TelegramOwnerListener({
      ownerTelegramId: Number(owner),
      api: createTelegramOwnerApi(createTelegramCaller(token)),
      ...createTelegramResponder(key, durableConversationStore(this.ctx.storage), coreFileStore(this.ctx.storage.sql), log, { download: createTelegramFileDownloader(token), transcribe: selectTranscriber(this.env)?.transcribe }),
      log,
      saveOffset: (offset) => this.ctx.storage.put('offset', offset),
    });
    const offset = (await this.ctx.storage.get<number>('offset')) ?? 0;
    await this.listener.pollOnce(new TelegramPollingAdapter({ getUpdates: async () => [update] }, offset), 0);
  }
}
