import { z } from 'zod';
import {
  formZoneSchema, fromRowZone, goalState, recoveryZoneSchema, reviewExperimentArgsSchema, setExperimentArgsSchema, setQuestArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  EXPERIMENT_DAYS_DEFAULT, type Experiment, type ExperimentWindow, type GoalState, type ReviewExperimentArgs, type ReviewExperimentResult, type SetExperimentArgs,
  type SetExperimentResult, type SetQuestArgs, type SetQuestResult, type ToolHandler,
} from '@waldo/contracts';
import { APP_QUESTS_MAX_V1, type AppQuestV1 } from '../../../contracts/src/app/controls';
import { EXPERIMENTS_TABLE_SCHEMA, GOAL_QUEST_COLUMNS, HEY144_GOALS_SCHEMA_MIGRATION } from '../do-schema';
import { HEALTH_SPAN_MARKER, numericHealthIn } from '../scribe/sanitiser';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';
import type { CardId } from '../prompt/day-cards';
import { turnReadOutside } from './approvals';
import { localIso } from './reminders';

// Quests (ADR-0064 GoalRecord, as amended for health quests): goals the owner chose to work toward with Waldo, kept in the
// goals table. The owner starts and changes them in chat; the Brief plans the day around the active ones and the Close checks
// in on those whose pace has come round. Whether a check-in has anything to say is the model's call.
type Sql = Pick<SqlStorage, 'exec'>;
type Row = {
  id: string; description: string; baseline: string | null; target: string | null; progress: string | null; deadline: string | null;
  active: number; plan: string | null; state: GoalState | null; check_in_days: number | null; last_check_in_at: string | null; created_at: string; updated_at: string;
};
type ExperimentRow = {
  id: string; quest_id: string; change: string; days: number; started_on: string; state: Experiment['state']; reason: string | null; decided_on: string | null;
  offered_at: string | null; created_at: string; updated_at: string;
};
// An experiment as the owner turn and the Close read it: offered once a Close offering its verdict reached the owner.
export type ExperimentNote = Readonly<{ experiment: Experiment; offered: boolean }>;

// Every open quest rides each owner turn and the Brief and Close, so their number is bounded.
export const QUESTS_OPEN_MAX = 12;
const COMPLETED_SHOWN_MS = 30 * 86_400_000;

