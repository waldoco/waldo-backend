import { DurableObject } from 'cloudflare:workers';
import type { ScheduleEntry } from '@waldo/contracts';
import { ensureSchema } from '../tracer/schema';
import { coreFileStore } from '../memory/core-files';
import { spotStore } from '../memory/spots';
import { type ConsoleView, consoleAccess, CONSOLE_COOKIE, CONSOLE_PATH, renderConsole, sessionCookie } from './console';
import { FIRE_TARGETS, parseHarnessCommand, traceBook, type TraceBook } from './harness';
import { langfuseOtlpConfig, otlpTurnExporter } from '../observability/otlp-turns';
import { Scheduler } from '../scheduler/multiplexer';
import { productionDeps } from '../seams/deps';
import { durableConversationStore } from './conversation-store';
import { armNightly, backfillEpisodes, episodeIndex, indexedConversationStore, transcript } from './episodes';
import { armBriefSweep, eventBriefs } from './event-briefs';
import { applyDayPlan, armDayCards, cardFor, composeDayCard, dayPlanBook, dayWindow, isSkip, parseDayPlan, readCalendar } from './day-cards';
import { dayPlanInput } from '../prompt/day-cards';
import { SKIP_UPDATE, updateCardPrompt } from '../prompt/update-cards';
import { changeLines, collectChanges, updateBook } from './update-cards';
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
  updateCheck(trace: string): Promise<void>;
  view(): Promise<ConsoleView>;
  traces: TraceBook;
  timezone: string;
  ready: Promise<void>;
}>;

