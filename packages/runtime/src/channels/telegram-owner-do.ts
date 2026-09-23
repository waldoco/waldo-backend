import { DurableObject } from 'cloudflare:workers';
import type { ScheduleEntry } from '@waldo/contracts';
import { ensureSchema } from '../tracer/schema';
import { coreFileStore } from '../memory/core-files';
import { langfuseOtlpConfig, otlpTurnExporter } from '../observability/otlp-turns';
import { Scheduler } from '../scheduler/multiplexer';
import { productionDeps } from '../seams/deps';
import { durableConversationStore } from './conversation-store';
import { armNightly, backfillEpisodes, episodeIndex, indexedConversationStore, transcript } from './episodes';
import { armBriefSweep, eventBriefs } from './event-briefs';
import { armDayCards, cardFor, composeDayCard, isSkip } from './day-cards';
import { searchEpisodesHandler } from '../tools/live/search-episodes';
import { localIso, localToEpoch, reminderBook, reminderHandlers } from './reminders';
import { googleClient, googleConsentUrl, GOOGLE_CALLBACK_PATH, oauthState, type GoogleTokens } from '../connectors/google';
import { googleHandlers } from '../tools/live/google';
import { approvalDesk, type ApprovalDesk, type CallbackQuery } from './approvals';
import { TELEGRAM_WEBHOOK_PATH } from './telegram-webhook';
import { createTelegramCaller, createTelegramOwnerApi } from './telegram-api';
import { createTelegramFileDownloader } from './telegram-media';
import { selectTranscriber } from '../llm/transcriber';
import { TelegramOwnerListener, type TurnLogEntry, type TurnTimer } from './telegram-listener';
import { TelegramPollingAdapter } from './telegram-polling';
import { createTelegramResponder } from './telegram-turn';
import type { TelegramWebhookEnv } from './telegram-webhook';

const WEBHOOK_UPDATES = ['message', 'callback_query'];

type RawUpdate = { update_id?: number; callback_query?: CallbackQuery; message?: { text?: string; from?: { id: number }; chat?: { id: number } } };

