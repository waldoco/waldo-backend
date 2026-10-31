import { z } from 'zod';
import { toolError, toolNameSchema, type LLMTool, type LLMToolCall, type ToolError } from '@waldo/contracts';
import type { LoopToolResult } from '../conversation/tool-loop';
import { BRAIN_NAMESPACES, TOOL_RECORDS, byToolName, type BrainNamespace, type ToolRecord } from './records';

// The harness's own tool search, for any function-calling model. A round offers the core tools and two meta tools:
// find_tools, whose result is the definitions asked for, and use_tool, which calls one of them by name. The system prompt
// carries the catalogue of everything else this turn admitted (toolCatalogue), since a tool description is capped at
// 1,024 characters. The offered list never changes within a turn, so the provider's cached
// prefix holds, and the definitions a turn loads arrive as tool results at the end of the context. use_tool is resolved
// back to the call it names before dispatch, so every gate a direct call meets (ACL, held tools, taint, approval, schema)
// meets this one too.
export const FIND_TOOLS = 'find_tools';
export const USE_TOOL = 'use_tool';
export const META_TOOLS: ReadonlySet<string> = new Set([FIND_TOOLS, USE_TOOL]);

// The call the loop runs for one model call: the call itself, the call use_tool names (via), or the loader's own answer.
export type RoutedCall = Readonly<{ call: LLMToolCall; via?: typeof USE_TOOL; answer?: LoopToolResult }>;
export type ToolLoader = Readonly<{
  offered: readonly LLMTool[];
  route(call: LLMToolCall): RoutedCall;
  definition(name: string): LLMTool | undefined;
}>;

const findArgsSchema = z.strictObject({
  groups: z.array(z.string().min(1).max(40)).max(Object.keys(BRAIN_NAMESPACES).length).optional(),
  names: z.array(z.string().min(1).max(80)).max(20).optional(),
}).refine(({ groups, names }) => (groups?.length ?? 0) + (names?.length ?? 0) > 0);
const useArgsSchema = z.strictObject({ name: z.string().min(1).max(80), arguments: z.record(z.string(), z.unknown()).optional() });

const parse = (raw: string): unknown => { try { return JSON.parse(raw || '{}'); } catch { return undefined; } };
const refused = (error: ToolError, code: string): LoopToolResult =>
  ({ ok: false, error: error.cause, error_code: error.code, fix: error.fix, retryable: error.retryable, code, reason: code });
// The tool a recorded call ran: the one a use_tool call names, else the call's own name. The history keeps the model's
// use_tool call, so whatever reads a tool turn by its tool (taint, the outside-data label, the forget barrier) reads this.
// Only a real tool name counts; the name inside use_tool is the model's free text.
export const toolOfCall = (call: Pick<LLMToolCall, 'name' | 'arguments'>): string => {
  if (call.name !== USE_TOOL) return call.name;
  const args = useArgsSchema.safeParse(parse(call.arguments));
  return args.success && toolNameSchema.safeParse(args.data.name).success ? args.data.name : call.name;
};
export const isDeferredTool = (name: string): boolean => placement(name) !== 'core';
const placement = (name: string): 'core' | BrainNamespace => (TOOL_RECORDS as Partial<Record<string, ToolRecord>>)[name]?.brain ?? 'core';

const deferredGroups = (names: readonly string[]): Map<BrainNamespace, string[]> => {
  const groups = new Map<BrainNamespace, string[]>();
  for (const name of names) {
    const place = placement(name);
    if (place !== 'core') groups.set(place, [...(groups.get(place) ?? []), name]);
  }
  return groups;
};

// The tools a turn admitted beyond its function list, one line per group: the exact names, then what the group is for.
// Empty when every admitted tool is core. Groups follow BRAIN_NAMESPACES and names sort within a group, so the same admitted
// set gives the same bytes in the cached system prefix whatever order the host assembled its handlers in.
export const toolCatalogue = (names: readonly string[]): string => {
  const groups = deferredGroups(names);
  return (Object.keys(BRAIN_NAMESPACES) as BrainNamespace[]).flatMap((group) => {
    const members = groups.get(group);
    return members ? [`- ${group}: ${[...members].sort().join(', ')}. ${BRAIN_NAMESPACES[group]}`] : [];
  }).join('\n');
};

type FindArgs = z.infer<typeof findArgsSchema>;
const wantedBy = (args: FindArgs, groups: ReadonlyMap<BrainNamespace, readonly string[]>, byName: ReadonlyMap<string, LLMTool>): string[] =>
  [...(args.groups ?? []).flatMap((group) => groups.get(group as BrainNamespace) ?? []), ...(args.names ?? []).filter((name) => byName.has(name))];

// The tool names a find_tools call loads from the tools a turn admitted, read from the call's own arguments.
export const namesLoadedBy = (tools: readonly LLMTool[], rawArguments: string): readonly string[] => {
  const args = findArgsSchema.safeParse(parse(rawArguments));
  return args.success ? [...new Set(wantedBy(args.data, deferredGroups(tools.map((tool) => tool.name)), new Map(tools.map((tool) => [tool.name, tool] as const))))] : [];
};

