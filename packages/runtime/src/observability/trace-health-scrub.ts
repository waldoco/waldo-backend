import type { TurnLogEntry } from '../channels/telegram-listener';
import { redactNumericHealth } from '../scribe/sanitiser';
import { toolsWhere } from '../tools/records';

// With text capture on, conversation text reaches the trace sinks (the DO trace table, Worker logs, Langfuse) for
// diagnostics, and health values never do: what carries them is withheld whole, and the numeric health floor redacts
// readings anywhere else.
export const HEALTH_WITHHELD = '[health withheld from diagnostics]';

// get_health sits in the core brain; the rest of the owner's health reads and logs sit in the health brain.
const HEALTH_TOOLS: ReadonlySet<string> = new Set<string>(['get_health', ...toolsWhere((record) => record.brain === 'health')]);
// Owner turns, child agents and task workers (brain-side task_tool_<name>) each log a tool call under its name.
const TOOL_HOP = /^(?:subagent_|task_)?tool_(.+)$/;

// The openings of the health blocks the prompt builders write: the composer's and the REASONS builder's derived health
// context, the owner turn's shared-health label and the owner-logged meals and workouts. Each block is one paragraph.
const HEALTH_BLOCK = /^\s*(?:Form zone:|Recovery zone:|Shared health today\b|Recent health logs\b)/;
const PARAGRAPHS = /(\n[ \t]*\n)/;

const scrubProse = (text: string): string => redactNumericHealth(
  text.split(PARAGRAPHS).map((part) => (HEALTH_BLOCK.test(part) ? HEALTH_WITHHELD : part)).join(''),
  HEALTH_WITHHELD,
);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const healthTool = (value: unknown): boolean => isRecord(value) && typeof value['name'] === 'string' && HEALTH_TOOLS.has(value['name']);

// A large tool output is stored for this turn and read back in ranges through read_tool_output, under that tool's name, so a
// read keeps its text only when the id it reads was stored for a tool turn that carries no health in the same input.
const READ_STORED = 'read_tool_output';
const STORED_ID = /\bto-\d+\b/g;
const storedIdsBySource = (value: unknown): Readonly<{ health: Set<string>; other: Set<string> }> => {
  const ids = { health: new Set<string>(), other: new Set<string>() };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isRecord(node)) return;
    if (isRecord(node['call']) && typeof node['output'] === 'string') {
      for (const [id] of node['output'].matchAll(STORED_ID)) ids[healthTool(node['call']) ? 'health' : 'other'].add(id);
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  return ids;
};
const readId = (args: unknown): unknown => {
  if (typeof args !== 'string') return isRecord(args) ? args['id'] : undefined;
  try { return readId(JSON.parse(args)); } catch { return undefined; }
};
// A read whose source is unknown here (cleared from this input, or unreadable arguments) counts as a health read.
const readsStoredHealth = (call: unknown, stored: ReturnType<typeof storedIdsBySource>): boolean => {
  if (!isRecord(call) || call['name'] !== READ_STORED) return false;
  const id = readId(call['arguments']);
  return !(typeof id === 'string' && stored.other.has(id) && !stored.health.has(id));
};

// A model call's input and output are serialized messages, tool calls and tool turns: a health tool's arguments, its
// turn's output and a read of its stored output are withheld whole, and every other string is scrubbed as prose.
const scrubValue = (value: unknown, stored: ReturnType<typeof storedIdsBySource>): unknown => {
  if (typeof value === 'string') return scrubProse(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, stored));
  if (!isRecord(value)) return value;
  const withheld = new Set<string>([
    ...(healthTool(value) ? ['arguments'] : []),
    ...(healthTool(value['call']) || readsStoredHealth(value['call'], stored) ? ['output'] : []),
  ]);
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, withheld.has(key) ? HEALTH_WITHHELD : scrubValue(field, stored)]));
};

const scrubText = (text: string): string => {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return scrubProse(text); }
  return typeof parsed === 'object' && parsed !== null ? JSON.stringify(scrubValue(parsed, storedIdsBySource(parsed))) : scrubProse(text);
};

const scrubbed = <T extends string | undefined>(value: T): T => (value === undefined ? value : scrubProse(value) as T);

// Throws on malformed input; the caller fails closed.
export const scrubTraceHealth = (entry: TurnLogEntry): TurnLogEntry => {
  const tool = TOOL_HOP.exec(entry.hop)?.[1];
  const text = entry.text === undefined ? undefined
    : tool !== undefined && HEALTH_TOOLS.has(tool)
      ? { input: HEALTH_WITHHELD, ...(entry.text.output === undefined ? {} : { output: HEALTH_WITHHELD }) }
      // A read hop alone cannot tell whose output it reads; the next model call's input carries the same text when it may.
      : tool === READ_STORED
        ? { input: scrubText(entry.text.input), ...(entry.text.output === undefined ? {} : { output: HEALTH_WITHHELD }) }
      : {
        input: scrubText(entry.text.input),
        ...(entry.text.output === undefined ? {} : { output: scrubText(entry.text.output) }),
        ...(entry.text.reasoning === undefined ? {} : { reasoning: scrubText(entry.text.reasoning) }),
      };
  return { ...entry, ...(text === undefined ? {} : { text }), error: scrubbed(entry.error), detail: scrubbed(entry.detail), code: scrubbed(entry.code) };
};
