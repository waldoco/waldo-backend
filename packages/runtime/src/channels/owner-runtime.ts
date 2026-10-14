import type { LLMAttachment } from '@waldo/contracts';
import type { SurfacePresentation } from '../prompt/messaging-behavior';
import { surfaceChatRef } from '../context-composer/owner-turn';
import { consoleAuth, presenceRecheck } from '../identity/console-auth';
import { signedRpc } from '../identity/owner-directory';
import { claimStore } from '../memory/claims';
import { langfuseOtlpConfig, otlpTurnExporter } from '../observability/otlp-turns';
import { enrichOwnerTrace } from '../observability/owner-trace-identity';
import { gateTraceEntry, resolveCaptureText } from '../observability/trace-privacy';
import { receiptUrl } from '../conversation/artifact-link-guard';
import { persistTransportWake } from '../scheduler/alarm-slot';
import { Scheduler } from '../scheduler/multiplexer';
import { productionDeps } from '../seams/deps';
import { healthReadBook } from '../tools/live/health';
import { ensureSchema } from '../tracer/schema';
import { selectTranscriber } from '../llm/transcriber';
import { artifactExports, exportArtifactHandler, r2ArtifactBinaries } from './artifact-exports';
import { exportDownloadUrl } from './artifact-export-download';
import { artifactBook, inMemoryArtifactBodies, r2ArtifactBodies } from './artifacts';
import { runBook } from './background-runs';
import type { ConsoleLinkRoute } from './console-link';
import { durableConversationStore } from './conversation-store';
import { dayPlanBook } from './day-cards';
import { egressGuardedCaller } from './egress-guard';
import { episodeIndex } from './episodes';
import { fileBook } from './files';
import { traceBook } from './harness';
import { healthContextBook } from './health-context';
import { healthLogBook } from './health-log';
import { loopBook, isQuiet } from './loops';
import type { OwnerContextIntegration, OwnerJobHost, OwnerSkillHost, createOwnerResponder } from './owner-turn';
import { ownerEffectLedger } from './owner-effect-ledger';
import { ownerTurnTrace, type OwnerTurnEnvelope } from './owner-turn-envelope';
import type { ProbeCaptureSlot } from './probe-turn';
import { reminderBook } from './reminders';
import type { RunEffectScope } from './run-effect-scope';
import { schedulePreferences } from './schedule-preferences';
import { standingOrderBook } from './standing-orders';
import { TelegramFinalOutbox } from './telegram-final-outbox';
import { createTelegramOwnerApi, egressGate, gatedCaller, type createTelegramCaller } from './telegram-api';
import type { TelegramOwnerApi, TelegramOwnerListenerOptions, TurnLogEntry, TurnTimer } from './telegram-listener';
import { loadTelegramMedia, type MediaReaders, type TelegramFileDownloader } from './telegram-media';
import type { TelegramInboundTurn } from './telegram-polling';
import type { InboxRecord } from './telegram-owner-inbox';
import type { TelegramWebhookEnv } from './telegram-webhook';

export type ChannelKind = 'telegram' | 'whatsapp' | 'app' | 'imessage';
type Caller = ReturnType<typeof createTelegramCaller>;
type Kv = DurableObjectStorage['kv'];

// What the owner object hands every builder: its storage, its environment and the run in flight. Surfaces read the
// occurrence each one admitted through it; nothing here is a surface.
export type OwnerCoreHost = Readonly<{ env: TelegramWebhookEnv; storage: DurableObjectStorage; doId: string; currentRunRef(): string | undefined }>;

