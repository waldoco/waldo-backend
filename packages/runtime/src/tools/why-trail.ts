import { APP_WHY_STEPS_MAX_V1, appWhyV1Schema, type AppWhyV1 } from '../../../contracts/src/app/why';
import { whyArgSchema, whyStepArgSchema, type WhyStepArg } from '../../../contracts/src/tools/schemas/approvals';
import { toolParameters } from '../../../contracts/src/adapters/llm';
import { healthReadSignalSchema } from '../../../contracts/src/tools/schemas/reads';
import { numericHealthIn } from '../scribe/sanitiser';

// "Why this changed" (proactive runtime §4.6). The model names the steps behind a card; the host keeps only a step whose
// source a successful read earlier in the same turn returned, and stamps it with that read's time. What the model wrote is
// never evidence of a read by itself.
export type TrailSource = Readonly<{ kind: WhyStepArg['source']['kind']; ref: string }>;
// One successful read of the turn and what it returned that a step can name.
export type TrailRead = Readonly<{ at: number; sources: readonly TrailSource[] }>;
export type TrailStep = Readonly<{ at: number; verb: WhyStepArg['verb']; label: string; source: TrailSource }>;

// The reads that can stand behind each kind of source, and the fields of their arguments or result that name one.
const SOURCE_READS: Readonly<Record<TrailSource['kind'], Readonly<{ tools: ReadonlySet<string>; keys: ReadonlySet<string> }>>> = {
  calendar_event: { tools: new Set(['query_calendar']), keys: new Set(['id', 'event_id', 'recurring_event_id']) },
  calendar_free_busy: { tools: new Set(['query_availability']), keys: new Set(['calendar_ids']) },
  mail_thread: { tools: new Set(['get_communication', 'search_communication', 'read_thread']), keys: new Set(['thread_id']) },
  memory_node: { tools: new Set(['read_memory', 'search_episodes', 'get_context']), keys: new Set(['id', 'ref', 'claim_ids']) },
  health_score: { tools: new Set(['get_health']), keys: new Set(['signals', 'signal']) },
};
const KINDS = Object.keys(SOURCE_READS) as TrailSource['kind'][];
const MAX_REFS_PER_READ = 400;
const MAX_DEPTH = 8;
// A health ref is a score or signal name, compared without case ("Recovery" and "recovery" name the same score).
const refOf = (kind: TrailSource['kind'], ref: string): string => kind === 'health_score' ? ref.toLowerCase() : ref;
// The scores and signals a health step can name, and the words a reading is written with. A line that has one of these and
// any digit is taken to carry a reading, whatever source its step names: losing such a step is the safe side.
export const SHARED_HEALTH_SCORES = ['form', 'recovery', 'load'] as const;
const HEALTH_REFS: ReadonlySet<string> = new Set([...SHARED_HEALTH_SCORES, ...healthReadSignalSchema.options]);
const HEALTH_WORDS = new RegExp(`\\b(?:${[...HEALTH_REFS].map(ref => ref.replaceAll('_', '[ _]')).join('|')}|slept|readiness|strain|hr|bpm|heart|kg|kcal|calories)\\b`, 'i');
const carriesReading = (label: string): boolean => /\d/.test(label) && (HEALTH_WORDS.test(label) || numericHealthIn(label));

const collect = (value: unknown, keys: ReadonlySet<string>, into: Set<string>, depth = 0, named = false): void => {
  if (into.size >= MAX_REFS_PER_READ || depth > MAX_DEPTH) return;
  if (named && (typeof value === 'string' || typeof value === 'number')) { if (String(value).length <= 256) into.add(String(value)); return; }
  if (Array.isArray(value)) { for (const item of value) collect(item, keys, into, depth + 1, named); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) collect(item, keys, into, depth + 1, keys.has(key));
};

// What a successful call of `tool` returned that a step can name, from its arguments and its result.
export const readSources = (tool: string, args: unknown, data: unknown): readonly TrailSource[] => KINDS.flatMap(kind => {
  const { tools, keys } = SOURCE_READS[kind];
  if (!tools.has(tool)) return [];
  const refs = new Set<string>();
  collect(args, keys, refs);
  collect(data, keys, refs);
  return [...refs].map(ref => ({ kind, ref: refOf(kind, ref) })).filter(source => source.kind !== 'health_score' || HEALTH_REFS.has(source.ref));
});

