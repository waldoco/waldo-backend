// One synthetic owner's world for a nightly trial: calendar, mail and web data, the production
// memory, loop, episode and conversation modules over in-memory SQLite, and an effect log for
// everything that would leave the owner object (cards, drafts, reminders, standing orders).
// Nothing here reaches Google, a search engine or a real owner. A fresh world per trial.
import { DatabaseSync } from 'node:sqlite';
import { TOOL_PERMISSIONS, triggerTypeSchema, webSearchArgsSchema, type SetReminderArgs, type SetStandingOrderArgs, type WebSearchArgs } from '@waldo/contracts';
import { IsolatedSourceWorld } from '../../scenarios/isolated-source-world';
import { isolatedGoogleClient } from '../../scenarios/isolated-google-client';
import { localIso, reminderHandlers, type ReminderBook } from '../../src/channels/reminders';
import { standingOrderHandlers, type StandingOrder, type StandingOrderBook } from '../../src/channels/standing-orders';
import { loopBook, loopHandlers } from '../../src/channels/loops';
import { episodeIndex, indexedConversationStore } from '../../src/channels/episodes';
import { durableConversationStore } from '../../src/channels/conversation-store';
import { toContextHealthMaterial, type HealthContextRow } from '../../src/channels/health-context';
import { connectServiceHandler, googleHandlers, type EffectDesk, type GoogleAccess } from '../../src/tools/live/google';
import { memoryHandlers } from '../../src/tools/live/memory';
import { searchEpisodesHandler } from '../../src/tools/live/search-episodes';
import { claimStore } from '../../src/memory/claims';
import type { GoogleClient, MailItem, ThreadMessage } from '../../src/connectors/google';
import type { OwnerClock } from '../../src/tools/live/get-context';

export const OWNER = 'eval-owner';
export const OWNER_EMAIL = 'owner@example.com';
export const TIMEZONE = 'Asia/Kolkata';
export const CHAT_REF = 'app-1';

export type SeedEvent = Readonly<{ id: string; title: string; start: string; end: string; all_day?: boolean }>;
export type SeedMail = Readonly<{ id: string; thread_id: string; from: string; to: readonly string[]; subject: string; body: string; at: string }>;
export type SeedWeb = Readonly<{ title: string; url: string; snippet: string }>;
export type WorldSeed = Readonly<{ events?: readonly SeedEvent[]; mail?: readonly SeedMail[]; web?: readonly SeedWeb[] }>;
export type Effect = Readonly<{ kind: string; payload: unknown }>;

const sqlite = (): SqlStorage => {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)) as never[]) as Record<string, unknown>[];
      return { toArray: () => rows, one: () => { if (!rows[0]) throw new Error('no rows'); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator](), columnNames: [], rowsRead: rows.length, rowsWritten: 0, raw: () => rows.map(Object.values)[Symbol.iterator](), next: () => ({ done: true, value: undefined }) };
    },
  } as unknown as SqlStorage;
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

const item = (mail: SeedMail): MailItem => ({ id: mail.id, thread_id: mail.thread_id, from: mail.from, subject: mail.subject, snippet: mail.body.slice(0, 160), at: mail.at });
const message = (mail: SeedMail): ThreadMessage => ({ id: mail.id, from: mail.from, subject: mail.subject, at: mail.at, body: mail.body });

export const evalWorld = (seed: WorldSeed, start: string) => {
  const events = (seed.events ?? []).map((event) => ({ owner_id: OWNER, ...event, all_day: event.all_day ?? false }));
  const mail = [...(seed.mail ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
    draft: async (input) => { effect('mail.draft', input); return { draft_id: nextId('draft') }; },
  };
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

  const sql = sqlite();
  const memory = claimStore(sql);
  const loops = loopBook(sql, { newId: () => nextId('loop'), now });
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
  const handlers = [
    ...googleHandlers(google, desk, clock), connectServiceHandler(google), ...reminderHandlers(reminderBook), ...standingOrderHandlers(standingOrders),
    ...loopHandlers(loops), ...memoryHandlers({ sql, store: memory, conversationRef: CHAT_REF, now: clock.now, hideHistory: async () => undefined }),
    searchEpisodesHandler(episodes), web,
  ];

  // Synthetic zone-level context only, as the owner object's health book supplies it.
  let health: HealthContextRow | null = null;
  const sharedHealth = (): HealthContextRow => ({
    context: {
      id: 'eval-health', day: localIso(now(), TIMEZONE).slice(0, 10),
      form: { score: 48, zone: 'moderate', drivers: ['sleep below baseline'], confidence: 0.8 },
      recovery: { score: 45, zone: 'moderate' }, weight: { score: 70, zone: 'good' },
      drivers: ['sleep below baseline'], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date(now() - 3_600_000).toISOString(),
    },
    previous: null,
  });

  return {
    clock, conversation, memory, handlers,
    health: async () => (health ? toContextHealthMaterial(health, clock) : null),
    shareHealth(shared: boolean) { health = shared ? sharedHealth() : null; },
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
      memory: memory.claims().map((claim) => ({ kind: claim.kind, text: claim.text, status: claim.status })),
    }),
  };
};
export type EvalWorld = ReturnType<typeof evalWorld>;
