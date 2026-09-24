import { DurableObject } from 'cloudflare:workers';
import { setProactivityArgsSchema, type ScheduleEntry } from '@waldo/contracts';
import { ensureSchema } from '../tracer/schema';
import { claimStore, profile } from '../memory/claims';
import { isQuiet, loopBook, loopHandlers, loopsSection, proactivityLine } from './loops';
import { backupAndCopySpots, markCoreFilesMigrated, pendingCoreFiles } from '../memory/migration';
import { fileBook, fileResponse } from './files';
import { consoleAuth, type OwnerSettings } from '../identity/console-auth';
import { CONSOLE_ADMIN_PATH, renderAdmin } from './console-admin';
import { type ConsoleAction, type ConsoleSession, type ConsoleView, consoleAccess, signInPage, CONSOLE_ACTION_PATH, CONSOLE_COOKIE, CONSOLE_FILE_PATH, CONSOLE_GOOGLE_PATH, CONSOLE_PATH, NOTICES, parseConsoleAction, renderConsole, sessionCookie } from './console';
import { FIRE_TARGETS, parseHarnessCommand, traceBook, type TraceBook } from './harness';
import { langfuseOtlpConfig, otlpTurnExporter } from '../observability/otlp-turns';
import { Scheduler } from '../scheduler/multiplexer';
import { productionDeps } from '../seams/deps';
import { durableConversationStore } from './conversation-store';
import { armNightly, backfillEpisodes, episodeIndex, indexedConversationStore, transcript } from './episodes';
import { armBriefSweep, eventBriefs } from './event-briefs';
import { applyDayPlan, armDayCards, cardFor, isClock, composeDayCard, dayPlanBook, dayWindow, isSkip, parseDayPlan, readCalendar } from './day-cards';
import { DAY_CARDS, dayPlanInput } from '../prompt/day-cards';
import { SKIP_UPDATE, updateCardPrompt } from '../prompt/update-cards';
import { changeLines, collectChanges, updateBook, type UpdateBook } from './update-cards';
import { searchEpisodesHandler } from '../tools/live/search-episodes';
import { localIso, localToEpoch, reminderBook, reminderHandlers } from './reminders';
import { googleClient, googleConsentUrl, googleHas, GOOGLE_CALLBACK_PATH, isGoogleFeature, oauthState, type GoogleFeature, type GoogleTokens } from '../connectors/google';
import { googleProxy, type GoogleLink } from '../connectors/connections';
import { googleHandlers } from '../tools/live/google';
import { approvalDesk, type ApprovalDesk, type CallbackQuery } from './approvals';
import { TELEGRAM_WEBHOOK_PATH } from './telegram-webhook';
import { createTelegramCaller, gatedCaller, createTelegramOwnerApi } from './telegram-api';
import { createTelegramFileDownloader } from './telegram-media';
import { selectTranscriber } from '../llm/transcriber';
import { TelegramOwnerListener, type TurnLogEntry, type TurnTimer } from './telegram-listener';
import { TelegramPollingAdapter } from './telegram-polling';
import { createTelegramResponder } from './telegram-turn';
import type { TurnControl } from './turn-control';
import type { TelegramWebhookEnv } from './telegram-webhook';

const WEBHOOK_UPDATES = ['message', 'callback_query'];

type RawUpdate = { update_id?: number; callback_query?: CallbackQuery; message?: { text?: string; from?: { id: number }; chat?: { id: number } } };

// scopes null: granted before per-feature scopes, under the owner's 09-23 broad consent.
type GoogleAccount = Readonly<{ id: string; email: string; scopes: readonly string[] | null; refresh_token?: string }>;
const LEGACY_GRANT = null;
type LinkGrant = Readonly<{ id: string; email: string; scopes: readonly string[] | null }>;

