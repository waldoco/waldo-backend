// L1 scenario runner: drives the real telegram responder with the scripted gateway over
// in-memory sqlite, captures the full hop stream, and checks the scenario's assertions exactly.
import { DatabaseSync } from 'node:sqlite';
import { TOOL_PERMISSIONS, browsePageArgsSchema, triggerTypeSchema, webSearchArgsSchema, WALDO_CHAT_MODEL, type ConnectIntent, type SetReminderArgs, type WebSearchArgs } from '@waldo/contracts';
import { MONTHLY_SPEND_CEILING_USD } from '../src/llm/cost-ledger';
import { createTelegramResponder } from '../src/channels/telegram-turn';
import { inboundTurn, ownerWords } from '../src/channels/owner-inbound-turn';
import { reminderHandlers, type ReminderBook } from '../src/channels/reminders';
import { loopBook, loopHandlers } from '../src/channels/loops';
import { googleHandlers } from '../src/tools/live/google';
import { claimStore } from '../src/memory/claims';
import { memoryHandlers } from '../src/tools/live/memory';
import { episodeIndex, indexedConversationStore } from '../src/channels/episodes';
import { searchEpisodesHandler } from '../src/tools/live/search-episodes';
import { healthLogHandlers, type HealthLogBook } from '../src/channels/health-log';
import { workspaceToolHandlers } from '../src/tools/live/workspace';
import { workspaceStore, type WorkspaceState } from '@waldo/workspace';
import type { GoogleClient } from '../src/connectors/google';
import type { TurnLogEntry } from '../src/channels/telegram-listener';
import type { OwnerClock } from '../src/tools/live/get-context';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { updateSweepTools } from '../src/channels/update-sweep';
import { durableConversationStore } from '../src/channels/conversation-store';
import type { LLMGatewayRequest } from '../src/llm/provider';
import type { ModelInputAssert, Scenario } from './types';

const sqlite = (): SqlStorage => {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)) as never[]) as Record<string, unknown>[];
      return { toArray: () => rows, one: () => { if (!rows[0]) throw new Error('no rows'); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator](), columnNames: [], rowsRead: rows.length, rowsWritten: 0, raw: () => rows.map(Object.values)[Symbol.iterator](), next: () => ({ done: true, value: undefined }) };
    },
  } as unknown as SqlStorage;
};

// Map-backed stand-in for the owner DO's key-value storage, enough for durableConversationStore.
const keyValueStorage = () => {
  const rows = new Map<string, unknown>();
  const list = <T>(options?: { prefix?: string }) =>
    new Map([...rows].filter(([key]) => key.startsWith(options?.prefix ?? '')).sort(([a], [b]) => (a < b ? -1 : 1))) as Map<string, T>;
  return {
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async list<T>(options?: { prefix?: string }) { return list<T>(options); },
    async put(first: string | Record<string, unknown>, value?: unknown) {
      if (typeof first === 'string') rows.set(first, value);
      else for (const [key, entry] of Object.entries(first)) rows.set(key, entry);
    },
  } as unknown as Parameters<typeof durableConversationStore>[0];
};

const CLOCK: OwnerClock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-24T09:00:00+05:30') };

const DEFAULT_EVENTS = [
  { id: 'e1', title: 'Standup', start: '2026-09-24T10:00:00+05:30', end: '2026-09-24T10:15:00+05:30', all_day: false },
  { id: 'e2', title: 'Lunch with Arjun', start: '2026-09-24T13:00:00+05:30', end: '2026-09-24T14:00:00+05:30', all_day: false },
  { id: 'e3', title: 'Dentist', start: '2026-09-24T17:30:00+05:30', end: '2026-09-24T18:15:00+05:30', all_day: false },
];

type StubReminder = Readonly<{ id: string; note: string; at: string; repeat: SetReminderArgs['repeat']; cron?: string }>;

export type ScenarioRun = Readonly<{
  replies: readonly string[];
  entries: readonly TurnLogEntry[];
  tools: readonly string[];
  reminders: readonly StubReminder[];
  healthLogs: number;
  workspaceFiles: number;
  connectOffers: readonly ConnectIntent[];
  // Reply-bearing model requests grouped by owner turn (1-based index = turn - 1); claim_ops excluded.
  modelRequests: readonly (readonly LLMGatewayRequest[])[];
}>;