// The turn's record of what it read, which the tool loop fills and a proposing tool reads. Absent outside an owner turn.
export const recordRead = (reads: TrailRead[] | undefined, tool: string, args: string, data: unknown, at: number): void => {
  if (!reads) return;
  let parsed: unknown;
  try { parsed = JSON.parse(args || '{}'); } catch { return; }
  const sources = readSources(tool, parsed, data);
  if (sources.length) reads.push({ at, sources });
};
// The shared health the host put in this turn's prompt is a read the turn made: each score it names stands behind a step.
export const recordSharedHealth = (reads: TrailRead[] | undefined, healthText: string, at: number): void => {
  if (!reads || !healthText) return;
  const scores = SHARED_HEALTH_SCORES.filter(score => new RegExp(`\\b${score}\\b`, 'i').test(healthText));
  if (scores.length && !reads.some(read => read.sources.some(source => source.kind === 'health_score' && (scores as readonly string[]).includes(source.ref))))
    reads.push({ at, sources: scores.map(ref => ({ kind: 'health_score' as const, ref })) });
};

// The steps the model claimed that stand on a read of this turn, in time order. A step whose source nothing read is dropped,
// and so is one whose line carries a health reading, whatever its source, or, for a health step, any number at all.
export const keptSteps = (claimed: unknown, reads: readonly TrailRead[]): readonly TrailStep[] => {
  if (!Array.isArray(claimed)) return [];
  return mergedSteps(claimed.slice(0, APP_WHY_STEPS_MAX_V1).flatMap((raw): TrailStep[] => {
    const step = whyStepArgSchema.safeParse(raw);
    if (!step.success) return [];
    const { verb, label, source } = step.data;
    if (numericHealthIn(label) || carriesReading(label) || (source.kind === 'health_score' && /\d/.test(label))) return [];
    const ref = refOf(source.kind, source.ref);
    const read = reads.find(candidate => candidate.sources.some(found => found.kind === source.kind && found.ref === ref));
    return read ? [{ at: read.at, verb, label, source: { kind: source.kind, ref } }] : [];
  }));
};
// Steps from one or more cards as one trail: each step once, in time order, at most as many as the app shows.
export const mergedSteps = (steps: readonly TrailStep[]): readonly TrailStep[] => {
  const seen = new Set<string>();
  return steps.filter(step => {
    const key = JSON.stringify([step.verb, step.label, step.source.kind, step.source.ref]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.at - b.at).slice(0, APP_WHY_STEPS_MAX_V1);
};

// The app's view: the kind of source, never the provider's id. Steps the contract cannot carry are left out.
export const appWhy = (steps: readonly TrailStep[] | undefined): AppWhyV1 | undefined => {
  if (!steps?.length) return undefined;
  const view = appWhyV1Schema.safeParse(steps.map(({ at, verb, label, source }) => ({ at, verb, label, source: source.kind })));
  return view.success ? view.data : undefined;
};
export const storedWhy = (json: string | null | undefined): readonly TrailStep[] | undefined => {
  if (!json) return undefined;
  try { const steps = JSON.parse(json) as unknown; return Array.isArray(steps) ? steps as TrailStep[] : undefined; } catch { return undefined; }
};
export const whyJson = (steps: readonly TrailStep[] | undefined): string | null => steps?.length ? JSON.stringify(steps) : null;

// The tools that raise a card and take steps behind it, while the trail is on.
export const WHY_TOOLS: ReadonlySet<string> = new Set(['propose_calendar_change', 'propose_calendar_plan', 'propose_action', 'propose_google_task_change', 'send_email', 'send_agent_mail', 'send_message']);
// The `why` argument as the model sees it, added to a proposing tool's own parameters.
export const WHY_PARAMETER = toolParameters(whyArgSchema);
export const withWhyParameter = (parameters: Record<string, unknown>): Record<string, unknown> => ({
  ...parameters, properties: { ...(parameters.properties as Record<string, unknown> | undefined), why: WHY_PARAMETER },
});
// Takes `why` off a proposing call's arguments before they are checked, so it is never part of what the owner approves.
export const peelWhy = (args: unknown): Readonly<{ args: unknown; why: unknown }> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'why')) return { args, why: undefined };
  const { why, ...rest } = args as Record<string, unknown>;
  return { args: rest, why };
};

// A proposing call gets the steps the host kept for it on its own context (whySteps), so a card raised by any other call
// never takes them; collected, when set, gathers every raised card's steps for the day card being written.
export type WhyHolder = { collected?: TrailStep[] };
type WhyContext = Readonly<{ claimedWhy?: unknown; turnReads?: readonly TrailRead[] }>;
type Handler = Readonly<{ name: string; handle(args: never, ctx: never): Promise<Readonly<{ ok: boolean }>> }>;
export const withWhy = <H extends Handler>(handlers: readonly H[], holder: WhyHolder): H[] => handlers.map(handler => !WHY_TOOLS.has(handler.name) ? handler : {
  ...handler, takes_why: true as const,
  handle: async (args: never, ctx: never) => {
    const context = ctx as WhyContext | undefined;
    const steps = keptSteps(context?.claimedWhy, context?.turnReads ?? []);
    const result = await handler.handle(args, (steps.length ? { ...context, whySteps: steps } : ctx) as never);
    if (result.ok && steps.length) holder.collected?.push(...steps);
    return result;
  },
});