export type QuestBook = Readonly<{
  set(args: SetQuestArgs, userId: string): SetQuestResult | string;
  open(): readonly AppQuestV1[];
  // What the app lists: the open quests and those completed in the last 30 days.
  shown(): readonly AppQuestV1[];
  // Active quests whose next check-in is today or earlier, in the owner's local days.
  due(): readonly AppQuestV1[];
  // Once the Close reached the owner: counts each quest as checked in, and each experiment whose verdict it offered as offered.
  checkedIn(questIds: readonly string[], verdictsOffered?: readonly string[]): void;
  today(): string;
  startExperiment(questId: string, change: string, days: number): SetExperimentResult | string;
  decideExperiment(id: string, state: 'kept' | 'dropped' | 'stopped', reason: string | null): SetExperimentResult | string;
  experiment(id: string): Experiment | null;
  // The running experiment and the two latest verdicts in a quest.
  experimentsIn(questId: string): readonly ExperimentNote[];
  // Running experiments whose trial has ended and whose verdict no Close has offered yet.
  verdictsDue(): readonly Experiment[];
}>;

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// Owner text rides prompts one quest per line, so a line break never reaches the store.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const questBook = (sql: Sql, clock: OwnerClock, newId: () => string): QuestBook => {
  for (const statement of HEY144_GOALS_SCHEMA_MIGRATION.up) sql.exec(statement);
  const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(goals)').toArray().map(row => row.name));
  for (const [column, ddl] of GOAL_QUEST_COLUMNS) if (!columns.has(column)) sql.exec(ddl);
  for (const statement of EXPERIMENTS_TABLE_SCHEMA) sql.exec(statement);
  const today = (): string => localIso(clock.now().getTime(), clock.timezone).slice(0, 10);
  const experimentView = (row: ExperimentRow): Experiment => ({
    id: row.id, quest_id: row.quest_id, change: row.change, state: row.state, started_on: row.started_on, days: row.days,
    ends_on: addDays(row.started_on, row.days - 1), reason: row.reason, decided_on: row.decided_on,
  });
  const experimentRow = (id: string): ExperimentRow | undefined => sql.exec<ExperimentRow>('SELECT * FROM experiments WHERE id = ?', id).toArray()[0];
  const ended = (row: ExperimentRow): boolean => row.state === 'running' && addDays(row.started_on, row.days - 1) < today();
  const unoffered = (): ExperimentRow[] => sql.exec<ExperimentRow>("SELECT * FROM experiments WHERE state = 'running' AND offered_at IS NULL ORDER BY created_at, id").toArray().filter(ended);

  const dayOf = (iso: string): string => localIso(Date.parse(iso), clock.timezone).slice(0, 10);
  const view = (row: Row): AppQuestV1 => {
    const state = goalState({ active: row.active === 1, ...(row.state ? { state: row.state } : {}) });
    return {
      id: row.id, title: row.description, state, plan: row.plan, usual: row.baseline, target: row.target, progress: row.progress,
      deadline: row.deadline?.slice(0, 10) ?? null, check_in_days: row.check_in_days,
      next_check_in: state === 'active' && row.check_in_days !== null ? addDays(dayOf(row.last_check_in_at ?? row.created_at), row.check_in_days) : null,
    };
  };
  const rows = (): Row[] => sql.exec<Row>('SELECT * FROM goals ORDER BY created_at, id').toArray();
  const open = (): AppQuestV1[] => rows().map(view).filter(quest => quest.state !== 'completed');
  return {
    set(args, userId) {
      const now = clock.now().toISOString();
      const before = args.id === undefined ? undefined : sql.exec<Row>('SELECT * FROM goals WHERE id = ?', args.id).toArray()[0];
      if (args.id !== undefined && !before) return 'No quest has that id. Use an id from the quests list, or leave id out to start a new one.';
      const state = args.state ?? (before ? view(before).state : 'active');
      if (state !== 'completed' && (!before || view(before).state === 'completed') && open().length >= QUESTS_OPEN_MAX)
        return `The owner already has ${QUESTS_OPEN_MAX} open quests. Ask which one to complete or drop first.`;
      const text = (given: string | null | undefined, kept: string | null): string | null => given === undefined ? kept : given === null ? null : oneLine(given);
      // A deadline is the owner's calendar day, kept at UTC midnight so a move to another zone never shifts it.
      const deadline = args.deadline === undefined ? before?.deadline ?? null : args.deadline === null ? null : `${args.deadline}T00:00:00Z`;
      const values = [
        text(args.title, before?.description ?? null), text(args.usual, before?.baseline ?? null), text(args.target, before?.target ?? null),
        text(args.progress, before?.progress ?? null), deadline, state === 'completed' ? 0 : 1, text(args.plan, before?.plan ?? null), state,
        args.check_in_days === undefined ? before?.check_in_days ?? null : args.check_in_days,
      ];
      const id = before?.id ?? `quest:${newId()}`;
      if (before) sql.exec('UPDATE goals SET description = ?, baseline = ?, target = ?, progress = ?, deadline = ?, active = ?, plan = ?, state = ?, check_in_days = ?, updated_at = ? WHERE id = ?', ...values, now, id);
      else sql.exec('INSERT INTO goals (description, baseline, target, progress, deadline, active, plan, state, check_in_days, id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...values, id, userId, now, now);
      // A finished quest leaves no trial running, so no verdict is left due for a quest no card reads.
      if (state === 'completed') sql.exec("UPDATE experiments SET state = 'stopped', updated_at = ? WHERE quest_id = ? AND state = 'running'", now, id);
      return { status: before ? 'changed' : 'started', quest: view(sql.exec<Row>('SELECT * FROM goals WHERE id = ?', id).one()) };
    },
    open,
    // Every open quest fits (QUESTS_OPEN_MAX is below the app's cap), so recently completed ones only fill the room left.
    shown: () => {
      const since = clock.now().getTime() - COMPLETED_SHOWN_MS;
      const done = rows().filter(row => view(row).state === 'completed' && Date.parse(row.updated_at) >= since).map(view);
      return [...open(), ...done].slice(0, APP_QUESTS_MAX_V1);
    },
    due: () => open().filter(quest => quest.next_check_in !== null && quest.next_check_in <= today()),
    checkedIn(questIds, verdictsOffered = []) {
      const now = clock.now().toISOString();
      for (const id of questIds) sql.exec('UPDATE goals SET last_check_in_at = ? WHERE id = ?', now, id);
      for (const id of verdictsOffered) sql.exec("UPDATE experiments SET offered_at = ? WHERE id = ? AND state = 'running' AND offered_at IS NULL", now, id);
    },
    today,
    startExperiment(questId, change, days) {
      const quest = sql.exec<Row>('SELECT * FROM goals WHERE id = ?', questId).toArray()[0];
      if (!quest || view(quest).state === 'completed') return 'No open quest has that id. Use an id from the quests list.';
      if (sql.exec("SELECT 1 FROM experiments WHERE quest_id = ? AND state = 'running'", questId).toArray().length)
        return 'This quest already has a running experiment. Decide or stop it first, so each change is judged on its own.';
      const now = clock.now().toISOString(), id = `exp:${newId()}`;
      sql.exec("INSERT INTO experiments (id, quest_id, change, days, started_on, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)", id, questId, oneLine(change), days, today(), now, now);
      return { status: 'started', experiment: experimentView(experimentRow(id)!) };
    },
    decideExperiment(id, state, reason) {
      const row = experimentRow(id);
      if (!row) return 'No experiment has that id. Use an id from the quests list.';
      if (row.state !== 'running') return `That experiment was already ${row.state}.`;
      const now = clock.now().toISOString();
      sql.exec('UPDATE experiments SET state = ?, reason = ?, decided_on = ?, updated_at = ? WHERE id = ?', state, reason === null ? null : oneLine(reason), state === 'stopped' ? null : today(), now, id);
      return { status: 'decided', experiment: experimentView(experimentRow(id)!) };
    },
    experiment: id => { const row = experimentRow(id); return row ? experimentView(row) : null; },
    experimentsIn(questId) {
      const offered = (row: ExperimentRow) => ({ experiment: experimentView(row), offered: row.offered_at !== null });
      const running = sql.exec<ExperimentRow>("SELECT * FROM experiments WHERE quest_id = ? AND state = 'running'", questId).toArray().map(offered);
      const decided = sql.exec<ExperimentRow>("SELECT * FROM experiments WHERE quest_id = ? AND state IN ('kept', 'dropped') ORDER BY decided_on DESC, updated_at DESC LIMIT 2", questId).toArray().map(offered);
      return [...running, ...decided];
    },
    verdictsDue: () => unoffered().map(experimentView),
  };
};