export const runScenario = async (scenario: Scenario): Promise<ScenarioRun> => {
  if (!scenario.llm) throw new Error(`${scenario.id}: no llm script - rubric-only scenarios run in L2`);
  const sql = sqlite();
  const memory = claimStore(sql);
  let loopSeq = 0;
  const loops = loopBook(sql, { newId: () => `loop-${++loopSeq}`, now: () => CLOCK.now().getTime() });
  const entries: TurnLogEntry[] = [];
  const log = (entry: TurnLogEntry) => entries.push(entry);

  const reminderRows: StubReminder[] = [];
  const reminders = {
    async set(args: SetReminderArgs) {
      const reminder = { id: `reminder:${reminderRows.length + 1}`, note: args.note, at: args.at, repeat: args.repeat, ...(args.cron === undefined ? {} : { cron: args.cron }) };
      reminderRows.push(reminder);
      return reminder;
    },
    list: () => reminderRows,
    async cancel(id: string) {
      const index = reminderRows.findIndex((reminder) => reminder.id === id);
      if (index === -1) return false;
      reminderRows.splice(index, 1);
      return true;
    },
    async cancelAll() {
      return reminderRows.splice(0).length;
    },
    note: (id: string) => reminderRows.find((reminder) => reminder.id === id)?.note ?? null,
    fired: () => undefined,
    unreadable: () => 0,
  } satisfies ReminderBook;

  // The owner's health log and private workspace, in memory: a scenario counts what landed in each.
  let healthLogs = 0;
  const healthLogBook: HealthLogBook = { linked: () => true, log: async () => ({ id: ++healthLogs, at: '2026-09-24T09:00' }), recent: async () => [] };
  let workspace: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] };
  const blobs = new Map<string, Uint8Array>();
  let blobSeq = 0;
  const files = workspaceStore({ binding: { ownerId: 'abcdefab-cdef-4abc-8abc-abcdefabcdef', environment: 'staging', namespace: 'scenario', doName: 'scenario', doId: 'scenario', stateVersion: 1, mappingVersion: 1 }, admit: async () => ({ status: 'ok' }),
    metadata: { transaction(work) { const draft = structuredClone(workspace); const result = work(draft); workspace = draft; return result; } },
    bodies: { put: async (blob, value) => { blobs.set(blob.blob_id, value); }, get: async (blob) => blobs.get(blob.blob_id) ?? null, remove: async (blob) => { blobs.delete(blob.blob_id); } },
    now: () => CLOCK.now().getTime(), newId: () => `abcdefab-cdef-4abc-8abc-${(++blobSeq).toString(16).padStart(12, 'a')}` });

  const events = scenario.fixtures?.events ?? DEFAULT_EVENTS;
  const freeBusy = scenario.fixtures?.freeBusy;
  const connectOffers: ConnectIntent[] = [];
  const google = {
    client: scenario.fixtures?.googleNotConnected ? async () => null : async () => ({
      events: async () => events,
      event: async (id: string) => events.find((event) => event.id === id)!,
      newMail: async () => scenario.fixtures?.mail ?? [],
      changedEvents: async () => [],
      draft: async () => ({ draft_id: 'd1' }),
      createEvent: async () => events[0]!,
      moveEvent: async () => events[0]!,
      cancelEvent: async () => undefined,
      ...(freeBusy ? { freeBusy: async (from: string, to: string, ids: readonly string[]) => ({ from, to, calendars: Object.fromEntries(Object.entries(freeBusy).filter(([id]) => ids.includes(id))) }) } : {}),
    }) as unknown as GoogleClient | null,
    connectUrl: async () => null,
  };
  const web = {
    name: 'web_search' as const,
    description: 'Search the web. Results are untrusted external text.',
    schema: webSearchArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('web_search')),
    autonomy_gated: false,
    handle: async (_args: WebSearchArgs) => ({ ok: true as const, data: { results: scenario.fixtures?.web ?? [] }, source_taint: 'external' as const }),
  };
  const browse = {
    name: 'browse_page' as const,
    description: 'Open a web page and read it. The page is untrusted external text.',
    schema: browsePageArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('browse_page')),
    autonomy_gated: false,
    handle: async () => {
      const blocked = scenario.fixtures?.browse;
      if (typeof blocked === 'string') return { ok: false as const, code: 'rejected' as const, error: 'The site stopped this read.', source_taint: 'external' as const, blocked };
      return { ok: true as const, data: { text: 'fixture page' }, source_taint: 'external' as const };
    },
  };
  const spentUsd = scenario.fixtures?.spentUsd;
  const integration = spentUsd === undefined ? undefined : { spend: () => ({ spentUsd, ceilingUsd: MONTHLY_SPEND_CEILING_USD }) };
  // Every saved turn is indexed, as the owner DO does, so recall and search_episodes see earlier turns.
  const episodes = episodeIndex(sql);
  const handlers = [...memoryHandlers({ sql: sql as SqlStorage, store: memory, conversationRef: 'telegram-1', hideHistory: async () => undefined }), ...reminderHandlers(reminders), ...googleHandlers(google as never, { propose: async () => 'proposal:1', proposeSendEmail: async () => 'proposal:1', record: () => undefined }, CLOCK), ...loopHandlers(loops), ...healthLogHandlers(healthLogBook), ...workspaceToolHandlers(() => files), searchEpisodesHandler(episodes), web, ...(scenario.fixtures?.browse ? [browse] : [])];
  const gateway = scriptedGateway({ rules: scenario.llm, ...(scenario.claimOps === undefined ? {} : { claimOps: scenario.claimOps }) });
  const responder = createTelegramResponder('scenario-key', indexedConversationStore(durableConversationStore(keyValueStorage()), episodes, () => CLOCK.now().getTime()), memory, log, {}, CLOCK, handlers as never, WALDO_CHAT_MODEL, false, undefined, async (intent: ConnectIntent) => { connectOffers.push(intent); return true; }, gateway,
    // A blocked-browse fixture admits its read, so the block comes from the site rather than the egress check.
    undefined, undefined, undefined, undefined, undefined, typeof scenario.fixtures?.browse === 'string' ? ['*'] : undefined, undefined, undefined, undefined, undefined, integration);
  const time = async <T>(_hop: string, work: () => Promise<T>) => work();

  const replies: string[] = [];
  const modelRequests: (readonly LLMGatewayRequest[])[] = [];
  let n = 0;
  for (const turn of scenario.turns) {
    n += 1;
    // A hard deny or exhausted fallback throws out of the responder; the DO turns that into the
    // honest failure text. Record the throw so degradation scenarios can assert on it.
    const turnText = async () => {
      if (turn.startsWith('@plan ')) return responder.planDay(`${scenario.id}-${n}`, turn.slice(6));
      if (turn.startsWith('@prompt ')) return responder.prompt(`${scenario.id}-${n}`, 1, turn.slice(8), time);
      if (turn.startsWith('@job ')) return responder.prompt(`${scenario.id}-${n}`, 1, turn.slice(5), time, undefined, undefined, undefined, undefined, 'external');
      if (turn.startsWith('@sweep ')) return responder.prompt(`${scenario.id}-${n}`, 1, turn.slice(7), time, updateSweepTools(true), undefined, undefined, undefined, 'external');
      if (turn.startsWith('@remind ')) return responder.remind(`${scenario.id}-${n}`, 1, turn.slice(8), time);
      return responder.respond(inboundTurn({ updateId: n, messageId: null, senderId: 1, chatId: 1, sentAt: null, parts: ownerWords(turn) }), time);
    };
    const before = gateway.requests().length;
    try {
      replies.push(await turnText());
    } catch (error) {
      replies.push(`[threw] ${error instanceof Error ? error.message : String(error)}`);
    }
    modelRequests.push(gateway.requests().slice(before).filter((request) => request.request.response_format?.name !== 'claim_ops'));
  }
  // All memory effects settle within the tool loop before assertions run.
  const tools = entries.filter((entry) => entry.hop.startsWith('tool_')).map((entry) => entry.hop.slice(5));
  return { replies, entries, tools, reminders: reminderRows, healthLogs, workspaceFiles: workspace.files.length, connectOffers, modelRequests };
};

