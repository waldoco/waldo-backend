// One synthetic owner's world for a nightly trial: calendar, mail and web data, the production
// memory, loop, episode and conversation modules over in-memory SQLite, and an effect log for
// everything that would leave the owner object (cards, drafts, reminders, standing orders).
// Nothing here reaches Google, a search engine or a real owner. A fresh world per trial.
import { DatabaseSync } from 'node:sqlite';
import { TOOL_PERMISSIONS, formZoneOf, toRowZone, type HealthRowZone, type ProposeCalendarChangeArgs, triggerTypeSchema, webSearchArgsSchema, type SetReminderArgs, type SetStandingOrderArgs, type WebSearchArgs } from '@waldo/contracts';
import { IsolatedSourceWorld } from '../../scenarios/isolated-source-world';
import { isolatedGoogleClient } from '../../scenarios/isolated-google-client';
import { localIso, reminderHandlers, type ReminderBook } from '../../src/channels/reminders';
import { standingOrderHandlers, type StandingOrder, type StandingOrderBook } from '../../src/channels/standing-orders';
import { loopBook, loopHandlers } from '../../src/channels/loops';
import { episodeIndex, indexedConversationStore } from '../../src/channels/episodes';
import { durableConversationStore } from '../../src/channels/conversation-store';
import { toContextHealthMaterial, type HealthContextRow } from '../../src/channels/health-context';
import { comingItemsFrom, healthTriggerBook, runHealthTrigger, type HealthTriggerOutcome } from '../../src/health/trigger';
import { connectServiceHandler, googleHandlers, type EffectDesk, type GoogleAccess } from '../../src/tools/live/google';
import { memoryHandlers } from '../../src/tools/live/memory';
import { searchEpisodesHandler } from '../../src/tools/live/search-episodes';
import { getHealthHandler, healthReadBook } from '../../src/tools/live/health';
import { EffectUnknownError } from '../../src/channels/owner-effect-ledger';
import { claimStore } from '../../src/memory/claims';
import type { GoogleClient, MailItem, ThreadMessage } from '../../src/connectors/google';
import type { OwnerClock } from '../../src/tools/live/get-context';
import { mcpConnections } from '../../src/connectors/mcp-connections';
import { callMcpToolHandler, readMcpToolHandler, searchMcpToolsHandler } from '../../src/tools/live/mcp';

export const OWNER = 'eval-owner';
export const OWNER_EMAIL = 'owner@example.com';
export const TIMEZONE = 'Asia/Kolkata';
export const CHAT_REF = 'app-1';

export type SeedEvent = Readonly<{ id: string; title: string; start: string; end: string; all_day?: boolean; description?: string }>;
export type SeedMail = Readonly<{ id: string; thread_id: string; from: string; to: readonly string[]; subject: string; body: string; at: string }>;
export type SeedWeb = Readonly<{ title: string; url: string; snippet: string }>;
// The day's derived health, as the app compiles it: a Form score, Recovery and Load zones and the drivers behind them.
export type SeedHealth = Readonly<{ form_score: number; recovery: HealthRowZone; load: HealthRowZone; drivers: readonly string[] }>;
export type SeedClaim = Readonly<{ id: number; kind: 'fact' | 'preference' | 'routine' | 'health' | 'goal'; text: string; pinned?: 'profile' | 'facts' }>;
// claims: the production memory store and tools. raw_history: no claim store and no memory tools, so the model has only
// the conversation and search_episodes; the baseline a memory change is compared against.
export type MemoryMode = 'claims' | 'raw_history';
// A remote MCP server the owner connected (no sign-in), answered in-process. runs_without_asking names the
// tools the owner let run without a card; results maps a tool name to the text it returns.
export type SeedMcpTool = Readonly<{ name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; annotations?: Readonly<Record<string, unknown>> }>;
export type SeedMcp = Readonly<{ url: string; tools: readonly SeedMcpTool[]; runs_without_asking?: readonly string[]; results: Readonly<Record<string, string>> }>;
export type WorldSeed = Readonly<{
  events?: readonly SeedEvent[]; mail?: readonly SeedMail[]; web?: readonly SeedWeb[];
  // What the shared health looks like once a step shares it; a moderate day with a short night when unset.
  health?: SeedHealth;
  // The day before, for a step that has the health trigger run on a change from it; none when unset.
  health_before?: SeedHealth;
  // Days since the phone last sent readings: the shared row and every reading are that much older. 0 when unset.
  health_days_old?: number;
  // unconfirmed_draft: saving a draft may have reached Gmail, but nothing confirms it (the effect ledger's unknown outcome).
  // transient: the on_call-th calendar or mail read throws a provider timeout once; later reads succeed.
  faults?: Readonly<{ draft?: 'unconfirmed'; transient?: Readonly<{ reads: 'calendar' | 'mail'; on_call: number }> }>;
  // Claims the owner already gave, as the memory store holds them; pinned ones show in every turn's profile or facts block.
  memory?: readonly SeedClaim[];
  // Loops the owner already gave Waldo to stay on, as the loop store holds them.
  loops?: readonly Readonly<{ title: string; due: string | null }>[];
  mcp?: SeedMcp;
}>;