// Everything an owner's runtime needs that does not depend on the surface a turn came in on, built once per owner object
// over its one SQLite: the books, the stores, the effect ledger and the clock. No member captures an identity: each reads
// the directory binding at the time it acts.
export const ownerCore = (host: OwnerCoreHost) => {
  const { env, storage } = host;
  const identity = storage.kv;
  const deps = productionDeps();
  const traces = traceBook(storage.sql);
  ensureSchema(storage);
  const scheduler = new Scheduler(storage.sql, storage, deps);
  const finalOutbox = new TelegramFinalOutbox(storage.kv, deps.now, (rows, due) => persistTransportWake(storage, rows, due));
  const fallbackZone = env.WALDO_OWNER_TIMEZONE ?? 'UTC';
  const clock = { get timezone() { return identity.get<string>('timezone') ?? fallbackZone; }, now: () => new Date(deps.now()) };
  const shortId = () => deps.newRunId().slice(0, 8);
  const reminders = reminderBook(storage.sql, scheduler, clock, shortId);
  const effects = ownerEffectLedger(storage, () => deps.now(), host.currentRunRef);
  const episodes = episodeIndex(storage.sql);
  const conversations = durableConversationStore(storage);
  const plans = dayPlanBook(storage.sql);
  const memory = claimStore(storage.sql, (work) => storage.transactionSync(work));
  const files = fileBook(storage.sql);
  const loops = loopBook(storage.sql, { newId: shortId, now: () => Date.now() });
  const schedPrefs = schedulePreferences(storage.sql, loops);
  const orders = standingOrderBook(storage.sql, scheduler, clock, shortId);
  // Working-artifact bodies ride R2 when the binding exists; a deploy missing it keeps them in this object's memory
  // (artifacts become session-scoped, turns never crash).
  const artifactBodies = env.ARTIFACTS ? r2ArtifactBodies(env.ARTIFACTS, host.doId) : inMemoryArtifactBodies();
  const artifacts = artifactBook(storage.sql, artifactBodies, clock, shortId);
  // PDF export is registered only where files are durable (R2 bound) and the owner-session download route can serve them.
  const exportTool = env.ARTIFACTS ? [exportArtifactHandler(
    artifactExports(storage.sql, artifacts, artifactBodies, r2ArtifactBinaries(env.ARTIFACTS, host.doId), clock, () => crypto.randomUUID()),  // full uuid: the export id is part of the link
    async id => exportDownloadUrl(await storage.get<string>('origin') ?? null, id))] : [];
  const runs = runBook(storage.sql, clock, shortId);
  const quiet = () => isQuiet(loops.proactivity(), Date.now(), clock.timezone);
  return Object.freeze({ deps, traces, scheduler, finalOutbox, clock, reminders, effects, episodes, conversations, plans, memory, files, loops, schedPrefs, orders,
    artifactBodies, artifacts, exportTool, runs, quiet });
};
export type OwnerCore = ReturnType<typeof ownerCore>;

// What a surface's turn needs from the owner object beyond the core: the occurrence each lane admitted, the run in flight,
// and the object's own owner-turn helpers. Built once per object; every member reads live state.
export type SurfaceHost = OwnerCoreHost & Readonly<{
  waitUntil(work: Promise<unknown>): void;
  serial<T>(work: () => Promise<T>): Promise<T>;
  activeInbox(): InboxRecord | null;
  activeScope(): RunEffectScope | undefined;
  activeApp(): import('./app-inbox').AppInboxRecord | null;
  activeIMessage(): import('./imessage/owner-inbox').IMessageInboxRecord | null;
  scheduledAppDelivery(): ((text: string) => Promise<string>) | null;
  imessageHost(): import('./imessage/owner-runtime').OwnerHost;
  appInbox(): import('./app-inbox').AppInbox;
  appContext(name: string, hash: string, text: string, occurrence: string, occurredAt: number, scope: RunEffectScope, sources?: import('../context-composer/owner-turn').OwnerContextSources): Promise<import('../context-composer/owner-turn').OwnerContextCapability>;
  logSkippedLoad(skipped: import('../conversation/canonical-owner-store').CanonicalSkipped): void;
  jobHostFor(chain: OwnerJobHost['chain']): OwnerJobHost;
  closeRunAtomic(run: InboxRecord, reason: string, awaitingDelivery?: boolean): void;
  browserTrial: import('./browser-trial-consent').BrowserTrialPreparation | undefined;
  browserAttachments(scope?: RunEffectScope): readonly LLMAttachment[];
}>;

type OwnerApiMethod = keyof TelegramOwnerApi;