// The experiment's comparison: the zone-day counts of the trial so far against the same number of days just before it,
// read from the health plane. A night's Recovery belongs to the morning it ended, so Recovery's trial runs from the morning
// after the start to the morning after the last trial day, and its usual ends on the start morning. null when the read
// failed or the plane holds no zone for either window.
export type ReadZones = (from: string, to: string) => Promise<unknown>;
const zonesAnswerSchema = z.object({ zones: z.object({ days: z.array(z.object({ day: z.string(), recovery: z.string().nullable(), form: z.string().nullable() })) }) });
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export const compareExperiment = async (experiment: Experiment, today: string, readZones: ReadZones): Promise<ReviewExperimentResult['comparison']> => {
  const start = experiment.started_on, earlier = (a: string, b: string) => (a < b ? a : b);
  const formTo = earlier(experiment.ends_on, today), recoveryTo = earlier(addDays(experiment.ends_on, 1), today);
  const formDays = daysBetween(start, formTo), recoveryDays = Math.max(0, daysBetween(addDays(start, 1), recoveryTo));
  const formUsualFrom = addDays(start, -formDays), recoveryUsualFrom = addDays(start, 1 - recoveryDays);
  const answer = zonesAnswerSchema.safeParse(await readZones(earlier(formUsualFrom, recoveryUsualFrom), recoveryTo > formTo ? recoveryTo : formTo));
  if (!answer.success || !answer.data.zones.days.length) return null;
  const rows = answer.data.zones.days;
  const counted = <P extends 'recovery' | 'form'>(pillar: P, zones: readonly string[], from: string, to: string) => {
    const days: Record<string, number> = { ...Object.fromEntries(zones.map(zone => [zone, 0])), none: daysBetween(from, to) };
    for (const row of rows) {
      const zone = row.day >= from && row.day <= to ? fromRowZone(pillar, row[pillar]) : null;
      if (zone) { days[zone]! += 1; days.none! -= 1; }
    }
    return { from, to, days };
  };
  const recovery = (from: string, to: string) => (recoveryDays ? counted('recovery', recoveryZoneSchema.options, from, to) : null);
  return {
    trial: { recovery: recovery(addDays(start, 1), recoveryTo), form: counted('form', formZoneSchema.options, start, formTo) },
    usual: { recovery: recovery(recoveryUsualFrom, start), form: counted('form', formZoneSchema.options, formUsualFrom, addDays(start, -1)) },
  } as ReviewExperimentResult['comparison'];
};

