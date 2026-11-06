import { goalState, setQuestArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type GoalState, type SetQuestArgs, type SetQuestResult, type ToolHandler } from '@waldo/contracts';
import { APP_QUESTS_MAX_V1, appQuestV1Schema, type AppQuestV1 } from '../../../contracts/src/app/controls';
import { GOAL_QUEST_COLUMNS, HEY144_GOALS_SCHEMA_MIGRATION } from '../do-schema';
import { HEALTH_SPAN_MARKER, ownerReadings, readingBeyondOwner } from '../scribe/sanitiser';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { ownerParts, type MemoryOwnerTurn } from '../tools/owner-words';
import type { OwnerClock } from '../tools/live/get-context';
import type { CardId } from '../prompt/day-cards';
import { localIso } from './reminders';

// Quests (ADR-0064 GoalRecord, as amended for health quests): goals the owner chose to work toward with Waldo, kept in the
// goals table. The owner starts and changes them in chat; the Brief plans the day around the active ones and the Close checks
// in on those whose pace has come round. Whether a check-in has anything to say is the model's call.
type Sql = Pick<SqlStorage, 'exec'>;
type Row = {
  id: string; description: string; baseline: string | null; target: string | null; progress: string | null; deadline: string | null;
  active: number; plan: string | null; state: GoalState | null; check_in_days: number | null; last_check_in_at: string | null; created_at: string; updated_at: string;
};

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
  checkedIn(ids: readonly string[]): void;
}>;

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// Owner text rides prompts one quest per line, so a line break never reaches the store.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const questBook = (sql: Sql, clock: OwnerClock, newId: () => string): QuestBook => {
  for (const statement of HEY144_GOALS_SCHEMA_MIGRATION.up) sql.exec(statement);
  const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(goals)').toArray().map(row => row.name));
  for (const [column, ddl] of GOAL_QUEST_COLUMNS) if (!columns.has(column)) sql.exec(ddl);

  const dayOf = (iso: string): string => localIso(Date.parse(iso), clock.timezone).slice(0, 10);
  const view = (row: Row): AppQuestV1 => {
    const state = goalState({ active: row.active === 1, ...(row.state ? { state: row.state } : {}) });
    return {
      id: row.id, title: row.description, state, plan: row.plan, usual: row.baseline, target: row.target, progress: row.progress,
      deadline: row.deadline?.slice(0, 10) ?? null, check_in_days: row.check_in_days,
      next_check_in: state === 'active' && row.check_in_days !== null ? addDays(dayOf(row.last_check_in_at ?? row.created_at), row.check_in_days) : null,
    };
  };
  // A goals row another writer left outside the quest shape is not a quest: no prompt lists it and the app never receives it.
  const quests = (): AppQuestV1[] => sql.exec<Row>('SELECT * FROM goals ORDER BY created_at, id').toArray().map(view).filter(quest => appQuestV1Schema.safeParse(quest).success);
  const updatedAt = (id: string): string => sql.exec<{ updated_at: string }>('SELECT updated_at FROM goals WHERE id = ?', id).one().updated_at;
  const open = (): AppQuestV1[] => quests().filter(quest => quest.state !== 'completed');
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
      return { status: before ? 'changed' : 'started', quest: view(sql.exec<Row>('SELECT * FROM goals WHERE id = ?', id).one()) };
    },
    open,
    // Every open quest fits (QUESTS_OPEN_MAX is below the app's cap), so recently completed ones only fill the room left.
    shown: () => {
      const since = clock.now().getTime() - COMPLETED_SHOWN_MS;
      const done = quests().filter(quest => quest.state === 'completed' && Date.parse(updatedAt(quest.id)) >= since);
      return [...open(), ...done].slice(0, APP_QUESTS_MAX_V1);
    },
    due: () => {
      const today = localIso(clock.now().getTime(), clock.timezone).slice(0, 10);
      return open().filter(quest => quest.next_check_in !== null && quest.next_check_in <= today);
    },
    checkedIn(ids) {
      const now = clock.now().toISOString();
      for (const id of ids) sql.exec('UPDATE goals SET last_check_in_at = ? WHERE id = ?', now, id);
    },
  };
};

