import { DurableObject } from 'cloudflare:workers';
import type { ScheduleEntry } from '@waldo/contracts';
import { ensureSchema } from '../tracer/schema';
import { coreFileStore } from '../memory/core-files';
import { langfuseOtlpConfig, otlpTurnExporter } from '../observability/otlp-turns';
import { Scheduler } from '../scheduler/multiplexer';
import { productionDeps } from '../seams/deps';
import { durableConversationStore } from './conversation-store';
import { reminderBook, reminderHandlers } from './reminders';
import { createTelegramCaller, createTelegramOwnerApi } from './telegram-api';
import { createTelegramFileDownloader } from './telegram-media';
import { selectTranscriber } from '../llm/transcriber';
import { TelegramOwnerListener, type TurnLogEntry, type TurnTimer } from './telegram-listener';
import { TelegramPollingAdapter } from './telegram-polling';
import { createTelegramResponder } from './telegram-turn';
import type { TelegramWebhookEnv } from './telegram-webhook';

type OwnerRuntime = Readonly<{
  owner: number;
  listener: TelegramOwnerListener;
  scheduler: Scheduler;
  fire(entry: ScheduleEntry): Promise<void>;
}>;

export class TelegramOwnerDO extends DurableObject<TelegramWebhookEnv> {
  private runtime?: OwnerRuntime;
  private queue: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const update = JSON.parse(await request.text()) as unknown;
    await this.serial(() => this.turn(update));
    return new Response('ok');
  }

  override async alarm(): Promise<void> {
    await this.serial(async () => {
      const { scheduler, fire } = this.setup();
      await scheduler.dispatchDue({ reminder: fire });
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async turn(update: unknown): Promise<void> {
    const { listener } = this.setup();
    const offset = (await this.ctx.storage.get<number>('offset')) ?? 0;
    await listener.pollOnce(new TelegramPollingAdapter({ getUpdates: async () => [update] }, offset), 0);
  }

  private setup(): OwnerRuntime {
    if (this.runtime) return this.runtime;
    const { TELEGRAM_BOT_TOKEN: token, OPENAI_API_KEY: key, WALDO_OWNER_TELEGRAM_ID: ownerId } = this.env;
    if (!token || !key || !ownerId) throw new Error('telegram owner runtime is unconfigured');
    const owner = Number(ownerId);
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
    const deps = productionDeps();
    ensureSchema(this.ctx.storage);
    const scheduler = new Scheduler(this.ctx.storage.sql, this.ctx.storage, deps);
    const clock = { timezone: this.env.WALDO_OWNER_TIMEZONE ?? 'UTC', now: () => new Date() };
    const book = reminderBook(this.ctx.storage.sql, scheduler, clock, () => deps.newRunId().slice(0, 8));
    const api = createTelegramOwnerApi(createTelegramCaller(token));
    const responder = createTelegramResponder(
      key, durableConversationStore(this.ctx.storage), coreFileStore(this.ctx.storage.sql), log,
      { download: createTelegramFileDownloader(token), transcribe: selectTranscriber(this.env)?.transcribe }, clock, reminderHandlers(book),
    );
    const listener = new TelegramOwnerListener({
      ownerTelegramId: owner, api, ...responder, log,
      saveOffset: (offset) => this.ctx.storage.put('offset', offset),
    });
    const fire = async (entry: ScheduleEntry) => {
      const note = book.note(entry.id);
      if (note === null) return;
      const trace = `${entry.id}:${entry.occurrence_at}:${entry.attempts}`;
      const started = Date.now();
      const time: TurnTimer = async (hop, work) => {
        const at = Date.now();
        try {
          const result = await work();
          log({ trace, hop, ms: Date.now() - at, ok: true });
          return result;
        } catch (error) {
          log({ trace, hop, ms: Date.now() - at, ok: false, error: String(error) });
          throw error;
        }
      };
      try {
        const text = (await responder.remind(trace, owner, note, time)).trim() || note;
        await time('send', () => api.sendMessage({ chat_id: owner, text }));
        book.fired(entry);
        log({ trace, hop: 'reminder', ms: Date.now() - started, ok: true, text: { input: note, output: text } });
      } catch (error) {
        log({ trace, hop: 'reminder', ms: Date.now() - started, ok: false, error: String(error) });
        throw error;
      }
    };
    this.runtime = { owner, listener, scheduler, fire };
    return this.runtime;
  }
}