export function harnessToolLoader(tools: readonly LLMTool[]): ToolLoader {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  const groups = deferredGroups(tools.map((tool) => tool.name));
  const core = tools.filter((tool) => placement(tool.name) === 'core').sort(byToolName);
  if (groups.size === 0) return { offered: core, route: (call) => ({ call }), definition: (name) => byName.get(name) };
  const offered: LLMTool[] = [
    ...core,
    {
      name: FIND_TOOLS,
      description: 'Load the full definitions of tools that are not in your function list, by group or exact name from the tool catalogue in your instructions. Then call them with use_tool.',
      parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' }, description: 'Group names from the tool catalogue.' }, names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names from the tool catalogue.' } }, additionalProperties: false },
    },
    {
      name: USE_TOOL,
      description: 'Call a tool from the tool catalogue by its exact name, with arguments that match the definition find_tools returned. It runs as a direct call to that tool would, with the same checks and approvals.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The exact tool name.' }, arguments: { type: 'object', description: 'The tool\'s arguments, as its definition describes them.' } }, required: ['name'], additionalProperties: false },
    },
  ];
  const find = (call: LLMToolCall): LoopToolResult => {
    const raw = parse(call.arguments);
    if (raw === undefined) return refused(toolError('invalid_json_args'), 'invalid_args');
    const args = findArgsSchema.safeParse(raw);
    if (!args.success) return refused(toolError('invalid_args', 'find_tools needs at least one group or tool name from its list.'), 'invalid_args');
    const wanted = wantedBy(args.data, groups, byName);
    const missing = [...(args.data.groups ?? []).filter((group) => !groups.has(group as BrainNamespace)), ...(args.data.names ?? []).filter((name) => !byName.has(name))];
    return { ok: true, data: { tools: [...new Set(wanted)].map((name) => byName.get(name)!), ...(missing.length ? { not_found: missing } : {}) }, source_taint: null };
  };
  return {
    offered,
    definition: (name) => byName.get(name),
    route: (call) => {
      if (call.name === FIND_TOOLS) return { call, answer: find(call) };
      if (call.name !== USE_TOOL) return { call };
      const raw = parse(call.arguments);
      if (raw === undefined) return { call, answer: refused(toolError('invalid_json_args'), 'invalid_args') };
      const args = useArgsSchema.safeParse(raw);
      if (!args.success) return { call, answer: refused(toolError('invalid_args', 'use_tool needs the exact tool name and its arguments.'), 'invalid_args') };
      // Only a tool this turn admitted becomes the call's name: the call stays use_tool otherwise, so the model's free text
      // never names a hop, a receipt or a ledger row, and the refusal does not echo it.
      if (META_TOOLS.has(args.data.name) || !byName.has(args.data.name)) return { call, answer: refused(toolError('unknown_tool'), 'unknown_tool') };
      return { call: { call_id: call.call_id, name: args.data.name, arguments: JSON.stringify(args.data.arguments ?? {}) }, via: USE_TOOL };
    },
  };
}

// The ceiling on the tool definitions the model sees each round, in estimated tokens (bytes / 4), on either provider's wire.
// It guards spend and creep, not reach: deferred tools still load when a turn needs them.
export const TOOL_DEFINITION_BUDGET_TOKENS = 4_200;
export const estimatedTokens = (value: unknown): number => Math.round(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength / 4);

// At most this many deferred tools ride from one owner turn to the next.
export const CARRIED_TOOLS_MAX = 8;
const CARRIED_HEADER = '\n\n[Tool definitions you loaded on your previous turn, host facts. Call one with use_tool by its exact name and these arguments; no find_tools round is needed for it.]\n';

// What the next owner turn's message appends: the definitions of the deferred tools the last owner turn loaded or used,
// read from the tools this turn admitted, so a tool revoked or disabled since, or one whose schema changed, is shown as it is now
// or not at all. It rides the owner's message, never the offered list or the system prompt, so the cached prefix is untouched,
// and the offered list plus this block stay inside TOOL_DEFINITION_BUDGET_TOKENS: a tool that does not fit is left to find_tools.
export const carriedToolBlock = (admitted: readonly LLMTool[], carried: readonly string[], budgetTokens = TOOL_DEFINITION_BUDGET_TOKENS): Readonly<{ names: readonly string[]; text: string }> => {
  const byName = new Map(admitted.map((tool) => [tool.name, tool] as const));
  let room = budgetTokens - estimatedTokens(harnessToolLoader(admitted).offered) - estimatedTokens(CARRIED_HEADER);
  const shown: LLMTool[] = [];
  for (const name of carried) {
    const tool = byName.get(name);
    if (!tool || META_TOOLS.has(name) || !isDeferredTool(name) || shown.some((kept) => kept.name === name) || shown.length >= CARRIED_TOOLS_MAX) continue;
    const cost = estimatedTokens(tool);
    if (cost > room) continue;
    room -= cost;
    shown.push(tool);
  }
  if (shown.length === 0) return { names: [], text: '' };
  return { names: shown.map((tool) => tool.name), text: CARRIED_HEADER + JSON.stringify(shown).replace(/[<>]/g, (char) => (char === '<' ? '\\u003c' : '\\u003e')) };
};

// The deferred tools each owner chain's last owner turn loaded or used, newest chains kept. The owner object holds one, since
// its runtime and responder are rebuilt between messages. It lives in that object's memory only: an eviction loses a hint and costs one find_tools round, never a fact.
export type CarryBook = ReturnType<typeof carryBook>;
export const carryBook = (maxChains = 16) => {
  const byChain = new Map<string, readonly string[]>();
  return {
    get: (chain: string): readonly string[] => byChain.get(chain) ?? [],
    set: (chain: string, names: readonly string[]): void => {
      byChain.delete(chain);
      if (names.length === 0) return;
      byChain.set(chain, names.slice(0, CARRIED_TOOLS_MAX));
      while (byChain.size > maxChains) byChain.delete(byChain.keys().next().value!);
    },
  };
};