// A surface as data: what it presents, which transport methods it really carries, and how its owner is named. The static
// half is read without building a runtime (offsets, the cache key).
export type SurfaceDescriptor = Readonly<{
  name: ChannelKind;
  presentation: SurfacePresentation;
  // Replies never use Telegram transport, commands or reactions.
  native: boolean;
  offsetKey: string;
  healthSource: 'telegram' | 'whatsapp' | 'console';
  // The owner-API methods the transport carries. The runtime never hands it any other.
  transport: readonly OwnerApiMethod[];
  // The provider the directory's presence recheck asks about before every send; absent where the turn's own admission
  // is the only send authority.
  presence?: 'telegram' | 'whatsapp';
  // Approved sends go out verbatim through the channel the proposal names: through this surface's own transport when
  // the proposal names it (sendsOwn), and through this surface's runtime when another surface decided (sendTarget).
  sendsOwn: boolean;
  sendTarget: boolean;
  // The surface whose desk rules this surface's turns use.
  deskSurface: 'telegram' | 'whatsapp' | 'app';
  owner(identity: Kv, env: TelegramWebhookEnv): number;
}>;

// The per-runtime parts a surface's hosts close over.
export type SurfaceTurnParts = Readonly<{
  owner: number;
  log(entry: TurnLogEntry): void;
  api: TelegramOwnerApi;
  routedCall: Caller;
  probeCapture: ProbeCaptureSlot;
  turnReceiptUrls: Map<string, Set<string>>;
  core: OwnerCore;
  healthContext: ReturnType<typeof healthContextBook>;
  ownerProfile(): Promise<string | null>;
}>;
// Today's book of reviewed skills, scoped to one turn; each surface's skill host binds it to the occurrence it admitted.
export type CuratedSkills = (turn: OwnerTurnEnvelope, skillOwner: string, custodyFallback: string, scope: RunEffectScope, assertDispatch: () => Promise<void>, admission?: import('../identity/owner-message-admission').OwnerMessageAdmission) => import('../skills/curated-host').OwnerSkillCapability;

export type SurfaceAdapter = SurfaceDescriptor & Readonly<{
  // Throws when this deploy lacks the surface's transport configuration.
  assertConfigured(): void;
  caller(): Caller;
  // The inbox occurrences an owner trace is matched against to name the verified owner.
  traceOccurrences(): readonly InboxRecord[];
  download: TelegramFileDownloader;
  consoleLink(parts: Pick<SurfaceTurnParts, 'owner' | 'routedCall'>): ConsoleLinkRoute;
  // Set where the chat has no connect button: what the model is told instead, and no link is minted or sent.
  connectGuidance?: string;
  // Binds a turn to the occurrence this surface admitted. The returned check throws ClosedRunError once the turn, the
  // occurrence, the run or the owner binding it was bound to has changed.
  ownerIdentity?(turn: OwnerTurnEnvelope, scope: RunEffectScope, owner: number): () => Promise<void>;
  skillHost?(parts: SurfaceTurnParts, curated: CuratedSkills): OwnerSkillHost;
  context(parts: SurfaceTurnParts): OwnerContextIntegration;
  queueFinal?(parts: SurfaceTurnParts): NonNullable<TelegramOwnerListenerOptions['queueFinal']>;
}>;
export type SurfaceModule = Readonly<{ descriptor: SurfaceDescriptor; surfaceAdapter(host: SurfaceHost): SurfaceAdapter }>;

// A turn belongs to a surface only when it says it came in there; every surface's identity check starts here.
export const turnOnSurface = (turn: OwnerTurnEnvelope, name: ChannelKind): boolean => turn.surface === name;

// The owner API a surface really has: a method its transport does not carry resolves with no call made.
export const surfaceApi = (transport: readonly OwnerApiMethod[], call: Caller): TelegramOwnerApi => {
  const api = createTelegramOwnerApi(call);
  const skipped = async () => undefined;
  return {
    sendMessage: transport.includes('sendMessage') ? api.sendMessage : skipped,
    setMessageReaction: transport.includes('setMessageReaction') ? api.setMessageReaction : skipped,
    sendChatAction: transport.includes('sendChatAction') ? api.sendChatAction : skipped,
  };
};