const experimentPart = ({ experiment, offered }: ExperimentNote, today: string): string => experiment.state !== 'running'
  ? `${experiment.state}: ${experiment.change}`
  : `experiment [${experiment.id}] ${experiment.change}, ${experiment.ends_on < today
    ? `ended ${experiment.ends_on}, verdict ${offered ? 'offered, waiting for the owner' : 'due'}`
    : `day ${daysBetween(experiment.started_on, today)} of ${experiment.days}`}`;

const questLine = (book: QuestBook, quest: AppQuestV1, due = false): string => `- [${quest.id}] ${quest.title} (${[
  quest.state,
  quest.check_in_days === null ? 'no check-ins on a schedule' : `check-ins every ${quest.check_in_days === 1 ? 'day' : `${quest.check_in_days} days`}`,
  ...(due ? ['check-in due tonight'] : []),
  ...(quest.plan ? [`plan: ${quest.plan}`] : []), ...(quest.usual ? [`usual: ${quest.usual}`] : []), ...(quest.target ? [`target: ${quest.target}`] : []),
  ...(quest.progress ? [`progress: ${quest.progress}`] : []), ...(quest.deadline ? [`ends ${quest.deadline}`] : []),
  ...book.experimentsIn(quest.id).map(note => experimentPart(note, book.today())),
].join('; ')})`;

// Every owner turn reads the open quests beside the standing orders, so set_quest can change one by id.
export const questsPrompt = (book: QuestBook): string => {
  const quests = book.open();
  return quests.length ? ["Quests the owner chose to work toward with you, in their words (change one with set_quest by its id; start one only when they ask):", ...quests.map(quest => questLine(book, quest))].join('\n') : '';
};

