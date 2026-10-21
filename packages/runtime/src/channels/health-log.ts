import {
  listHealthLogsArgsSchema, logMealArgsSchema, logWorkoutArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ListHealthLogsArgs, type LogMealArgs, type LogWorkoutArgs, type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { OwnerClock } from '../tools/live/get-context';
import { localIso, localToEpoch } from './reminders';
import { md5Hex } from './md5';

// A9 (BUILD_PLAN_2026-09-25): meal + workout logging over the signed router rail. The DO
// signs md5 of the exact payload text it sends (the RPC takes text and casts to jsonb
// server-side, so Postgres jsonb re-serialization can never desync the signature). Reads
// degrade to empty when the store is unlinked so the proactive beats never break on it.
export type HealthSource = 'telegram' | 'whatsapp' | 'console';

export type HealthLogEntry = Readonly<{
  id: number;
  kind: 'meal' | 'workout';
  logged_at: string;
  source: string;
  payload: Record<string, unknown>;
}>;

type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;

export type HealthLogBook = Readonly<{
  linked(): boolean;
  log(kind: 'meal' | 'workout', payload: Record<string, unknown>, atLocal: string | undefined): Promise<{ id: number; at: string }>;
  recent(limit: number): Promise<readonly HealthLogEntry[]>;
}>;

const NOT_LINKED = 'health logging is not linked yet';

export const healthLogBook = (
  call: SignedCall | null,
  doName: string | null,
  source: HealthSource,
  clock: OwnerClock,
  onReadError?: (error: unknown) => void,
): HealthLogBook => {
  const linked = () => call !== null && !!doName;
  return {
    linked,
    async log(kind, payload, atLocal) {
      if (!call || !doName) throw new Error(NOT_LINKED);
      const at = atLocal === undefined ? clock.now().getTime() : localToEpoch(atLocal, clock.timezone);
      if (!Number.isFinite(at) || at <= 0) throw new Error(`could not place ${atLocal} on the timeline`);
      // JSON.stringify keeps the construction order below, and that exact text is both the
      // RPC argument and the md5 pre-image - one serialization, no emulation.
      const body = JSON.stringify(payload);
      const id = (await call('health_log_add', `health.add.${doName}.${kind}.${source}.${md5Hex(body)}`, {
        p_do_name: doName, p_kind: kind, p_logged_at: new Date(at).toISOString(), p_source: source, p_payload: body,
      })) as number | null;
      if (id === null) throw new Error(NOT_LINKED);
      return { id, at: localIso(at, clock.timezone) };
    },
    async recent(limit) {
      if (!call || !doName) return [];
      try {
        const rows = (await call('health_log_recent', `health.recent.${doName}.${limit}`, { p_do_name: doName, p_limit: limit })) as HealthLogEntry[];
        return Array.isArray(rows) ? rows : [];
      } catch (error) {
        onReadError?.(error);
        return [];
      }
    },
  };
};

// Terse ledger lines for the proactive beats: data only, estimates marked, never a diagnosis.
export const healthSection = (entries: readonly HealthLogEntry[], timezone: string): string => {
  if (entries.length === 0) return '';
  const line = (entry: HealthLogEntry): string => {
    const when = localIso(Date.parse(entry.logged_at), timezone).slice(5).replace('T', ' ');
    const payload = entry.payload;
    if (entry.kind === 'meal') {
      const description = typeof payload['description'] === 'string' ? (payload['description'] as string).slice(0, 120) : 'meal';
      const estimate = typeof payload['calories_estimate'] === 'number' ? ` (~${payload['calories_estimate']} kcal, estimate)` : '';
      return `- ${when} meal: ${description}${estimate}`;
    }
    const type = typeof payload['type'] === 'string' ? (payload['type'] as string).slice(0, 60) : 'workout';
    const duration = typeof payload['duration_minutes'] === 'number' ? `, ${payload['duration_minutes']} min` : '';
    return `- ${when} workout: ${type}${duration}`;
  };
  return ['Recent health logs (owner-logged; calorie figures are estimates):', ...entries.map(line)].join('\n');
};

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

type LogResult = { id: number; kind: 'meal' | 'workout'; at: string };
type ListResult = { linked: boolean; entries: readonly HealthLogEntry[] };

export const healthLogHandlers = (book: HealthLogBook) => [
  {
    name: 'log_meal',
    description:
      'Log a meal the owner told you about or showed you in a photo. Store what they said (or what the photo shows, named as such); add calories_estimate only when it is honestly inferable, and always present it as an estimate. When the owner has not asked to log the photo, describe it and offer instead of logging. Log and nudge, never diagnose.',
    schema: logMealArgsSchema,
    trigger_allowlist: allowlist('log_meal'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      try {
        const payload: Record<string, unknown> = { description: args.description };
        if (args.items !== undefined) payload['items'] = args.items;
        if (args.calories_estimate !== undefined) payload['calories_estimate'] = args.calories_estimate;
        const logged = await book.log('meal', payload, args.at);
        return { ok: true, data: { ...logged, kind: 'meal' as const }, source_taint: null };
      } catch (error) {
        return { ok: false, code: error instanceof Error && error.message === NOT_LINKED ? 'transient' : 'invalid_args', error: error instanceof Error ? error.message : String(error) };
      }
    },
  } satisfies ToolHandler<LogMealArgs, LogResult, ToolDispatcherContext>,
  {
    name: 'log_workout',
    description: 'Log a workout the owner told you about: type, optional duration and notes. Log and nudge, never diagnose.',
    schema: logWorkoutArgsSchema,
    trigger_allowlist: allowlist('log_workout'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args) {
      try {
        const payload: Record<string, unknown> = { type: args.type };
        if (args.duration_minutes !== undefined) payload['duration_minutes'] = args.duration_minutes;
        if (args.notes !== undefined) payload['notes'] = args.notes;
        const logged = await book.log('workout', payload, args.at);
        return { ok: true, data: { ...logged, kind: 'workout' as const }, source_taint: null };
      } catch (error) {
        return { ok: false, code: error instanceof Error && error.message === NOT_LINKED ? 'transient' : 'invalid_args', error: error instanceof Error ? error.message : String(error) };
      }
    },
  } satisfies ToolHandler<LogWorkoutArgs, LogResult, ToolDispatcherContext>,
  {
    name: 'list_health_logs',
    description: "The owner's recent meal and workout logs, newest first. Entries are what the owner logged; calorie figures are estimates.",
    schema: listHealthLogsArgsSchema,
    trigger_allowlist: allowlist('list_health_logs'),
    autonomy_gated: false,
    async handle(args) {
      const entries = (await book.recent(args.limit)).filter((entry) => args.kind === undefined || entry.kind === args.kind);
      return { ok: true, data: { linked: book.linked(), entries }, source_taint: null };
    },
  } satisfies ToolHandler<ListHealthLogsArgs, ListResult, ToolDispatcherContext>,
];