type OwnerRuntime = Readonly<{
  owner: number;
  listener: TelegramOwnerListener;
  control: TurnControl;
  api: ReturnType<typeof createTelegramOwnerApi>;
  call: ReturnType<typeof createTelegramCaller>;
  desk: ApprovalDesk;
  ledger(): string;
  updates: UpdateBook;
  reminders: ReturnType<typeof reminderBook>;
  scheduler: Scheduler;
  fire(entry: ScheduleEntry): Promise<void>;
  nightly(entry: ScheduleEntry): Promise<void>;
  briefs(entry: ScheduleEntry): Promise<void>;
  cards(entry: ScheduleEntry): Promise<void>;
  updateCheck(trace: string): Promise<void>;
  view(session: ConsoleSession, notice: string | null): Promise<ConsoleView>;
  act(action: ConsoleAction): Promise<boolean>;
  googleConnectUrl(feature: GoogleFeature): Promise<string | null>;
  google: Readonly<{ keep(grant: GoogleTokens | LinkGrant): Promise<void> }>;
  openFile(id: number): Promise<Response | null>;
  traces: TraceBook;
  timezone: string;
  ready: Promise<void>;
  log(entry: TurnLogEntry): void;
}>;

const LATE_FIRE_MS = 5 * 60_000;

const validZone = (zone: string): boolean => {
  try {
    return zone.length > 0 && Boolean(new Intl.DateTimeFormat('en', { timeZone: zone }));
  } catch {
    return false;
  }
};