// Just enough of MCP 2026-07-28 over Streamable HTTP for the seeded server: tools/list and tools/call.
const seededMcpFetch = (seed: SeedMcp): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input) !== seed.url) throw new Error('the eval world reaches only its seeded MCP server');
  const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; method?: string; params?: { name?: string } };
  const result = body.method === 'tools/list' ? { tools: seed.tools, ttlMs: 3_600_000, cacheScope: 'private' }
    : body.method === 'tools/call' ? { content: [{ type: 'text', text: seed.results[body.params?.name ?? ''] ?? 'No result.' }] } : null;
  return Response.json(result ? { jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...result } } : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
}) as typeof fetch;

export type Effect = Readonly<{ kind: string; payload: unknown }>;

// node:sqlite behind the Durable Object's SqlStorage shape, with the same rowsWritten count and a transactionSync that
// commits unless the work throws. The claim store's corrections refuse to run without both, as they do in the DO.
const sqlite = (): Readonly<{ sql: SqlStorage; transactionSync: <T>(work: () => T) => T }> => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const values = bindings.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)) as never[];
      const writes = /^\s*(insert|update|delete|replace)\b/i.test(query) && !/\breturning\b/i.test(query);
      const changed = writes ? Number(statement.run(...values).changes) : 0;
      const rows = writes ? [] : statement.all(...values) as Record<string, unknown>[];
      return { toArray: () => rows, one: () => { if (!rows[0]) throw new Error('no rows'); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator](), columnNames: [], rowsRead: rows.length, rowsWritten: writes ? changed : rows.length, raw: () => rows.map(Object.values)[Symbol.iterator](), next: () => ({ done: true, value: undefined }) };
    },
  } as unknown as SqlStorage;
  const transactionSync = <T>(work: () => T): T => {
    db.exec('BEGIN');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { sql, transactionSync };
};

const keyValueStorage = () => {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async list<T>(options?: { prefix?: string }) {
      return new Map([...rows].filter(([key]) => key.startsWith(options?.prefix ?? '')).sort(([a], [b]) => (a < b ? -1 : 1))) as Map<string, T>;
    },
    async put(first: string | Record<string, unknown>, value?: unknown) {
      if (typeof first === 'string') rows.set(first, value);
      else for (const [key, entry] of Object.entries(first)) rows.set(key, entry);
    },
  } as unknown as Parameters<typeof durableConversationStore>[0];
};