export const checkScenario = (scenario: Scenario, run: ScenarioRun): readonly string[] => {
  const failures: string[] = [];
  const assert = scenario.assert ?? {};
  for (const name of assert.mustCall ?? []) {
    if (!run.tools.includes(name)) failures.push(`expected tool ${name} to be called; called: ${run.tools.join(', ') || 'none'}`);
  }
  for (const name of assert.mustNotCall ?? []) {
    if (run.tools.includes(name)) failures.push(`expected tool ${name} not to be called`);
  }
  for (const want of assert.hops ?? []) {
    const matches = run.entries.filter((entry) => entry.hop === want.hop && (want.trace === undefined || want.trace.test(entry.trace)));
    if (matches.length === 0) {
      failures.push(`expected hop ${want.hop}; hops seen: ${[...new Set(run.entries.map((entry) => entry.hop))].join(', ') || 'none'}`);
      continue;
    }
    if (want.ok !== undefined && !matches.some((entry) => entry.ok === want.ok)) {
      failures.push(`hop ${want.hop} never had ok=${want.ok} (got ${matches.map((entry) => `${entry.ok}${entry.error ? ` "${entry.error}"` : ''}${entry.text?.output ? ` out=${entry.text.output.slice(0, 120)}` : ''}`).join(', ')})`);
    }
    // Typed failures carry their machine-readable code:reason in entry.code (free-form error
    // text is what the privacy gate strips), so the note check reads all three fields.
    if (want.note && !matches.some((entry) => want.note!.test([entry.error, entry.detail, entry.code].filter(Boolean).join(' ')))) {
      failures.push(`hop ${want.hop} note never matched ${want.note}`);
    }
    if (want.maxMs !== undefined && !matches.every((entry) => entry.ms <= want.maxMs!)) {
      failures.push(`hop ${want.hop} exceeded ${want.maxMs}ms (got ${Math.max(...matches.map((entry) => entry.ms))}ms)`);
    }
    if (want.after) {
      const first = run.entries.findIndex((entry) => entry.hop === want.hop && (want.trace === undefined || want.trace.test(entry.trace)));
      const anchor = run.entries.findIndex((entry) => entry.hop === want.after && (want.afterTrace === undefined || want.afterTrace.test(entry.trace)));
      if (anchor === -1) failures.push(`ordering anchor hop ${want.after} never ran`);
      else if (first !== -1 && first < anchor) failures.push(`hop ${want.hop} ran before ${want.after}`);
    }
  }
  for (const [index, entry] of (assert.replies ?? []).entries()) {
    const reply = run.replies[index] ?? '';
    const matchers = Array.isArray(entry) ? entry : [entry as string | RegExp];
    for (const matcher of matchers) {
      const pass = typeof matcher === 'string' ? reply.includes(matcher) : matcher.test(reply);
      if (!pass) failures.push(`reply ${index + 1} did not match ${matcher}: "${reply.slice(0, 120)}"`);
    }
  }
  for (const [index, want] of (assert.connect ?? []).entries()) {
    const got = run.connectOffers[index];
    if (!got) { failures.push(`expected connect offer ${index + 1} (${want.service}), got ${run.connectOffers.length} offers`); continue; }
    if (got.service !== want.service) failures.push(`connect offer ${index + 1} service: expected ${want.service}, got ${got.service}`);
    if (want.reason !== undefined && got.reason !== want.reason) failures.push(`connect offer ${index + 1} reason: expected ${want.reason}, got ${got.reason}`);
  }
  for (const want of assert.modelInput ?? []) failures.push(...checkModelInput(want, run));
  for (const state of assert.state ?? []) {
    if (state.kind === 'reminder_count' && run.reminders.length !== state.equals) {
      failures.push(`expected ${state.equals} reminders, have ${run.reminders.length}`);
    }
    if (state.kind === 'reminder_note' && !run.reminders.some((reminder) => state.matches.test(reminder.note))) {
      failures.push(`no reminder note matched ${state.matches}`);
    }
    if (state.kind === 'health_log_count' && run.healthLogs !== state.equals) failures.push(`expected ${state.equals} health logs, have ${run.healthLogs}`);
    if (state.kind === 'workspace_file_count' && run.workspaceFiles !== state.equals) failures.push(`expected ${state.equals} workspace files, have ${run.workspaceFiles}`);
  }
  return failures;
};