export class TelegramOwnerDO extends DurableObject<TelegramWebhookEnv> {
  private runtime?: OwnerRuntime;
  private queue: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const doName = request.headers.get('x-waldo-do-name');
    if (doName && this.ctx.storage.kv.get<string>('do_name') !== doName) this.ctx.storage.kv.put('do_name', doName);
    if (new URL(request.url).pathname === '/grant-console' && request.method === 'POST') return new Response(await consoleAccess(this.ctx.storage).grant());
    if (new URL(request.url).pathname.startsWith(CONSOLE_PATH)) return this.console(request);
    const body = await request.text();
    if (new URL(request.url).pathname === '/google') {
      await this.serial(() => this.connectGoogle(JSON.parse(body) as GoogleTokens | GoogleLink));
      return new Response('ok');
    }
    const origin = request.headers.get('x-waldo-origin');
    if (origin) await this.ctx.storage.put('origin', origin);
    this.bindIdentity(request.headers);
    if (origin && this.env.TELEGRAM_WEBHOOK_SECRET && (await this.ctx.storage.get('webhook_updates')) !== WEBHOOK_UPDATES.join(',')) {
      try {
        await this.setup().call('setWebhook', { url: `${origin}${TELEGRAM_WEBHOOK_PATH}`, secret_token: this.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: WEBHOOK_UPDATES });
        await this.ctx.storage.put('webhook_updates', WEBHOOK_UPDATES.join(','));
      } catch (error) {
        console.log(JSON.stringify({ hop: 'set_webhook', ok: false, error: String(error) }));
      }
    }
    const update = JSON.parse(body) as RawUpdate;
    if (this.intercept(update)) return new Response('ok');
    await this.serial(() => this.turn(update));
    return new Response('ok');
  }

  // The webhook names the Telegram subject and timezone it resolved for this owner; they outlive deploy variables.
  private bindIdentity(headers: Headers): void {
    const { kv } = this.ctx.storage;
    const subject = headers.get('x-waldo-telegram-subject');
    if (subject) kv.delete('telegram_unlinked');
    if (subject && kv.get<string>('telegram_subject') !== subject) {
      kv.put('telegram_subject', subject);
      this.runtime = undefined;
    }
    const timezone = headers.get('x-waldo-timezone');
    if (timezone && kv.get<string>('timezone') !== timezone) kv.put('timezone', timezone);
  }

  private async console(request: Request): Promise<Response> {
    const access = consoleAccess(this.ctx.storage);
    const url = new URL(request.url);
    const link = url.pathname === CONSOLE_PATH ? url.searchParams.get('t') : null;
    if (link && request.method === 'GET') return signInPage(link);
    const posted = url.pathname === CONSOLE_PATH && request.method === 'POST' ? String((await request.formData()).get('t') ?? '') : '';
    if (posted) {
      const session = await access.redeem(posted);
      if (!session) return new Response('This console link is used or expired. Send /console to Waldo for a new one.', { status: 403 });
      return new Response(null, { status: 303, headers: { location: CONSOLE_PATH, 'set-cookie': `${CONSOLE_COOKIE}=${session}; Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` } });
    }
    const session = await access.session(sessionCookie(request));
    if (!session) return new Response('Send /console to Waldo on Telegram for a sign-in link.', { status: 401 });
    const { ready, view, act, googleConnectUrl, openFile } = this.setup();
    await ready;
    const back = (notice: string) => new Response(null, { status: 303, headers: { location: `${CONSOLE_PATH}?m=${notice}` } });
    if (url.pathname === CONSOLE_GOOGLE_PATH) {
      const feature = url.searchParams.get('feature') ?? 'calendar';
      const consent = isGoogleFeature(feature) ? await googleConnectUrl(feature) : null;
      return consent ? new Response(null, { status: 302, headers: { location: consent } }) : back('invalid');
    }
    const admin = consoleAuth(this.env);
    const doName = this.ctx.storage.kv.get<string>('do_name');
    if (url.pathname === CONSOLE_ADMIN_PATH) {
      const overview = admin && doName ? await admin.adminOverview(doName) : null;
      return overview ? new Response(renderAdmin(overview, session.csrf), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } }) : new Response('not found', { status: 404 });
    }
    if (url.pathname === CONSOLE_FILE_PATH) return (await openFile(Number(url.searchParams.get('id')))) ?? back('file.unavailable');
    if (url.pathname === CONSOLE_ACTION_PATH && request.method === 'POST') {
      const action = parseConsoleAction(await request.formData(), session.csrf);
      if (action?.action === 'telegram.link') return this.telegramLinkPage();
      if (action?.action === 'invite.create' || action?.action === 'invite.revoke') {
        const done = admin && doName ? await (action.action === 'invite.create' ? admin.invite(doName, action.value) : admin.revokeInvite(doName, action.id)) : false;
        return new Response(null, { status: 303, headers: { location: done ? CONSOLE_ADMIN_PATH : `${CONSOLE_PATH}?m=invalid` } });
      }
      if (action?.action === 'telegram.unlink') {
        const done = admin && doName ? await admin.unlinkTelegram(doName) : false;
        if (done) this.ctx.storage.kv.put('telegram_unlinked', true);
        return back(done ? 'telegram.unlink' : 'invalid');
      }
      if (action?.action === 'session.signout') {
        await access.signOut();
        return new Response('Signed out. Send /console to Waldo on Telegram to sign in again.', { headers: { 'set-cookie': `${CONSOLE_COOKIE}=; Path=${CONSOLE_PATH}; Max-Age=0` } });
      }
      const done = action ? await this.serial(() => act(action)) : false;
      return back(done && action ? action.action : 'invalid');
    }
    if (url.pathname !== CONSOLE_PATH) return new Response('not found', { status: 404 });
    return new Response(renderConsole(await view(session, NOTICES[url.searchParams.get('m') ?? ''] ?? null)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
  }

  private async telegramLinkPage(): Promise<Response> {
    const doName = this.ctx.storage.kv.get<string>('do_name');
    const code = doName ? await consoleAuth(this.env)?.issueLinkCode(doName) : null;
    const text = code
      ? `Send this to the Waldo bot on Telegram within 10 minutes: /link ${code}`
      : 'Linking Telegram from the console needs account sign-in, which is not set up on this server yet.';
    return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><p style="font:18px system-ui;margin:40px">${text}</p><p style="font:16px system-ui;margin:40px"><a href="${CONSOLE_PATH}">Back</a></p>`, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' },
    });
  }

  private async connectGoogle(tokens: GoogleTokens | GoogleLink): Promise<void> {
    const { owner, api, google } = this.setup();
    await google.keep(tokens);
    const can = [googleHas(tokens.scopes, 'calendar') ? 'read your calendar' : '', googleHas(tokens.scopes, 'mail') ? 'read and send mail you approve' : ''].filter(Boolean).join(' and ');
    await api.sendMessage({ chat_id: owner, text: `Google is connected${tokens.email ? ` (${tokens.email})` : ''}.${can ? ` I can ${can} now.` : ''}` });
  }

  override async alarm(): Promise<void> {
    await this.serial(async () => {
      const { scheduler, fire, nightly, briefs, cards, ready, log } = this.setup();
      await ready;
      const started = Date.now();
      const fired = await scheduler.dispatchDue({ reminder: fire, dreaming: nightly, pre_activity_spot: briefs, brief: cards });
      for (const entry of fired) {
        const late = started - entry.due_at;
        if (late > LATE_FIRE_MS) log({ trace: `${entry.id}:${entry.occurrence_at}`, hop: 'late_fire', ms: late, ok: false, error: `${entry.kind} fired ${Math.round(late / 60_000)} min late` });
      }
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // Runs outside the serial queue so it reaches a turn that is still running.
  private intercept(update: RawUpdate): boolean {
    if (!this.runtime || update.update_id === undefined) return false;
    const { owner, control, call, log } = this.runtime;
    const text = update.message?.text?.trim();
    if (update.message?.from?.id !== owner || update.message.chat?.id !== owner || !text) return false;
    const trace = `tg-${update.update_id}`;
    if (text === '/stop') {
      const stopping = control.stop();
      log({ trace, hop: 'stop', ms: 0, ok: true, detail: stopping ? 'stopping the running turn' : 'nothing running' });
      void call('sendMessage', { chat_id: owner, text: stopping ? 'Stopping.' : 'Nothing is running right now.' }).catch(() => undefined);
      return true;
    }
    if (!text.startsWith('/') && control.steer(update.update_id, text)) log({ trace, hop: 'steer', ms: 0, ok: true, detail: 'queued for the running turn' });
    return false;
  }

  private async turn(update: unknown): Promise<void> {
    const { listener, owner, call, desk, ledger, updates, control, log, ready } = this.setup();
    await ready;
    const offset = (await this.ctx.storage.get<number>('offset')) ?? 0;
    const raw = update as RawUpdate;
    const fromOwner = raw.message?.from?.id === owner && raw.message.chat?.id === owner;
    if (fromOwner && raw.update_id !== undefined && raw.update_id >= offset && control.absorbed(raw.update_id)) {
      await this.ctx.storage.put('offset', raw.update_id + 1);
      return log({ trace: `tg-${raw.update_id}`, hop: 'steer', ms: 0, ok: true, detail: 'answered inside the running turn' });
    }
    if (fromOwner && raw.message?.text?.trim() === '/stop') {
      if (raw.update_id === undefined || raw.update_id < offset) return;
      await this.ctx.storage.put('offset', raw.update_id + 1);
      return void (await call('sendMessage', { chat_id: owner, text: 'Nothing is running right now.' }));
    }
    const harness = fromOwner ? parseHarnessCommand(raw.message?.text) : null;
    const handledDirectly = raw.callback_query !== undefined || harness !== null || (fromOwner && raw.message?.text?.trim() === '/ledger');
    if (handledDirectly) {
      if (raw.update_id === undefined || raw.update_id < offset) return;
      if (harness?.kind === 'console') {
        await this.ctx.storage.put('offset', raw.update_id + 1);
        const origin = await this.ctx.storage.get<string>('origin');
        await call('sendMessage', { chat_id: owner, text: origin ? `Console (link works once, for 10 minutes): ${await consoleAccess(this.ctx.storage).mintLink(origin)}` : 'Console origin is not known yet; send any message first.', link_preview_options: { is_disabled: true } });
        return;
      }
      if (harness) {
        await this.ctx.storage.put('offset', raw.update_id + 1);
        await call('sendMessage', { chat_id: owner, text: (await this.runHarness(harness, raw.update_id)).slice(0, 4000) });
        return;
      }
      const feedback = raw.callback_query?.data?.match(/^fb:(\d+):([un])$/);
      if (feedback && raw.callback_query) {
        const query = raw.callback_query;
        const rated = query.from.id === owner && updates.rate(Number(feedback[1]), feedback[2] === 'u' ? 'useful' : 'not useful');
        await call('answerCallbackQuery', { callback_query_id: query.id, text: rated ? 'Thanks, noted.' : 'Already handled.' });
        if (rated && query.message) await call('editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      } else if (raw.callback_query) await desk.callback(raw.callback_query, `tg-${raw.update_id}`);
      else await call('sendMessage', { chat_id: owner, text: ledger() });
      await this.ctx.storage.put('offset', raw.update_id + 1);
      return;
    }
    await listener.pollOnce(new TelegramPollingAdapter({ getUpdates: async () => [update] }, offset), 0);
  }

  private async runHarness(command: NonNullable<ReturnType<typeof parseHarnessCommand>>, updateId: number): Promise<string> {
    const { traces, timezone, cards, briefs, nightly, updateCheck } = this.setup();
    if (command.kind === 'trace') return traces.recent(timezone, command.filter);
    if (command.kind === 'e2e') return traces.checklist(timezone);
    if (command.kind === 'usage') return traces.usage();
    if (command.kind === 'langfuse') return this.checkLangfuse();
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

  private async checkLangfuse(): Promise<string> {
    const otlp = langfuseOtlpConfig(this.env);
    if (!otlp) return 'Langfuse is not configured: one of LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY or LANGFUSE_BASE_URL is missing.';
    const exportTurn = otlpTurnExporter(otlp, {
      environment: this.env.WALDO_ENVIRONMENT ?? 'development', release: this.env.WALDO_RELEASE ?? 'unknown',
      channel: 'telegram', userId: 'langfuse-check', sessionId: 'langfuse-check', captureText: false,
    });
    try {
      await exportTurn({ trace: `langfuse-check-${Date.now()}`, hop: 'turn', ms: 1, ok: true, detail: 'owner self-test' });
      return 'Langfuse self-test export accepted. A telegram.turn trace from user langfuse-check should appear within a minute.';
    } catch (error) {
      return `Langfuse self-test failed: ${String(error)}`;
    }
  }

  private setup(): OwnerRuntime {
    if (this.runtime) return this.runtime;
    const { TELEGRAM_BOT_TOKEN: token, OPENAI_API_KEY: key } = this.env;
    const identity = this.ctx.storage.kv;
    const ownerId = identity.get<string>('telegram_subject') ?? this.env.WALDO_OWNER_TELEGRAM_ID;
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
      if (exportTurn) this.ctx.waitUntil(exportTurn(entry).catch((error: unknown) => {
        const note = String(error);
        console.log(JSON.stringify({ trace: entry.trace, hop: 'otlp_export', ok: false, error: note }));
        traces.record({ trace: entry.trace, hop: 'otlp_export', ms: 0, ok: false, error: note }, Date.now());
      }));
    };
    const deps = productionDeps();
    ensureSchema(this.ctx.storage);
    const scheduler = new Scheduler(this.ctx.storage.sql, this.ctx.storage, deps);
    const fallbackZone = this.env.WALDO_OWNER_TIMEZONE ?? 'UTC';
    // Supabase holds the editable settings when configured; the DO applies its copy only after that write lands.
    const saveSettings = async (settings: OwnerSettings): Promise<boolean> => {
      const auth = consoleAuth(this.env);
      const doName = identity.get<string>('do_name');
      return !auth || !doName || auth.saveSettings(doName, settings);
    };
    const clock = { get timezone() { return identity.get<string>('timezone') ?? fallbackZone; }, now: () => new Date() };
    const book = reminderBook(this.ctx.storage.sql, scheduler, clock, () => deps.newRunId().slice(0, 8));
    const call = gatedCaller(createTelegramCaller(token), () => identity.get<boolean>('telegram_unlinked') === true);
    const api = createTelegramOwnerApi(call);
    const storage = this.ctx.storage;
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, TELEGRAM_WEBHOOK_SECRET: stateSecret } = this.env;
    const googleApp = async () => {
      const origin = await storage.get<string>('origin');
      return clientId && clientSecret && origin ? { clientId, clientSecret, redirectUri: `${origin}${GOOGLE_CALLBACK_PATH}` } : null;
    };
    const vault = googleProxy(this.env);
    const vaultOwner = () => identity.get<string>('do_name');
    const stateOwner = () => vaultOwner() ?? String(owner);
    const accounts = async () => (await storage.get<GoogleAccount[]>('google:accounts')) ?? [];
    const health = async () => (await storage.get<Record<string, string>>('google:health')) ?? {};
    const noteHealth = (id: string, error: string) => {
      this.ctx.waitUntil(health().then((all) => {
        const { [id]: _, ...rest } = all;
        return storage.put('google:health', error ? { ...rest, [id]: error } : rest);
      }));
      const doName = vaultOwner();
    };
    const google = {
      // With Supabase configured each account's token goes to Vault and the DO keeps only its connection id.
      // A proxy link carries only the connection id. A raw token is kept here only when no proxy exists.
      async keep(grant: GoogleTokens | LinkGrant): Promise<void> {
        const email = (grant.email ?? 'google').toLowerCase();
        const account: GoogleAccount = 'id' in grant
          ? { id: grant.id, email, scopes: grant.scopes }
          : { id: `local:${email}`, email, scopes: grant.scopes ?? null, refresh_token: grant.refresh_token };
        await storage.put('google:accounts', [...(await accounts()).filter((known) => known.email !== email), account]);
        noteHealth(account.id, '');
      },
      // Tokens saved before multi-account and Vault move into the account list once.
      async migrate(): Promise<void> {
        const linked = await storage.get<{ id: string; email: string | null; scopes: readonly string[] }>('google:connection');
        if (linked) {
          await storage.put('google:accounts', [...(await accounts()).filter((known) => known.id !== linked.id), { id: linked.id, email: linked.email ?? 'google', scopes: linked.scopes }]);
          await storage.delete('google:connection');
        }
        const legacy = await storage.get<GoogleTokens>('google:tokens');
        if (!legacy) return;
        const doName = vaultOwner();
        const adopted = vault && doName ? await vault.adopt(doName, legacy).catch(() => null) : null;
        if (vault && !adopted) return;
        await google.keep(adopted ? { ...adopted, scopes: legacy.scopes ?? LEGACY_GRANT } : { ...legacy, scopes: legacy.scopes ?? LEGACY_GRANT });
        await storage.delete(['google:tokens', 'google:connection']);
        log({ trace: `google:${Date.now()}`, hop: 'google_token_migrated', ms: 0, ok: true, detail: vault ? 'moved to vault' : 'moved to account list' });
      },
      // The first healthy account whose grant covers the feature serves it.
      async client(feature: GoogleFeature = 'calendar') {
        const app = await googleApp();
        if (!app) return null;
        await google.migrate();
        const [all, failing, doName] = [await accounts(), await health(), vaultOwner()];
        const fit = all.filter((account) => googleHas(account.scopes, feature));
        const account = fit.find((candidate) => !failing[candidate.id]) ?? fit[0];
        if (!account) return null;
        if (account.refresh_token) return googleClient(app, { refresh_token: account.refresh_token, email: account.email }, fetch, (error) => noteHealth(account.id, error));
        return vault && doName ? vault.client(doName, account.id, (error) => noteHealth(account.id, error)) : null;
      },
      async state() {
        await google.migrate();
        const failing = await health();
        return (await accounts()).map((account) => ({ id: account.id, email: account.email, error: failing[account.id] ?? null, mail: googleHas(account.scopes, 'mail') }));
      },
      async disconnect(id: string): Promise<boolean> {
        const [all, doName] = [await accounts(), vaultOwner()];
        const account = all.find((known) => known.id === id);
        if (!account) return false;
        if (!id.startsWith('local:') && vault && doName) await vault.revoke(doName, id);
        await storage.put('google:accounts', all.filter((known) => known.id !== id));
        noteHealth(id, '');
        return true;
      },
      async connectUrl(feature: GoogleFeature) {
        const app = await googleApp();
        return app && stateSecret ? googleConsentUrl(app, await oauthState(stateSecret, stateOwner(), Date.now())) : null;
      },
    };
    const desk = approvalDesk(storage.sql, {
      call, owner, google: () => google.client(), newId: () => deps.newRunId().slice(0, 8), now: () => Date.now(),
      timezone: clock.timezone, log,
    });
    const episodes = episodeIndex(storage.sql);
    const kv = durableConversationStore(storage);
    const plans = dayPlanBook(storage.sql);
    const memory = claimStore(storage.sql);
    const copied = backupAndCopySpots(storage.sql, memory, new Date().toISOString());
    if (copied) log({ trace: 'memory:migration', hop: 'memory_backup', ms: 0, ok: true, detail: copied });
    const files = fileBook(storage.sql);
    const loops = loopBook(storage.sql, { newId: () => deps.newRunId().slice(0, 8), now: () => Date.now() });
    const ledger = () => [loopsSection(loops, clock.timezone), desk.ledger(book.list()), proactivityLine(loops.proactivity())].join('\n\n');
    const quiet = () => isQuiet(loops.proactivity(), Date.now(), clock.timezone);
    const download = createTelegramFileDownloader(token);
    const updates = updateBook(storage.sql);
    const ready = Promise.all([backfillEpisodes(kv, episodes), armNightly(scheduler, clock.timezone, Date.now()), armBriefSweep(scheduler, Date.now()), armDayCards(scheduler, plans, clock.timezone, Date.now())])
      .then(([, , , seeded]) => {
        void this.serial(() => migrateCoreFiles('memory:migration'));
        if (seeded) void this.serial(() => planToday('day-plan:boot'));
      });
    const responder = createTelegramResponder(
      key, indexedConversationStore(kv, episodes, () => Date.now()), memory, log,
      { download, transcribe: selectTranscriber(this.env)?.transcribe }, clock, [...reminderHandlers(book), ...googleHandlers(google, desk, clock), searchEpisodesHandler(episodes), ...loopHandlers(loops)], undefined, this.env.WALDO_TOOL_OFFLOAD === '1',
    );
    const migrateCoreFiles = async (trace: string) => {
      const input = pendingCoreFiles(storage.sql, memory);
      if (input === null) return;
      const started = Date.now();
      try {
        const detail = await responder.migrate(trace, input);
        markCoreFilesMigrated(memory, detail, new Date().toISOString());
        log({ trace, hop: 'memory_migration', ms: Date.now() - started, ok: true, detail });
      } catch (error) {
        log({ trace, hop: 'memory_migration', ms: Date.now() - started, ok: false, error: String(error) });
      }
    };
    const listener = new TelegramOwnerListener({
      ownerTelegramId: owner, api, ...responder, log,
      respond: (turn, time) => {
        if (turn.media) files.record(turn.media, turn.text ?? '', Date.now());
        return responder.respond(turn, time);
      },
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
        const said = dayPlanInput({ localNow: localIso(now, clock.timezone), calendar, cards, proactivity: proactivityLine(loops.proactivity()) });
        const applied = await applyDayPlan(scheduler, plans, clock.timezone, now, parseDayPlan(await responder.planDay(trace, said), cards));
        log({ trace, hop: 'day_plan', ms: Date.now() - started, ok: true, detail: applied.map((plan) => `${plan.card}=${plan.time ?? 'skip'} (${plan.reason})`).join('; ') });
      } catch (error) {
        log({ trace, hop: 'day_plan', ms: Date.now() - started, ok: false, error: String(error) });
      }
    };
    const nightly = async (entry: ScheduleEntry) => {
      const trace = `${entry.id}:${entry.occurrence_at}`;
      const started = Date.now();
      await migrateCoreFiles(`${trace}:migration`);
      const day = episodes.since(entry.occurrence_at - 24 * 60 * 60_000, 40_000);
      if (day.length === 0) log({ trace, hop: 'nightly_memory', ms: 0, ok: true, detail: 'quiet day' });
      else {
        try {
          const detail = await responder.consolidate(trace, transcript(day, clock.timezone));
          log({ trace, hop: 'nightly_memory', ms: Date.now() - started, ok: true, detail: `${day.length} turns; ${detail}` });
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
        if (quiet()) {
          log({ trace, hop: 'brief_sweep', ms: 0, ok: true, detail: 'held: quiet hours' });
          return void (await updateCheck(`update:${entry.occurrence_at}`));
        }
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
        const { volume } = loops.proactivity();
        const canSend = sentToday.has('card:brief') && !sentToday.has('card:close') && volume !== 'low' && !quiet();
        let text: string | null = null;
        if (canSend) {
          const said = updateCardPrompt(localIso(now, clock.timezone), { changes: changeLines(changes), ledger: ledger(), feedback: updates.feedback(), volume: volume === 'high' ? 'high' : 'normal' });
          const reply = (await responder.prompt(trace, owner, said, async (hop, work) => work())).trim();
          if (reply && reply !== SKIP_UPDATE) text = reply;
        }
        const id = updates.record(day, now, changes, text);
        if (text) await call('sendMessage', { chat_id: owner, text, reply_markup: { inline_keyboard: [[{ text: 'Useful', callback_data: `fb:${id}:u` }, { text: 'Not useful', callback_data: `fb:${id}:n` }]] } });
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
      if (quiet()) {
        plans.sent(localIso(entry.occurrence_at, clock.timezone).slice(0, 10), card.id);
        return log({ trace, hop: 'day_card', ms: 0, ok: true, detail: `${card.id} held: quiet hours` });
      }
      const client = await google.client();
      const midnight = localToEpoch(`${localIso(now, clock.timezone).slice(0, 10)}T00:00`, clock.timezone);
      const said = await composeDayCard(card, now, clock.timezone, {
        google: client, connectUrl: client ? null : await google.connectUrl('calendar'),
        ledger: ledger(), today: transcript(episodes.since(midnight, 30_000), clock.timezone), updates: updates.unfolded(clock.timezone),
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
    this.runtime = { owner, listener, control: responder.control, api, call, desk, ledger, updates, reminders: book, scheduler, fire, nightly, briefs, cards, updateCheck, traces, log, google,
      view: async (session, notice) => {
        const linked = await google.state();
        const now = Date.now();
        const today = localIso(now, clock.timezone).slice(0, 10);
        const planned = new Map(plans.read(today).map((row) => [row.card, row]));
        const pins = plans.pins();
        return {
          release: this.env.WALDO_RELEASE ?? 'unknown', timezone: clock.timezone, now: localIso(now, clock.timezone).slice(0, 16).replace('T', ' '),
          sessionUntil: localIso(session.expires, clock.timezone).slice(0, 16).replace('T', ' '), csrf: session.csrf, notice,
          google: { accounts: linked, connectAvailable: (await google.connectUrl('calendar')) !== null },
          telegram: { linked: identity.get<boolean>('telegram_unlinked') !== true, unlinkAvailable: consoleAuth(this.env) !== null && identity.get<string>('do_name') !== undefined },
          profile: profile(memory.claims()), spots: memory.claims(), retiredSpots: ['dismissed', 'promoted'].flatMap((status) => memory.claims(status)),
          nodes: memory.nodes(), edges: memory.edges(), barriers: memory.barriers().length,
          cards: DAY_CARDS.map((card) => {
            const row = planned.get(card.id);
            return { id: card.id, name: card.name, defaultTime: card.defaultTime, time: row ? row.time : card.defaultTime, reason: row?.reason ?? 'not planned yet', sent: row?.sent ?? false, pin: pins[card.id] ?? null };
          }),
          ledger: ledger(), proactivity: loops.proactivity(), files: files.list(), steps: traces.steps(clock.timezone), trace: traces.rows(clock.timezone, 60),
        };
      },
      act: async ({ action, id, value }) => {
        const now = Date.now();
        const spotId = Number(id);
        if (action === 'proactivity.set') {
          const [quietStart = '', quietEnd = '', volume = ''] = (value ?? '').split('|');
          const parsed = setProactivityArgsSchema.safeParse({ quiet_start: quietStart || null, quiet_end: quietEnd || null, volume });
          if (!parsed.success || !(await saveSettings({ timezone: clock.timezone, ...parsed.data }))) return false;
          loops.setProactivity(parsed.data);
        } else if (action === 'timezone.set') {
          if (!validZone(value) || !(await saveSettings({ timezone: value, ...loops.proactivity() }))) return false;
          identity.put('timezone', value);
        } else if (action === 'spot.dismiss' || action === 'spot.forget' || action === 'spot.confirm') {
          const claim = memory.claims().find((row) => row.id === spotId);
          if (!claim) return false;
          if (action === 'spot.dismiss') memory.setStatus(spotId, 'dismissed');
          else if (action === 'spot.confirm') memory.confirm(spotId, 'owner, console', new Date(now).toISOString());
          else {
            memory.forget(spotId);
            memory.barrier(claim.text, new Date(now).toISOString());
          }
        } else if (action === 'node.forget') {
          const node = memory.nodes().find((row) => row.id === spotId);
          if (!node) return false;
          memory.forgetNode(spotId);
          memory.barrier(node.label, new Date(now).toISOString());
        } else if (action === 'file.remove') {
          if (!files.remove(spotId)) return false;
        } else if (action === 'google.disconnect') {
          if (!(await google.disconnect(id))) return false;
        } else {
          const card = cardFor(id);
          if (card === null) return false;
          if (action === 'card.unpin') plans.pin(card.id, null);
          else {
            if (!isClock(value)) return false;
            if (action === 'card.pin') plans.pin(card.id, value);
            await applyDayPlan(scheduler, plans, clock.timezone, now, [{ card: card.id, time: value, reason: action === 'card.pin' ? 'pinned by you' : 'set by you for today' }], action === 'card.pin');
          }
        }
        log({ trace: `console:${now}`, hop: 'console_action', ms: 0, ok: true, detail: `${action} ${id}`.trim() });
        return true;
      },
      googleConnectUrl: (feature) => google.connectUrl(feature),
      openFile: async (id) => {
        const file = Number.isInteger(id) ? files.get(id) : null;
        if (!file) return null;
        try {
          return fileResponse(file, await download(file.file_id));
        } catch {
          return null;
        }
      },
      timezone: clock.timezone, ready };
    return this.runtime;
  }
}