export class TelegramOwnerDO extends DurableObject<TelegramWebhookEnv> {
  private runtime?: OwnerRuntime;
  private queue: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(CONSOLE_PATH)) return this.console(request);
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

  private async console(request: Request): Promise<Response> {
    const access = consoleAccess(this.ctx.storage);
    const url = new URL(request.url);
    const link = url.searchParams.get('t');
    if (link) {
      const session = await access.redeem(link);
      if (!session) return new Response('This console link is used or expired. Send /console to Waldo for a new one.', { status: 403 });
      return new Response(null, { status: 303, headers: { location: CONSOLE_PATH, 'set-cookie': `${CONSOLE_COOKIE}=${session}; Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` } });
    }
    if (!(await access.valid(sessionCookie(request)))) return new Response('Send /console to Waldo on Telegram for a sign-in link.', { status: 401 });
    const { ready, view } = this.setup();
    await ready;
    return new Response(renderConsole(await view()), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
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
    const fromOwner = raw.message?.from?.id === owner && raw.message.chat?.id === owner;
    const harness = fromOwner ? parseHarnessCommand(raw.message?.text) : null;
    const handledDirectly = raw.callback_query !== undefined || harness !== null || (fromOwner && raw.message?.text?.trim() === '/ledger');
    if (handledDirectly) {
      if (raw.update_id === undefined || raw.update_id < offset) return;
      if (harness?.kind === 'console') {
        await this.ctx.storage.put('offset', raw.update_id + 1);
        const origin = await this.ctx.storage.get<string>('origin');
        await call('sendMessage', { chat_id: owner, text: origin ? `Console (link works once, for 10 minutes): ${await consoleAccess(this.ctx.storage).mintLink(origin)}` : 'Console origin is not known yet; send any message first.' });
        return;
      }
      if (harness) {
        await this.ctx.storage.put('offset', raw.update_id + 1);
        await call('sendMessage', { chat_id: owner, text: (await this.runHarness(harness, raw.update_id)).slice(0, 4000) });
        return;
      }
      if (raw.callback_query) await desk.callback(raw.callback_query, `tg-${raw.update_id}`);
      else await call('sendMessage', { chat_id: owner, text: desk.ledger(reminders.list()) });
      await this.ctx.storage.put('offset', raw.update_id + 1);
      return;
    }
    await listener.pollOnce(new TelegramPollingAdapter({ getUpdates: async () => [update] }, offset), 0);
  }

  private async runHarness(command: NonNullable<ReturnType<typeof parseHarnessCommand>>, updateId: number): Promise<string> {
    const { traces, timezone, cards, briefs, nightly, updateCheck } = this.setup();
    if (command.kind === 'trace') return traces.recent(timezone, command.filter);
    if (command.kind === 'e2e') return traces.checklist(timezone);
    if (command.kind !== 'fire') return '';
    if (command.target === null) return `Usage: /fire <${FIRE_TARGETS.join(' | ')}>`;
    const trace = `harness-${updateId}`;
    const entry = { id: command.target, occurrence_at: Date.now(), attempts: 0 } as unknown as ScheduleEntry;
    try {
      if (command.target === 'fetch') await updateCheck(trace);
      else if (command.target === 'briefs') await briefs(entry);
      else if (command.target === 'nightly') await nightly(entry);
      else await cards(entry);
    } catch (error) {
      return `Fired ${command.target}; it failed: ${String(error)}\n\n${traces.recent(timezone, null, 10)}`;
    }
    return `Fired ${command.target}.\n\n${traces.recent(timezone, null, 10)}`;
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
    const traces = traceBook(this.ctx.storage.sql);
    const log = (entry: TurnLogEntry) => {
      traces.record(entry, Date.now());
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
    const plans = dayPlanBook(storage.sql);
    const memory = coreFileStore(storage.sql);
    const spots = spotStore(storage.sql);
    const updates = updateBook(storage.sql);
    const ready = Promise.all([backfillEpisodes(kv, episodes), armNightly(scheduler, clock.timezone, Date.now()), armBriefSweep(scheduler, Date.now()), armDayCards(scheduler, plans, clock.timezone, Date.now())])
      .then(([, , , seeded]) => { if (seeded) void this.serial(() => planToday('day-plan:boot')); });
    const responder = createTelegramResponder(
      key, indexedConversationStore(kv, episodes, () => Date.now()), memory, log,
      { download: createTelegramFileDownloader(token), transcribe: selectTranscriber(this.env)?.transcribe }, clock, [...reminderHandlers(book), ...googleHandlers(google, desk, clock), searchEpisodesHandler(episodes)], spots,
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
    const planToday = async (trace: string) => {
      const started = Date.now();
      const now = Date.now();
      const cards = plans.pending(localIso(now, clock.timezone).slice(0, 10));
      if (cards.length === 0) return;
      try {
        const calendar = await readCalendar(dayWindow(now, clock.timezone), clock.timezone, await google.client(), null);
        const said = dayPlanInput({ localNow: localIso(now, clock.timezone), calendar, cards });
        const applied = await applyDayPlan(scheduler, plans, clock.timezone, now, parseDayPlan(await responder.planDay(trace, said), cards));
        log({ trace, hop: 'day_plan', ms: Date.now() - started, ok: true, detail: applied.map((plan) => `${plan.card}=${plan.time ?? 'skip'} (${plan.reason})`).join('; ') });
      } catch (error) {
        log({ trace, hop: 'day_plan', ms: Date.now() - started, ok: false, error: String(error) });
      }
    };
    const nightly = async (entry: ScheduleEntry) => {
      const trace = `${entry.id}:${entry.occurrence_at}`;
      const started = Date.now();
      const day = episodes.since(entry.occurrence_at - 24 * 60 * 60_000, 40_000);
      if (day.length === 0) log({ trace, hop: 'nightly_memory', ms: 0, ok: true, detail: 'quiet day' });
      else {
        try {
          const changed = await responder.consolidate(trace, transcript(day, clock.timezone));
          log({ trace, hop: 'nightly_memory', ms: Date.now() - started, ok: true, detail: `${day.length} turns; ${changed.join(',') || 'no edits'}` });
        } catch (error) {
          log({ trace, hop: 'nightly_memory', ms: Date.now() - started, ok: false, error: String(error) });
        }
      }
      const promoting = Date.now();
      await responder.promote(`${trace}:constellation`)
        .then((detail) => log({ trace, hop: 'constellation', ms: Date.now() - promoting, ok: true, detail }))
        .catch((error: unknown) => log({ trace, hop: 'constellation', ms: Date.now() - promoting, ok: false, error: String(error) }));
      await armDayCards(scheduler, plans, clock.timezone, Date.now());
      await planToday(`${trace}:plan`);
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
      await updateCheck(`update:${entry.occurrence_at}`);
    };
    const updateCheck = async (trace: string) => {
      const client = await google.client();
      if (client === null) return;
      const started = Date.now();
      try {
        const now = Date.now();
        const changes = await collectChanges(updates, client, now);
        if (changes.length === 0) return;
        const day = localIso(now, clock.timezone).slice(0, 10);
        const sentToday = new Set(plans.read(day).filter((row) => row.sent).map((row) => row.card));
        const canSend = sentToday.has('card:brief') && !sentToday.has('card:close');
        let text: string | null = null;
        if (canSend) {
          const said = updateCardPrompt(localIso(now, clock.timezone), { changes: changeLines(changes), ledger: desk.ledger(book.list()) });
          const reply = (await responder.prompt(trace, owner, said, async (hop, work) => work())).trim();
          if (reply && reply !== SKIP_UPDATE) {
            await api.sendMessage({ chat_id: owner, text: reply });
            text = reply;
          }
        }
        updates.record(day, now, changes, text);
        log({ trace, hop: 'update_card', ms: Date.now() - started, ok: true, detail: `${changes.length} changes; ${text ? 'sent' : canSend ? 'skipped' : 'held for next card'}`, text: { input: changeLines(changes), output: text ?? '' } });
      } catch (error) {
        log({ trace, hop: 'update_card', ms: Date.now() - started, ok: false, error: String(error) });
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
        ledger: desk.ledger(book.list()), today: transcript(episodes.since(midnight, 30_000), clock.timezone), updates: updates.unfolded(clock.timezone),
      });
      try {
        const text = (await responder.prompt(trace, owner, said, async (hop, work) => work())).trim();
        const skipped = !text || isSkip(text);
        if (!skipped) await api.sendMessage({ chat_id: owner, text });
        plans.sent(localIso(entry.occurrence_at, clock.timezone).slice(0, 10), card.id);
        updates.fold(now);
        log({ trace, hop: 'day_card', ms: Date.now() - started, ok: true, detail: skipped ? `${card.id} skipped` : card.id, text: { input: said, output: text } });
      } catch (error) {
        log({ trace, hop: 'day_card', ms: Date.now() - started, ok: false, error: String(error) });
        throw error;
      }
    };
    this.runtime = { owner, listener, api, call, desk, reminders: book, scheduler, fire, nightly, briefs, cards, updateCheck, traces,
      view: async () => {
        const tokens = await storage.get<GoogleTokens>('google:tokens');
        return {
          release: this.env.WALDO_RELEASE ?? 'unknown', timezone: clock.timezone,
          google: { connected: tokens !== undefined, email: tokens?.email ?? null },
          memory: memory.read(), spots: spots.spots(), retiredSpots: ['dismissed', 'promoted'].flatMap((status) => spots.spots(status)),
          nodes: spots.nodes(), edges: spots.edges(),
          cards: plans.read(localIso(Date.now(), clock.timezone).slice(0, 10)),
          ledger: desk.ledger(book.list()), checklist: traces.checklist(clock.timezone), trace: traces.recent(clock.timezone, null, 60),
        };
      }, timezone: clock.timezone, ready };
    return this.runtime;
  }
}