const questLine = (quest: AppQuestV1, due = false): string => `- [${quest.id}] ${quest.title} (${[
  quest.state,
  quest.check_in_days === null ? 'no check-ins on a schedule' : `check-ins every ${quest.check_in_days === 1 ? 'day' : `${quest.check_in_days} days`}`,
  ...(due ? ['check-in due tonight'] : []),
  ...(quest.plan ? [`plan: ${quest.plan}`] : []), ...(quest.usual ? [`usual: ${quest.usual}`] : []), ...(quest.target ? [`target: ${quest.target}`] : []),
  ...(quest.progress ? [`progress: ${quest.progress}`] : []), ...(quest.deadline ? [`ends ${quest.deadline}`] : []),
].join('; ')})`;

// Every owner turn reads the open quests beside the standing orders, so set_quest can change one by id.
export const questsPrompt = (book: QuestBook): string => {
  const quests = book.open();
  return quests.length ? ["Quests the owner chose to work toward with you, in their words (change one with set_quest by its id; start one only when they ask):", ...quests.map(quest => questLine(quest))].join('\n') : '';
};

const QUEST_CARD: Readonly<Partial<Record<CardId, string>>> = {
  'card:brief': "The owner's quests follow: goals they chose to work toward, in their own words. Plan today around the active ones where today bears on one: the session, habit or rest it needs, at a time their day leaves room for, sized to how their body is today when they share it. An ambient quest is background: bring it in only when today clearly serves it. Never invent progress, a plan step or a target they have not stated.",
  'card:close': "The owner's quests follow, in their own words. For each one marked check-in due tonight, say in a sentence or two how it went since the last check-in against their own usual, from what you can see (today's conversation, the ledger, their calendar and their shared health in its words), and one small step for tomorrow when one would help. When nothing changed for a quest, leave it out: silence is the check-in. Speak of their body in plain words, never a reading or a score. Let the active quests shape tomorrow's plan.",
};

// What the Brief and the Close read about the open quests, as the job's context; null when the card has none to read.
export const questCardContext = (card: CardId, book: QuestBook): string | null => {
  const instruction = QUEST_CARD[card], quests = book.open();
  if (!instruction || !quests.length) return null;
  const due = new Set(card === 'card:close' ? book.due().map(quest => quest.id) : []);
  return [instruction, ...quests.map(quest => questLine(quest, due.has(quest.id)))].join('\n');
};

const DESCRIPTION = "Start or change one of the owner's quests: a goal they chose to work toward with you (a marathon block, steadier sleep, coming back after illness, a weight target), with a plan, where they start against their own usual, a check-in pace and a state. Only when they ask: agree the plan and pace with them first. On a change, a field left out stays and null clears it. state completed when they finish or drop it, ambient to keep it in mind without check-ins. Write their own words; never copy a reading from a wearable or health app into a quest.";

// The readings in the owner's own words this turn and in their recent messages, forwarded parts left out. A reading in a
// quest is kept only when its numbers are among these, so one read from a wearable or outside content never lands in a quest.
const readingNotOwners = (text: string, ctx: ToolDispatcherContext): boolean => {
  const turn = (ctx as { memoryTurn?: Readonly<{ ownerId?: string; current?: MemoryOwnerTurn; recent?: readonly MemoryOwnerTurn[] }> }).memoryTurn;
  const said = turn?.current && turn.ownerId === ctx.authenticatedUserId ? ownerReadings([turn.current, ...(turn.recent ?? [])].flatMap(ownerParts).join('\n')) : undefined;
  return text.includes(HEALTH_SPAN_MARKER) || readingBeyondOwner(text, said);
};

export const questHandler = (book: QuestBook): ToolHandler<SetQuestArgs, SetQuestResult, ToolDispatcherContext> => ({
  name: 'set_quest',
  description: DESCRIPTION,
  schema: setQuestArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('set_quest')),
  autonomy_gated: false,
  mutates_state: true,
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message') return { ok: false, code: 'rejected', error: "Only the owner's own chat turn can start or change a quest." };
    if ([args.title, args.plan, args.usual, args.target, args.progress].some(text => typeof text === 'string' && readingNotOwners(text, ctx)))
      return { ok: false, code: 'rejected', error: 'A quest keeps a health number only as the owner said it in their own message, never one read from a device or outside content. Write it in words, or ask the owner.' };
    ctx.runScope?.admit();
    const result = ctx.runScope ? ctx.runScope.commit(() => book.set(args, ctx.authenticatedUserId)) : book.set(args, ctx.authenticatedUserId);
    return typeof result === 'string' ? { ok: false, code: 'invalid_args', error: result } : { ok: true, data: result, source_taint: null };
  },
});