// The surface half of an owner runtime: who the owner is on this surface, the egress-gated transport, the trace log and
// the health books that read under the owner's directory name.
export const createSurfaceRuntime = ({ core, adapter, host }: Readonly<{ core: OwnerCore; adapter: SurfaceAdapter; host: SurfaceHost }>) => {
  const { env, storage } = host;
  const identity = storage.kv;
  const channel = adapter.name;
  const owner = adapter.owner(identity, env);
  adapter.assertConfigured();
  const openaiApiKey = env.OPENAI_API_KEY;
  if (!openaiApiKey) throw new Error('owner runtime is unconfigured');
  const { deps, traces, clock } = core;
  const otlp = langfuseOtlpConfig(env);
  // Traces are filed under the verified owner principal once an owner turn has resolved it, else under the chat.
  let tracePrincipal: string | undefined;
  const exportTurn = otlp ? otlpTurnExporter(otlp, {
    environment: env.WALDO_ENVIRONMENT ?? 'development', release: env.WALDO_RELEASE ?? 'unknown',
    channel, userId: () => tracePrincipal ?? (owner > 0 ? `${channel}:${owner}` : `${channel}:unlinked`), sessionId: owner > 0 ? `${channel}-dm:${owner}` : `${channel}-dm:unlinked`,
    captureText: resolveCaptureText(env),
  }) : undefined;
  const captureText = resolveCaptureText(env);
  const turnReceiptUrls = new Map<string, Set<string>>();
  const log = (entry: TurnLogEntry) => {
    if (entry.principal !== undefined) { const { principal, ...rest } = entry; tracePrincipal = principal; entry = rest; }
    if ((!entry.trace.startsWith('tg-') || host.activeInbox()?.updateId === Number(entry.trace.slice(3))) && (entry.hop === 'tool_create_artifact' || entry.hop === 'tool_revise_artifact')) {
      try {
        const url = receiptUrl(entry.hop.slice(5), JSON.parse(entry.text?.output ?? 'null'));
        if (url) { const urls = turnReceiptUrls.get(entry.trace) ?? new Set<string>(); urls.add(url); turnReceiptUrls.set(entry.trace, urls); }
      } catch { /* malformed output grants no receipt */ }
    }
    // The historical owner label reaches the DO trace table; canonical ID/email also reach Worker logs and OTLP.
    // The gate runs once here so free-form detail/error text reaches none of the sinks while
    // the capture switch is off; whitelisted hops keep their count/enum detail either way.
    const enriched: TurnLogEntry = gateTraceEntry(enrichOwnerTrace(entry, adapter.traceOccurrences(), identity.get<string>('do_name') ?? '', String(owner)), captureText);
    traces.record(enriched, deps.now());
    console.log(JSON.stringify({ ...enriched, text: undefined }));
    if (exportTurn) host.waitUntil(exportTurn(enriched).catch((error: unknown) => {
      const note = String(error);
      const failed: TurnLogEntry = gateTraceEntry({ trace: enriched.trace, hop: 'otlp_export', ms: 0, ok: false, error: note, code: 'export_failed', owner: enriched.owner,
        owner_id: enriched.owner_id, owner_email: enriched.owner_email, owner_identity: enriched.owner_identity }, captureText);
      console.log(JSON.stringify({ ...failed, text: undefined }));
      traces.record(failed, deps.now());
    }));
  };
  const healthLogs = healthLogBook(signedRpc(env), identity.get<string>('do_name') ?? null, adapter.healthSource, clock, (error) =>
    log({ trace: `health:${channel}`, hop: 'health_log', ms: 0, ok: false, error: String(error) }),
  );
  const healthRead = healthReadBook(signedRpc(env), identity.get<string>('do_name') ?? null);
  // D5: derived health context for the system prompt's health material (zones only). Read
  // failures degrade to absence and log; they never block the turn.
  const healthContext = healthContextBook(signedRpc(env), identity.get<string>('do_name') ?? null, clock,
    (error, trace) => log({ trace: trace ?? `health:${channel}`, hop: 'health_context', ms: 0, ok: false, error: String(error), code: 'read_failed' }),
    (present, trace) => log({ trace: trace ?? `health:${channel}`, hop: 'health_context', ms: 0, ok: true, code: present ? 'present' : 'absent' }),
  );
  const egressDoName = identity.get<string>('do_name');
  const egressSubject = identity.get<string>(`${channel}_subject`);
  const call = egressGuardedCaller(
    gatedCaller(adapter.caller(), egressGate(
      () => owner === 0 ? 'owner_unbound' : identity.get<boolean>(`${channel}_unlinked`) === true ? 'unlinked' : false,
      adapter.presence ? presenceRecheck(consoleAuth(env), egressDoName, adapter.presence, egressSubject) : undefined,
    )),
    (count, method) => log({ trace: 'egress', hop: 'egress_redacted', ms: 0, ok: true, detail: `${method}: ${count} link(s)` }),
  );
  // Staging probe capture: while a capture-mode /probe-turn runs inside the serial queue,
  // outbound Telegram calls land in the probe response instead of the Bot API. Inert otherwise.
  const probeCapture: ProbeCaptureSlot = { current: null };
  // Codex #230/#231 holds: confinement slot for capture-mode probe turns (memory persistence
  // and live provider tools stay unreachable from synthetic owner-authority text).
  const probeGuard = { suppressMemory: false, stripLiveTools: false };
  const routedCall: typeof call = (method, request) =>
    probeCapture.current === null ? call(method, request) : probeCapture.current.record(method, request);
  const api = surfaceApi(adapter.transport, routedCall);
  // A blocked send (unlinked or rebound owner) returns no message. A producer must not record that as sent, completed or folded.
  const sentOrThrow = async (sending: Promise<unknown>) => { const sent = await sending; if (sent === undefined) throw new Error('telegram send blocked'); return sent; };
  return Object.freeze({ openaiApiKey, owner, log, call, routedCall, api, probeCapture, probeGuard, sentOrThrow, turnReceiptUrls, healthLogs, healthRead, healthContext,
    media: { download: adapter.download, transcribe: selectTranscriber(env)?.transcribe } });
};

