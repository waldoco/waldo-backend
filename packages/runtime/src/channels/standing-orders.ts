import {
  cancelStandingOrderArgsSchema, listStandingOrdersArgsSchema, setStandingOrderArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type CancelStandingOrderArgs, type ListStandingOrdersArgs, type SetStandingOrderArgs, type StandingEscalation, type StandingGate, type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { ScheduleKind } from '@waldo/contracts';
import type { Scheduler } from '../scheduler/multiplexer';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';
import { localIso, localToEpoch, nextAfter } from './reminders';

// A7 (BUILD_PLAN_2026-09-25): typed standing orders. every_turn orders ride the reply system
// prompt (read-only context); daily orders additionally arm a scheduler entry whose fire runs
// the same machine-turn path as a reminder. The gate governs the fired run's behavior; the
// write tools themselves stay ACL-bound to owner-confirmed turns exactly as before.
export type StandingOrder = Readonly<{
  id: string;
  scope: string;
  trigger: 'every_turn' | 'daily';
  at: string | null;
  gate: StandingGate;
  escalation: StandingEscalation;
  created_at: number;
}>;

type Sql = Pick<SqlStorage, 'exec'>;

export type StandingOrderBook = Readonly<{
  set(args: SetStandingOrderArgs): Promise<StandingOrder>;
  list(): readonly StandingOrder[];
  byId(id: string): StandingOrder | null;
  cancel(id: string): Promise<boolean>;
}>;

export const standingOrderBook = (sql: Sql, scheduler: Scheduler, clock: OwnerClock, newId: () => string): StandingOrderBook => {
  sql.exec(`CREATE TABLE IF NOT EXISTS standing_orders (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, trigger TEXT NOT NULL, at TEXT, gate TEXT NOT NULL, escalation TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const toOrder = (row: StandingOrder): StandingOrder => row;
  return {
    async set(args) {
      if (args.trigger === 'daily' && args.at === undefined) throw new Error('a daily standing order needs its local HH:MM time');
      if (args.trigger === 'every_turn' && args.at !== undefined) throw new Error('an every-turn standing order takes no time');
      const id = `order:${newId()}`;
      sql.exec(
        'INSERT INTO standing_orders (id, scope, trigger, at, gate, escalation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, args.scope, args.trigger, args.at ?? null, args.gate, args.escalation, clock.now().getTime(),
      );
      if (args.trigger === 'daily' && args.at !== undefined) {
        const now = clock.now().getTime();
        const today = localIso(now, clock.timezone).slice(0, 10);
        const due = nextAfter(localToEpoch(`${today}T${args.at}`, clock.timezone), now);
        try {
          await scheduler.schedule({
            id, kind: 'standing_order' as ScheduleKind, payloadRefs: { order_id: id },
            occurrenceAt: due, dueAt: due,
            recurrence: { type: 'daily_local', time: args.at, timezone: clock.timezone },
          });
        } catch (error) {
          // An active order with no armed schedule would look set and never run.
          sql.exec('DELETE FROM standing_orders WHERE id = ?', id);
          throw error;
        }
      }
      return { id, scope: args.scope, trigger: args.trigger, at: args.at ?? null, gate: args.gate, escalation: args.escalation, created_at: clock.now().getTime() };
    },
    list: () => sql.exec<StandingOrder>('SELECT * FROM standing_orders ORDER BY created_at').toArray().map(toOrder),
    byId: (id) => sql.exec<StandingOrder>('SELECT * FROM standing_orders WHERE id = ?', id).toArray()[0] ?? null,
    async cancel(id) {
      const known = scheduler.read(id)?.kind === 'standing_order';
      if (known) await scheduler.cancel(id);
      // A DELETE returns no rows, so whether the order existed is read before removing it.
      const existed = sql.exec('SELECT id FROM standing_orders WHERE id = ?', id).toArray().length > 0;
      sql.exec('DELETE FROM standing_orders WHERE id = ?', id);
      return existed || known;
    },
  };
};

// The system-prompt section every owner turn carries. Read-only context: the order text is
// owner-authored, and the legend keeps the gate meaning explicit so the model never treats a
// confirm_first order as license to act on its own.
export const standingOrdersPrompt = (book: StandingOrderBook): string => {
  const orders = book.list();
  if (orders.length === 0) return '';
  const line = (order: StandingOrder): string =>
    `- [${order.id}] ${order.scope} (${order.trigger === 'daily' ? `runs daily at ${order.at}` : 'applies every turn'}; gate: ${order.gate === 'confirm_first' ? 'confirm with the owner before acting' : 'act and report'})`;
  return [
    'Standing orders from the owner (apply until cancelled; a confirm_first order is never license to act without the owner):',
    ...orders.map(line),
  ].join('\n');
};

// The machine-turn message a daily fire runs, mirroring the reminder fire's phrasing.
export const standingOrderFireText = (order: StandingOrder): string =>
  `[Standing order due now, set earlier by the owner: "${order.scope}"] ${
    order.gate === 'confirm_first'
      ? 'Prepare what you would do and report it; make no changes until the owner confirms in chat.'
      : 'Do it now, then report what you did.'
  }`;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const standingOrderHandlers = (book: StandingOrderBook) => [
  {
    name: 'set_standing_order',
    description:
      "Create a standing order - a persistent instruction that applies every turn or runs daily at a set local time. Only when the owner asks for an ongoing rule; one-off requests are reminders. gate confirm_first means scheduled runs prepare and report, then wait for the owner.",
    schema: setStandingOrderArgsSchema,
    trigger_allowlist: allowlist('set_standing_order'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      try {
        return { ok: true, data: await book.set(args), source_taint: null };
      } catch (error) {
        return { ok: false, code: 'invalid_args', error: error instanceof Error ? error.message : String(error) };
      }
    },
  } satisfies ToolHandler<SetStandingOrderArgs, StandingOrder, ToolDispatcherContext>,
  {
    name: 'list_standing_orders',
    description: "The owner's active standing orders.",
    schema: listStandingOrdersArgsSchema,
    trigger_allowlist: allowlist('list_standing_orders'),
    autonomy_gated: false,
    async handle() {
      return { ok: true, data: { orders: book.list() }, source_taint: null };
    },
  } satisfies ToolHandler<ListStandingOrdersArgs, { orders: readonly StandingOrder[] }, ToolDispatcherContext>,
  {
    name: 'cancel_standing_order',
    description: 'Cancel a standing order by id.',
    schema: cancelStandingOrderArgsSchema,
    trigger_allowlist: allowlist('cancel_standing_order'),
    autonomy_gated: false,
    mutates_state: true,
    async handle({ id }) {
      return { ok: true, data: { id, cancelled: await book.cancel(id) }, source_taint: null };
    },
  } satisfies ToolHandler<CancelStandingOrderArgs, { id: string; cancelled: boolean }, ToolDispatcherContext>,
];