const QUEST_CARD: Readonly<Partial<Record<CardId, string>>> = {
  'card:brief': "The owner's quests follow: goals they chose to work toward, in their own words. Plan today around the active ones where today bears on one: the session, habit or rest it needs, at a time their day leaves room for, sized to how their body is today when they share it. An ambient quest is background: bring it in only when today clearly serves it. Never invent progress, a plan step or a target they have not stated.",
  'card:close': "The owner's quests follow, in their own words. For each one marked check-in due tonight, say in a sentence or two how it went since the last check-in against their own usual, from what you can see (today's conversation, the ledger, their calendar and their shared health in its words), and one small step for tomorrow when one would help. When nothing changed for a quest, leave it out: silence is the check-in. Speak of their body in plain words, never a reading or a score. Let the active quests shape tomorrow's plan.",
};

const VERDICT = "An experiment whose verdict is due has finished its trial. Offer the owner a verdict, keep or drop, with the reason against their own usual: weigh the trial's zone days below against the same number of days before it, and what they have told you. Say how sure you are: a few weeks is a small sample, a day with no zone counts for nothing, and other things changed too. When the zones are not available, say so and ask how it felt. Ask them to say keep or drop; it is recorded only when they answer.";
const zoneDays = (days: Readonly<Record<string, number>>): string => Object.entries(days).filter(([, n]) => n > 0).map(([zone, n]) => `${zone === 'none' ? 'no zone' : zone} ${n}`).join(', ');
const windowLine = (label: string, window: ExperimentWindow): string => `${label}: ${window.recovery
  ? `Recovery (mornings ${window.recovery.from} to ${window.recovery.to}) ${zoneDays(window.recovery.days)}` : 'Recovery (no morning yet)'}; Form (days ${window.form.from} to ${window.form.to}) ${zoneDays(window.form.days)}`;
const evidenceLines = (experiment: Experiment, comparison: ReviewExperimentResult['comparison']): string[] => comparison
  ? [`  - [${experiment.id}] ${windowLine('trial', comparison.trial)}`, `    ${windowLine('before it', comparison.usual)}`]
  : [`  - [${experiment.id}] the owner's zones are not available for these days`];

// What the Brief and the Close read about the open quests, as the job's context; null when the card has none to read. The
// Close also reads, for each experiment whose verdict it offers, the comparison read for it beforehand.
export const questCardContext = (card: CardId, book: QuestBook, verdicts: ReadonlyMap<string, ReviewExperimentResult['comparison']> = new Map()): string | null => {
  const instruction = QUEST_CARD[card], quests = book.open();
  if (!instruction || !quests.length) return null;
  const close = card === 'card:close', due = new Set(close ? book.due().map(quest => quest.id) : []);
  const offering = close ? book.verdictsDue() : [];
  return [instruction, ...(offering.length ? [VERDICT] : []), ...quests.flatMap(quest => [
    questLine(book, quest, due.has(quest.id)),
    ...offering.filter(experiment => experiment.quest_id === quest.id).flatMap(experiment => evidenceLines(experiment, verdicts.get(experiment.id) ?? null)),
  ])].join('\n');
};

const DESCRIPTION = "Start or change one of the owner's quests: a goal they chose to work toward with you (a marathon block, steadier sleep, coming back after illness, a weight target), with a plan, where they start against their own usual, a check-in pace and a state. Only when they ask: agree the plan and pace with them first. On a change, a field left out stays and null clears it. state completed when they finish or drop it, ambient to keep it in mind without check-ins. Write their own words; never copy a reading from a wearable or health app into a quest.";

// The same line remember holds: once a turn has read outside content, a reading in the text may have come from there.
const readingFromOutside = (ctx: ToolDispatcherContext, texts: readonly (string | null | undefined)[]): boolean =>
  turnReadOutside(ctx) && texts.some(text => typeof text === 'string' && (text.includes(HEALTH_SPAN_MARKER) || numericHealthIn(text)));
const OWNER_TURN_ONLY = "Only the owner's own chat turn can do this.";
const OUTSIDE_READING = 'This turn read outside content (mail, a web page or a connected tool), so no health reading from it is stored. Write it in words, or ask the owner.';
const committed = <T>(ctx: ToolDispatcherContext, write: () => T): T => {
  ctx.runScope?.admit();
  return ctx.runScope ? ctx.runScope.commit(write) : write();
};

