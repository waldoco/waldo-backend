import { DurableObject } from 'cloudflare:workers';
import type { ScheduleEntry } from '@waldo/contracts';
import { ensureSchema } from '../tracer/schema';
import { coreFileStore } from '../memory/core-files';
import { langfuseOtlpConfig, otlpTurnExporter } from '../observability/otlp-turns';
import { Scheduler } from '../scheduler/multiplexer';
import { productionDeps } from '../seams/deps';
import { durableConversationStore } from './conversation-store';
import { reminderBook, reminderHandlers } from './reminders';
import { googleClient, googleConsentUrl, GOOGLE_CALLBACK_PATH, oauthState, type GoogleTokens } from '../connectors/google';
import { googleHandlers } from '../tools/live/google';
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
  api: ReturnType<typeof createTelegramOwnerApi>;
  scheduler: Scheduler;
  fire(entry: ScheduleEntry): Promise<void>;
}>;

export class TelegramOwnerDO extends DurableObject<TelegramWebhookEnv> {
  private runtime?: OwnerRuntime;
  private queue: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const body = await request.text();
    if (new URL(request.url).pathname === '/google') {
      await this.serial(() => this.connectGoogle(JSON.parse(body) as GoogleTokens));
      return new Response('ok');
    }
    const origin = request.headers.get('x-waldo-origin');
    if (origin) await this.ctx.storage.put('origin', origin);
    await this.serial(() => this.turn(JSON.parse(body) as unknown));
    return new Response('ok');
  }

  private async connectGoogle(tokens: GoogleTokens): Promise<void> {
    await this.ctx.storage.put('google:tokens', tokens);
    const { owner, api } = this.setup();
    await api.sendMessage({ chat_id: owner, text: `Google is connected${tokens.email ? ` (${tokens.email})` : ''}. I can read your calendar and save email drafts now.` });
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
    const storage = this.ctx.storage;
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, TELEGRAM_WEBHOOK_SECRET: stateSecret } = this.env;
    const googleApp = async () => {
      const origin = await storage.get<string>('origin');
      return clientId && clientSecret && origin ? { clientId, clientSecret, redirectUri: `${origin}${GOOGLE_CALLBACK_PATH}` } : null;
    };
    const google = {
      async client() {
        const [app, tokens] = [await googleApp(), await storage.get<GoogleTokens>('google:tokens')];
        return app && tokens ? googleClient(app, tokens) : null;
      },
      async connectUrl() {
        const app = await googleApp();
        return app && stateSecret ? googleConsentUrl(app, await oauthState(stateSecret, String(owner), Date.now())) : null;
      },
    };
    storage.sql.exec('CREATE TABLE IF NOT EXISTS calendar_proposals (id TEXT PRIMARY KEY, proposal_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)');
    const proposals = {
      add(proposal: unknown) {
        const id = `proposal:${deps.newRunId().slice(0, 8)}`;
        storage.sql.exec("INSERT INTO calendar_proposals (id, proposal_json, status, created_at) VALUES (?, ?, 'proposed', ?)", id, JSON.stringify(proposal), Date.now());
        return id;
      },
    };
    const responder = createTelegramResponder(
      key, durableConversationStore(this.ctx.storage), coreFileStore(this.ctx.storage.sql), log,
      { download: createTelegramFileDownloader(token), transcribe: selectTranscriber(this.env)?.transcribe }, clock, [...reminderHandlers(book), ...googleHandlers(google, proposals, clock)],
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
    this.runtime = { owner, listener, api, scheduler, fire };
    return this.runtime;
  }
}