type OwnerRuntime = Readonly<{
  owner: number;
  listener: TelegramOwnerListener;
  api: ReturnType<typeof createTelegramOwnerApi>;
  call: ReturnType<typeof createTelegramCaller>;
  desk: ApprovalDesk;
  reminders: ReturnType<typeof reminderBook>;
  scheduler: Scheduler;
  fire(entry: ScheduleEntry): Promise<void>;
  nightly(entry: ScheduleEntry): Promise<void>;
  briefs(entry: ScheduleEntry): Promise<void>;
  cards(entry: ScheduleEntry): Promise<void>;
  ready: Promise<void>;
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
    if (origin && this.env.TELEGRAM_WEBHOOK_SECRET && (await this.ctx.storage.get('webhook_updates')) !== WEBHOOK_UPDATES.join(',')) {
      try {
        await this.setup().call('setWebhook', { url: `${origin}${TELEGRAM_WEBHOOK_PATH}`, secret_token: this.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: WEBHOOK_UPDATES });
        await this.ctx.storage.put('webhook_updates', WEBHOOK_UPDATES.join(','));
      } catch (error) {
        console.log(JSON.stringify({ hop: 'set_webhook', ok: false, error: String(error) }));
      }
    }
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
      const { scheduler, fire, nightly, briefs, cards, ready } = this.setup();
      await ready;
      await scheduler.dispatchDue({ reminder: fire, dreaming: nightly, pre_activity_spot: briefs, brief: cards });
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async turn(update: unknown): Promise<void> {
    const { listener, owner, call, desk, reminders, ready } = this.setup();
    await ready;
    const offset = (await this.ctx.storage.get<number>('offset')) ?? 0;
    const raw = update as RawUpdate;
    const handledDirectly = raw.callback_query !== undefined
      || (raw.message?.text?.trim() === '/ledger' && raw.message.from?.id === owner && raw.message.chat?.id === owner);
    if (handledDirectly) {
      if (raw.update_id === undefined || raw.update_id < offset) return;
      if (raw.callback_query) await desk.callback(raw.callback_query, `tg-${raw.update_id}`);
      else await call('sendMessage', { chat_id: owner, text: desk.ledger(reminders.list()) });
      await this.ctx.storage.put('offset', raw.update_id + 1);
      return;
    }
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
    const call = createTelegramCaller(token);
    const api = createTelegramOwnerApi(call);
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
    const desk = approvalDesk(storage.sql, {
      call, owner, google: () => google.client(), newId: () => deps.newRunId().slice(0, 8), now: () => Date.now(),
      timezone: clock.timezone, log,
    });
    const episodes = episodeIndex(storage.sql);
    const kv = durableConversationStore(storage);
    const ready = Promise.all([backfillEpisodes(kv, episodes), armNightly(scheduler, clock.timezone, Date.now()), armBriefSweep(scheduler, Date.now()), armDayCards(scheduler, clock.timezone, Date.now())]).then(() => undefined);
    const responder = createTelegramResponder(
      key, indexedConversationStore(kv, episodes, () => Date.now()), coreFileStore(this.ctx.storage.sql), log,
      { download: createTelegramFileDownloader(token), transcribe: selectTranscriber(this.env)?.transcribe }, clock, [...reminderHandlers(book), ...googleHandlers(google, desk, clock), searchEpisodesHandler(episodes)],
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
    const nightly = async (entry: ScheduleEntry) => {
      const trace = `${entry.id}:${entry.occurrence_at}`;
      const started = Date.now();
      const day = episodes.since(entry.occurrence_at - 24 * 60 * 60_000, 40_000);
      if (day.length === 0) return log({ trace, hop: 'nightly_memory', ms: 0, ok: true, detail: 'quiet day' });
      try {
        const changed = await responder.consolidate(trace, transcript(day, clock.timezone));
        log({ trace, hop: 'nightly_memory', ms: Date.now() - started, ok: true, detail: `${day.length} turns; ${changed.join(',') || 'no edits'}` });
      } catch (error) {
        log({ trace, hop: 'nightly_memory', ms: Date.now() - started, ok: false, error: String(error) });
        throw error;
      }
    };
    const briefBook = eventBriefs(storage.sql, clock.timezone);
    const briefs = async (entry: ScheduleEntry) => {
      const trace = `${entry.id}:${entry.occurrence_at}`;
      const started = Date.now();
      try {
        const sent = await briefBook.sweep(await google.client(), Date.now(), async (id, event, said) => {
          const at = Date.now();
          const text = (await responder.prompt(id, owner, said, async (hop, work) => work())).trim();
          if (text) await api.sendMessage({ chat_id: owner, text });
          log({ trace: id, hop: 'event_brief', ms: Date.now() - at, ok: true, detail: event.id, text: { input: said, output: text } });
        });
        if (sent) log({ trace, hop: 'brief_sweep', ms: Date.now() - started, ok: true, detail: `${sent} sent` });
      } catch (error) {
        log({ trace, hop: 'brief_sweep', ms: Date.now() - started, ok: false, error: String(error) });
      }
    };
    const cards = async (entry: ScheduleEntry) => {
      const card = cardFor(entry.id);
      if (card === null) return;
      const trace = `${entry.id}:${entry.occurrence_at}`;
      const started = Date.now();
      const now = Date.now();
      const client = await google.client();
      const midnight = localToEpoch(`${localIso(now, clock.timezone).slice(0, 10)}T00:00`, clock.timezone);
      const said = await composeDayCard(card, now, clock.timezone, {
        google: client, connectUrl: client ? null : await google.connectUrl(),
        ledger: desk.ledger(book.list()), today: transcript(episodes.since(midnight, 30_000), clock.timezone),
      });
      try {
        const text = (await responder.prompt(trace, owner, said, async (hop, work) => work())).trim();
        const skipped = !text || isSkip(text);
        if (!skipped) await api.sendMessage({ chat_id: owner, text });
        log({ trace, hop: 'day_card', ms: Date.now() - started, ok: true, detail: skipped ? `${card.id} skipped` : card.id, text: { input: said, output: text } });
      } catch (error) {
        log({ trace, hop: 'day_card', ms: Date.now() - started, ok: false, error: String(error) });
        throw error;
      }
    };
    this.runtime = { owner, listener, api, call, desk, reminders: book, scheduler, fire, nightly, briefs, cards, ready };
    return this.runtime;
  }
}