export const questHandler = (book: QuestBook): ToolHandler<SetQuestArgs, SetQuestResult, ToolDispatcherContext> => ({
  name: 'set_quest',
  description: DESCRIPTION,
  schema: setQuestArgsSchema,
  trigger_allowlist: ownerTriggers('set_quest'),
  autonomy_gated: false,
  mutates_state: true,
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message') return { ok: false, code: 'rejected', error: OWNER_TURN_ONLY };
    if (readingFromOutside(ctx, [args.title, args.plan, args.usual, args.target, args.progress])) return { ok: false, code: 'rejected', error: OUTSIDE_READING };
    const result = committed(ctx, () => book.set(args, ctx.authenticatedUserId));
    return typeof result === 'string' ? { ok: false, code: 'invalid_args', error: result } : { ok: true, data: result, source_taint: null };
  },
});

const SET_EXPERIMENT = "Start one change the owner wants to try inside one of their quests (a caffeine cutoff, morning light, an earlier training slot) for a set number of days, or record its verdict. Start one only when they ask, one at a time per quest. Record kept or dropped only once the owner has said which, with the reason against their own usual; stopped ends it early without a verdict. Write their own words; never a reading from a wearable or health app.";
const REVIEW_EXPERIMENT = "Compare an experiment's days so far with the same number of days before it: how many days the owner's Recovery and Form sat in each zone. Use it when they ask how an experiment is going or before you suggest a verdict. Speak of it in zone words and say how sure the comparison can be; never invent a reading or a score.";
const ownerTriggers = (tool: string) => triggerTypeSchema.options.filter(trigger => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(tool));

export const experimentHandlers = (book: QuestBook, readZones: ReadZones): readonly [
  ToolHandler<SetExperimentArgs, SetExperimentResult, ToolDispatcherContext>, ToolHandler<ReviewExperimentArgs, ReviewExperimentResult, ToolDispatcherContext>,
] => [{
  name: 'set_experiment',
  description: SET_EXPERIMENT,
  schema: setExperimentArgsSchema,
  trigger_allowlist: ownerTriggers('set_experiment'),
  autonomy_gated: false,
  mutates_state: true,
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message') return { ok: false, code: 'rejected', error: OWNER_TURN_ONLY };
    if (readingFromOutside(ctx, [args.change])) return { ok: false, code: 'rejected', error: OUTSIDE_READING };
    // The reason is the model's own summary, never the owner's words, so it holds zone words and no reading on any turn.
    if (args.reason !== undefined && (args.reason.includes(HEALTH_SPAN_MARKER) || numericHealthIn(args.reason)))
      return { ok: false, code: 'rejected', error: 'Write the reason in zone words, with no reading or score.' };
    const result = committed(ctx, () => args.quest_id !== undefined
      ? book.startExperiment(args.quest_id, args.change!, args.days ?? EXPERIMENT_DAYS_DEFAULT)
      : book.decideExperiment(args.id!, args.state!, args.reason ?? null));
    return typeof result === 'string' ? { ok: false, code: 'invalid_args', error: result } : { ok: true, data: result, source_taint: null };
  },
}, {
  name: 'review_experiment',
  description: REVIEW_EXPERIMENT,
  schema: reviewExperimentArgsSchema,
  trigger_allowlist: ownerTriggers('review_experiment'),
  autonomy_gated: false,
  // Zone days are the owner's health, so they stay in the turn that asked and never reach the tool ledger or memory.
  turn_only_output: true,
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message') return { ok: false, code: 'rejected', error: OWNER_TURN_ONLY };
    const experiment = book.experiment(args.id);
    if (!experiment) return { ok: false, code: 'invalid_args', error: 'No experiment has that id. Use an id from the quests list.' };
    return { ok: true, data: { experiment, comparison: await compareExperiment(experiment, book.today(), readZones) }, source_taint: null };
  },
}];