// The surface's form of an inbound turn: the envelope the core reads, presented as this surface declares.
export const surfaceTurnEnvelope = (turn: TelegramInboundTurn, presentation: SurfacePresentation): OwnerTurnEnvelope => ({
  traceId: ownerTurnTrace(presentation.surface, turn.updateId),
  conversationRef: surfaceChatRef(presentation.surface, turn.chatId),
  surface: presentation.surface,
  presentation,
  text: turn.text,
  parts: turn.parts,
  ...(turn.runScope ? { runScope: turn.runScope } : {}),
  ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
});

// The owner responder as one surface's listener and jobs call it: turns arrive in the surface's shape with its media
// resolved through the surface's readers, and jobs name the owner's chat by its id on that surface.
export const surfaceResponder = (core: ReturnType<typeof createOwnerResponder>, presentation: SurfacePresentation, readers: MediaReaders = {}) => {
  const surface = presentation.surface;
  const envelope = (turn: TelegramInboundTurn) => surfaceTurnEnvelope(turn, presentation);
  const respond: TelegramOwnerListenerOptions['respond'] = async (turn, time) => {
    turn.runScope?.admit();
    const media = turn.media ? await time('media', () => loadTelegramMedia(turn.media!, readers)) : undefined;
    turn.runScope?.admit();
    return core.respond({ ...envelope(turn), parts: [...turn.parts, ...(media?.parts ?? [])], ...(media?.attachment ? { attachment: media.attachment } : {}) }, time);
  };
  return {
    ...core, respond,
    chooseReaction: (turn: TelegramInboundTurn) => core.chooseReaction(envelope(turn)),
    remind: (id: string, chatId: number, note: string, time: TurnTimer) => core.remind(id, surfaceChatRef(surface, chatId), note, time, surface),
    prompt: (id: string, chatId: number, said: string, time: TurnTimer, toolNames?: Parameters<typeof core.prompt>[5], current?: Parameters<typeof core.prompt>[6], decision?: Parameters<typeof core.prompt>[7], turnContext?: string, sourceTaint?: Parameters<typeof core.prompt>[9]) => core.prompt(id, surfaceChatRef(surface, chatId), said, time, surface, toolNames, current, decision, turnContext, sourceTaint),
  };
};
