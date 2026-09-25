// L1 scenario runner: drives the real telegram responder with the scripted gateway over
// in-memory sqlite, captures the full hop stream, and checks the scenario's assertions exactly.
import { DatabaseSync } from 'node:sqlite';
import { TOOL_PERMISSIONS, triggerTypeSchema, webSearchArgsSchema, WALDO_CHAT_MODEL, type ConnectIntent, type WebSearchArgs } from '@waldo/contracts';
import { createTelegramResponder } from '../src/channels/telegram-turn';
import { reminderHandlers, type ReminderBook } from '../src/channels/reminders';
import { loopBook, loopHandlers } from '../src/channels/loops';
import { googleHandlers } from '../src/tools/live/google';
import { claimStore } from '../src/memory/claims';
import { episodeIndex } from '../src/channels/episodes';
import { searchEpisodesHandler } from '../src/tools/live/search-episodes';
import type { GoogleClient } from '../src/connectors/google';
import type { TurnLogEntry } from '../src/channels/telegram-listener';
import type { OwnerClock } from '../src/tools/live/get-context';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import type { Scenario } from './types';

const sqlite = (): SqlStorage => {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)) as never[]) as Record<string, unknown>[];
      return { toArray: () => rows, one: () => { if (!rows[0]) throw new Error('no rows'); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator](), columnNames: [], rowsRead: rows.length, rowsWritten: 0, raw: () => rows.map(Object.values)[Symbol.iterator](), next: () => ({ done: true, value: undefined }) };
    },
  } as unknown as SqlStorage;
};

const CLOCK: OwnerClock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-24T09:00:00+05:30') };

const DEFAULT_EVENTS = [
  { id: 'e1', title: 'Standup', start: '2026-09-24T10:00:00+05:30', end: '2026-09-24T10:15:00+05:30', all_day: false },
  { id: 'e2', title: 'Lunch with Arjun', start: '2026-09-24T13:00:00+05:30', end: '2026-09-24T14:00:00+05:30', all_day: false },
  { id: 'e3', title: 'Dentist', start: '2026-09-24T17:30:00+05:30', end: '2026-09-24T18:15:00+05:30', all_day: false },
];

type StubReminder = Readonly<{ id: string; note: string; at: string; repeat: 'none' | 'daily' }>;

export type ScenarioRun = Readonly<{
  replies: readonly string[];
  entries: readonly TurnLogEntry[];
  tools: readonly string[];
  reminders: readonly StubReminder[];
  connectOffers: readonly ConnectIntent[];
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
    async set(args: { note: string; at: string; repeat?: 'none' | 'daily' }) {
      const reminder = { id: `reminder:${reminderRows.length + 1}`, note: args.note, at: args.at, repeat: args.repeat ?? 'none' as const };
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
    note: (id: string) => reminderRows.find((reminder) => reminder.id === id)?.note ?? null,
    fired: () => undefined,
  } as unknown as ReminderBook;

  const events = scenario.fixtures?.events ?? DEFAULT_EVENTS;
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
  const handlers = [...reminderHandlers(reminders), ...googleHandlers(google as never, { propose: async () => 'proposal:1', proposeSendEmail: async () => 'proposal:1', record: () => undefined }, CLOCK), ...loopHandlers(loops), searchEpisodesHandler(episodeIndex(sql)), web];
  const responder = createTelegramResponder('scenario-key', undefined, memory, log, {}, CLOCK, handlers as never, WALDO_CHAT_MODEL, false, undefined, async (intent: ConnectIntent) => { connectOffers.push(intent); return true; }, scriptedGateway({ rules: scenario.llm }));
  const time = async <T>(_hop: string, work: () => Promise<T>) => work();

  const replies: string[] = [];
  let n = 0;
  for (const turn of scenario.turns) {
    n += 1;
    // A hard deny or exhausted fallback throws out of the responder; the DO turns that into the
    // honest failure text. Record the throw so degradation scenarios can assert on it.
    const turnText = async () => {
      if (turn.startsWith('@plan ')) return responder.planDay(`${scenario.id}-${n}`, turn.slice(6));
      if (turn.startsWith('@prompt ')) return responder.prompt(`${scenario.id}-${n}`, 1, turn.slice(8), time);
      if (turn.startsWith('@remind ')) return responder.remind(`${scenario.id}-${n}`, 1, turn.slice(8), time);
      return responder.respond({ updateId: n, chatId: 1, text: turn } as never, time);
    };
    try {
      replies.push(await turnText());
    } catch (error) {
      replies.push(`[threw] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Let the post-turn memory writer settle so its hop lands before assertions run.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const tools = entries.filter((entry) => entry.hop.startsWith('tool_')).map((entry) => entry.hop.slice(5));
  return { replies, entries, tools, reminders: reminderRows, connectOffers };
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
    if (want.note && !matches.some((entry) => want.note!.test(entry.error ?? entry.detail ?? ''))) {
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
  for (const state of assert.state ?? []) {
    if (state.kind === 'reminder_count' && run.reminders.length !== state.equals) {
      failures.push(`expected ${state.equals} reminders, have ${run.reminders.length}`);
    }
    if (state.kind === 'reminder_note' && !run.reminders.some((reminder) => state.matches.test(reminder.note))) {
      failures.push(`no reminder note matched ${state.matches}`);
    }
  }
  return failures;
};