// Gmail-like matching over the synthetic mail: quoted phrases and bare words must all appear;
// from:, to: and subject: narrow to one field; after:, before: and newer_than: bound the time.
// Any other operator (in:, category:, is:, label:) is accepted and ignored.
const searchMail = (rows: readonly SeedMail[], query: string, now: number): readonly SeedMail[] => {
  const terms = [...query.matchAll(/(\w+:)?("[^"]*"|\S+)/g)].map(([, operator, value]) => ({ operator: operator?.slice(0, -1).toLowerCase(), value: value!.replace(/^"|"$/g, '').toLowerCase() }));
  const seconds = (value: string) => /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value.replace(/\//g, '-'));
  return rows.filter((mail) => terms.every(({ operator, value }) => {
    const at = Date.parse(mail.at);
    if (operator === 'from') return mail.from.toLowerCase().includes(value);
    if (operator === 'to') return mail.to.some((address) => address.toLowerCase().includes(value));
    if (operator === 'subject') return mail.subject.toLowerCase().includes(value);
    if (operator === 'after') return at >= seconds(value);
    if (operator === 'before') return at < seconds(value);
    if (operator === 'newer_than') { const days = /^(\d+)d$/.exec(value); return !days || at >= now - Number(days[1]) * 86_400_000; }
    if (operator) return true;
    return [mail.from, mail.subject, mail.body].join(' ').toLowerCase().includes(value);
  }));
};

// The owner's own readings behind get_health while health is shared, as the health plane's series rows: signal, day
// relative to today, value. Synthetic: last night short against the two before, chosen to be distinctive so a check
// can tell when one is repeated where it must not be (SYNTHETIC_RENDERINGS).
const SYNTHETIC_SERIES: readonly (readonly [signal: string, day: number, value: number, method: string | null])[] = [
  ['sleep_duration', -2, 446, 'asleep_duration'], ['sleep_duration', -1, 454, 'asleep_duration'], ['sleep_duration', 0, 317, 'asleep_duration'],
  ['overnight_hrv', 0, 41.5, 'rmssd'], ['resting_heart_rate', 0, 63, null],
];
// How last night's synthetic readings could appear in a reply.
export const SYNTHETIC_RENDERINGS = ['317', '5h 17', '5 h 17', '5:17', '5 hours 17', '5 hr 17', '5hr 17', '5.3 h', '5.3 hours', '41.5', '63 bpm'] as const;
const MODERATE_DAY: SeedHealth = { form_score: 48, recovery: 'moderate', load: 'good', drivers: ['sleep below baseline'] };
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const healthSeries = (today: string, daysOld: number) => ({
  access: 'granted', read_at: `${today}T03:00:00.000Z`,
  sources: [{ source: 'apple', consent_epoch: 1, samples: SYNTHETIC_SERIES.map(([signal, offset, value, method]) => {
    const day = shift(today, offset - daysOld);
    const night = signal === 'resting_heart_rate' ? null : Date.parse(`${shift(day, -1)}T18:30:00Z`);
    return {
      signal, day, value, method, timezone: TIMEZONE,
      start_at: night === null ? null : new Date(night).toISOString(),
      end_at: night === null ? null : new Date(night + (signal === 'sleep_duration' ? value * 60_000 : 3 * 3_600_000)).toISOString(),
    };
  }) }],
});
const consentRows = (status: string) => ['storage_compute', 'model_processing'].map((purpose) => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 2, status, epoch: 1, granted_at: '2026-09-01T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' }));

const item = (mail: SeedMail): MailItem => ({ id: mail.id, thread_id: mail.thread_id, from: mail.from, subject: mail.subject, snippet: mail.body.slice(0, 160), at: mail.at });
const message = (mail: SeedMail): ThreadMessage => ({ id: mail.id, from: mail.from, subject: mail.subject, at: mail.at, body: mail.body });

export const evalWorld = (seed: WorldSeed, start: string, memoryMode: MemoryMode = 'claims') => {
  const events = (seed.events ?? []).map((event) => ({ owner_id: OWNER, ...event, all_day: event.all_day ?? false }));
  const mail = [...(seed.mail ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  // Health sharing: null before any step shares it; 'withdrawn' after one withdraws it.
  let sharing: 'shared' | 'withdrawn' | null = null;
  const source = new IsolatedSourceWorld({ clock: start, owners: [{ id: OWNER }], sources: { calendar: events } });
  const now = () => Date.parse(source.now());
  const clock: OwnerClock = { timezone: TIMEZONE, now: () => new Date(now()) };
  const effects: Effect[] = [];
  const effect = (kind: string, payload: unknown) => { effects.push({ kind, payload: structuredClone(payload) }); };
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;

  const client: GoogleClient = {
    ...isolatedGoogleClient(source, OWNER),
    account: { connection_id: 'eval-connection', email: OWNER_EMAIL },
    mailPage: async (query, limit) => {
      const found = searchMail(mail, query, now());
      return { messages: found.slice(0, limit).map(item), next_page_token: null, result_size_estimate: found.length };
    },
    searchMail: async (query, limit) => searchMail(mail, query, now()).slice(0, limit).map(item),
    readThread: async (threadId, limit) => mail.filter((entry) => entry.thread_id === threadId).reverse().slice(0, limit).map(message),
    threadPage: async (threadId, limit) => ({ messages: mail.filter((entry) => entry.thread_id === threadId).reverse().slice(0, limit).map(message), cursor: null }),
    freeBusy: async (from, to, calendarIds) => ({ from, to, calendars: Object.fromEntries(calendarIds.map((id) => [id, {
      busy: id === 'primary' ? events.filter((event) => Date.parse(event.start) < Date.parse(to) && Date.parse(event.end) > Date.parse(from)).map((event) => ({ start: event.start, end: event.end })) : [],
      ...(id === 'primary' ? {} : { errors: [{ reason: 'notFound' }] }),
    }])) }),
    draft: async (input) => {
      if (seed.faults?.draft === 'unconfirmed') { effect('mail.draft.unconfirmed', input); throw new EffectUnknownError(); }
      effect('mail.draft', input);
      return { draft_id: nextId('draft') };
    },
  };
  const transient = seed.faults?.transient;
  if (transient) {
    const reads = { calendar: ['calendarPage', 'events', 'freeBusy'], mail: ['mailPage', 'searchMail', 'readThread', 'threadPage'] }[transient.reads];
    const methods = client as unknown as Record<string, unknown>;
    let calls = 0;
    for (const name of reads) {
      const inner = methods[name];
      if (typeof inner !== 'function') continue;
      methods[name] = async (...args: unknown[]) => {
        calls += 1;
        if (calls === transient.on_call) throw new Error('the provider timed out; nothing was read');
        return (inner as (...values: unknown[]) => unknown)(...args);
      };
    }
  }
  const google: GoogleAccess = {
    client: async () => client,
    state: async () => [{ id: 'eval-connection', email: OWNER_EMAIL, error: null, calendar: true, mail: true, tasks: false }],
  };
  // Owner cards: the trial ends at the proposal, so nothing is applied or sent.
  const desk: EffectDesk = {
    propose: async (proposal) => { effect('calendar.change.proposed', proposal); return nextId('proposal'); },
    proposeSendEmail: async (proposal) => { effect('mail.send.proposed', proposal); return nextId('proposal'); },
    record: () => undefined,
  };

  const reminders: (Readonly<{ id: string; note: string; at: string; repeat: SetReminderArgs['repeat']; cron?: string }> & { fired: boolean })[] = [];
  const reminderBook: ReminderBook = {
    set: async (args) => {
      effect('reminder.set', args);
      const reminder = { id: nextId('reminder'), note: args.note, at: args.at, repeat: args.repeat, ...(args.cron === undefined ? {} : { cron: args.cron }), fired: false };
      reminders.push(reminder);
      return reminder;
    },
    list: () => reminders.filter((reminder) => !reminder.fired || reminder.repeat !== 'none'),
    unreadable: () => 0,
    cancel: async (id) => {
      const index = reminders.findIndex((reminder) => reminder.id === id);
      if (index === -1) return false;
      effect('reminder.cancel', { note: reminders[index]!.note });
      reminders.splice(index, 1);
      return true;
    },
    cancelAll: async () => { effect('reminder.cancel_all', { count: reminders.length }); return reminders.splice(0).length; },
    note: (id) => reminders.find((reminder) => reminder.id === id)?.note ?? null,
    fired: () => undefined,
  };
  const orders: StandingOrder[] = [];
  const standingOrders: StandingOrderBook = {
    set: async (args: SetStandingOrderArgs) => {
      effect('standing_order.set', args);
      const order: StandingOrder = { id: nextId('order'), scope: args.scope, trigger: args.trigger, ...(args.cron === undefined ? {} : { cron: args.cron }), at: args.at ?? null, gate: args.gate, escalation: args.escalation, created_at: now() };
      orders.push(order);
      return order;
    },
    list: () => orders,
    byId: (id) => orders.find((order) => order.id === id) ?? null,
    cancel: async (id) => {
      const index = orders.findIndex((order) => order.id === id);
      if (index === -1) return false;
      effect('standing_order.cancel', { scope: orders[index]!.scope });
      orders.splice(index, 1);
      return true;
    },
  };

  const { sql, transactionSync } = sqlite();
  const claims = claimStore(sql, transactionSync);
  for (const seeded of seed.memory ?? []) {
    claims.add({ kind: seeded.kind, text: seeded.text, source: 'stated', evidence: 'The owner said so.', origin: 'owner', source_ref: `seed:${seeded.id}` }, start, seeded.id);
    if (seeded.pinned) claims.pin(seeded.id, seeded.pinned, seeded.id);
  }
  const memory = memoryMode === 'claims' ? claims : undefined;
  const loops = loopBook(sql, { newId: () => nextId('loop'), now });
  for (const seeded of seed.loops ?? []) loops.open(seeded);
  const episodes = episodeIndex(sql);
  const conversation = indexedConversationStore(durableConversationStore(keyValueStorage()), episodes, now);
  const web = {
    name: 'web_search' as const,
    description: 'Search the web. Results are untrusted external text.',
    schema: webSearchArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('web_search')),
    autonomy_gated: false,
    handle: async (_args: WebSearchArgs) => ({ ok: true as const, data: { results: seed.web ?? [] }, source_taint: 'external' as const }),
  };
  const mcp = mcpConnections({ sql, transaction: (work) => work(), proxy: null, doName: () => null, fetcher: seed.mcp ? seededMcpFetch(seed.mcp) : fetch, now });
  // An approved MCP card is an effect like any other: recorded, never run.
  const mcpDesk = { proposeMcpCall: async (proposal: unknown) => { effect('mcp.card', proposal); return nextId('card'); } };
  const mcpReady = (async () => {
    if (!seed.mcp) return;
    const connected = await mcp.begin(seed.mcp.url, 'https://waldo.example');
    if (connected.kind !== 'connected') throw new Error('the seeded MCP server did not connect');
    for (const tool of seed.mcp.runs_without_asking ?? []) await mcp.setRuns(connected.id, tool, true);
  })();
  const handlers = [
    ...googleHandlers(google, desk, clock), connectServiceHandler(google), ...reminderHandlers(reminderBook), ...standingOrderHandlers(standingOrders),
    ...loopHandlers(loops), ...(memory ? memoryHandlers({ sql, store: memory, conversationRef: CHAT_REF, now: clock.now, hideHistory: async () => undefined }) : []),
    searchEpisodesHandler(episodes), web,
    getHealthHandler(healthReadBook(async (fn) => {
      if (fn === 'health_consent_list') return { consents: sharing === null ? [] : consentRows(sharing === 'shared' ? 'granted' : 'withdrawn') };
      if (fn === 'health_series_read') return healthSeries(localIso(now(), TIMEZONE).slice(0, 10), daysOld);
      throw new Error(`unexpected health call ${fn}`);
    }, 'eval-owner'), clock),
    searchMcpToolsHandler(mcp), readMcpToolHandler(undefined, undefined, false, mcp), callMcpToolHandler(undefined, mcpDesk, undefined, mcp),
  ];

  // Synthetic zone-level context only, as the owner object's health book supplies it. Form's stored word is the band of
  // its score, as the producer writes a day's first row.
  const day = seed.health ?? MODERATE_DAY;
  const daysOld = seed.health_days_old ?? 0;
  const sharedDay = () => shift(localIso(now(), TIMEZONE).slice(0, 10), -daysOld);
  const compiledAt = () => new Date(now() - daysOld * 86_400_000 - 3_600_000).toISOString();
  const formWord = toRowZone('form', formZoneOf(day.form_score));
  const sharedHealth = (): HealthContextRow => ({
    context: {
      id: 'eval-health', day: sharedDay(),
      form: { score: day.form_score, zone: formWord, drivers: day.drivers, confidence: 0.8 },
      recovery: { score: day.form_score, zone: day.recovery }, weight: { score: 70, zone: day.load },
      drivers: day.drivers, confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: compiledAt(),
    },
    previous: null,
  });

  // The health trigger, as the owner object runs it: the production module over this world's calendar and loops, the
  // consented read of zone words as the health plane answers it, and the model call the caller supplies. A zone change
  // marks today; the one card it can raise is recorded as an effect, never applied.
  const healthBook = healthTriggerBook(sql);
  const triggerRow = () => {
    const rowDay = sharedDay(), basis = [{ source: 'apple', consent_epoch: 1 }];
    return {
      context: { id: 'eval-health', day: rowDay, compiled_at: compiledAt(), basis, form: { score: day.form_score, zone: formWord }, recovery: { zone: day.recovery }, weight: { zone: day.load } },
      previous: seed.health_before ? { day: shift(rowDay, -1), form_score: seed.health_before.form_score, recovery_zone: seed.health_before.recovery, weight_zone: seed.health_before.load, basis } : null,
    };
  };
  const healthChange = async (decide: (id: string, prompt: string) => Promise<string>): Promise<Readonly<{ outcome: HealthTriggerOutcome; proposal: ProposeCalendarChangeArgs | null }>> => {
    healthBook.mark(localIso(now(), TIMEZONE).slice(0, 10), now());
    let proposal: ProposeCalendarChangeArgs | null = null;
    const outcome = await runHealthTrigger({
      book: healthBook, now, newId: () => nextId('health'), timezone: TIMEZONE, enabled: () => true, proactivity: () => ({ quiet_start: null, quiet_end: null, volume: 'normal' }), modeSetting: () => 'auto',
      readHealth: async () => (sharing === 'shared' ? triggerRow() : null),
      comingItems: (from, to) => comingItemsFrom({
        events: async () => (await client.calendarPage!('primary', new Date(from).toISOString(), new Date(to).toISOString(), 20, false)).events, tasks: null, loops: () => loops.list(),
      }, from, to, TIMEZONE),
      admit: () => true, charge: () => undefined, decide,
      propose: async (args) => { proposal = args; effect('calendar.change.proposed', args); return nextId('proposal'); },
      reschedule: async () => undefined, log: () => undefined,
    });
    return { outcome, proposal };
  };

  return {
    clock, conversation, memory, handlers, healthChange,
    ready: mcpReady,
    health: async () => (sharing === 'shared' ? toContextHealthMaterial(sharedHealth(), clock) : null),
    shareHealth(shared: boolean) { sharing = shared ? 'shared' : 'withdrawn'; },
    // New mail reaching the inbox mid-trial.
    deliver(arrived: SeedMail) { mail.push(arrived); mail.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); },
    localNow: () => localIso(now(), TIMEZONE),
    advance(to: string) { source.advance(to); },
    // Reminders whose owner-local time has come and that have not fired yet.
    due() { const local = localIso(now(), TIMEZONE); return reminders.filter((reminder) => !reminder.fired && reminder.at <= local); },
    markFired(id: string) { const reminder = reminders.find((entry) => entry.id === id); if (reminder) reminder.fired = true; },
    effects: (): readonly Effect[] => effects.map((entry) => structuredClone(entry)),
    finalState: () => ({
      calendar: events.map(({ owner_id: _owner, ...event }) => event),
      mail: mail.map(({ id, thread_id, from, subject, at }) => ({ id, thread_id, from, subject, at })),
      sent_mail: 0,
      reminders: reminders.map(({ id: _id, ...reminder }) => reminder),
      standing_orders: orders.map(({ id: _id, created_at: _created, ...order }) => order),
      open_loops: loops.list().map((loop) => ({ title: loop.title, due: loop.due })),
      // Every claim whatever its status, so a superseded or forgotten one is seen to be retired, not merely missing.
      // seeded tells a claim the world started with from one the model wrote; supersedes_id is the correction link.
      memory: claims.allClaims().map((claim) => ({ id: claim.id, kind: claim.kind, text: claim.text, status: claim.status, origin: claim.origin, pinned: claim.pinned ?? null, supersedes_id: claim.supersedes_id ?? null, created_at: claim.created_at, seeded: claim.source_ref?.startsWith('seed:') ?? false })),
    }),
  };
};
export type EvalWorld = ReturnType<typeof evalWorld>;