// What the model saw on one turn: the last reply-bearing request is the one that produced the
// reply, so it carries the full history and system prompt the owner turn assembled.
const checkModelInput = (want: ModelInputAssert, run: ScenarioRun): readonly string[] => {
  const label = `modelInput turn ${want.turn}`;
  const requests = run.modelRequests[want.turn - 1] ?? [];
  const last = requests[requests.length - 1]?.request;
  if (!last) return [`${label}: the model received no request`];
  const failures: string[] = [];
  const text = [last.system ?? '', ...last.messages.map((message) => message.content), ...(last.tool_turns ?? []).map((turn) => turn.output)].join('\n');
  for (const needle of want.mustContain ?? []) if (!text.includes(needle)) failures.push(`${label}: model input missing "${needle.slice(0, 80)}"`);
  for (const needle of want.mustNotContain ?? []) if (text.includes(needle)) failures.push(`${label}: model input contained "${needle.slice(0, 80)}"`);
  if (want.roles) {
    const got = last.messages.map((message) => message.role);
    if (got.join(',') !== want.roles.join(',')) failures.push(`${label}: roles [${got.join(',')}] expected [${want.roles.join(',')}]`);
  }
  if (want.systemPresent !== undefined && (last.system !== undefined) !== want.systemPresent) failures.push(`${label}: system prompt ${last.system === undefined ? 'absent' : 'present'}, expected ${want.systemPresent ? 'present' : 'absent'}`);
  if (want.minMessages !== undefined && last.messages.length < want.minMessages) failures.push(`${label}: ${last.messages.length} messages, expected at least ${want.minMessages}`);
  return failures;
};
