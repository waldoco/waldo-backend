import { expect, it } from 'vitest';
import { EXTERNAL_ORIGIN_TOOLS, TOOL_PERMISSIONS, triggerTypeSchema, type ToolHandler, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { CHILD_READ_TOOLS, CHILD_TOOL_NAMES } from '../src/conversation/subagent';
import { TOOL_ARG_SCHEMAS } from '../src/hooks/registry';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
import { getContextHandler } from '../src/tools/live/get-context';
import { TOOL_RECORDS } from '../src/tools/records';
import { ownerTyped } from './helpers/owner-typed';

// A subagent researches for the owner's turn: it holds every read tool whose handler only reads, page reads included, and
// nothing that acts. The parent's outside text follows it into the child, and the child's report taints the parent.
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-21T08:20:00Z') };

it('a child holds every read tool by default, page reads included, and nothing that acts', () => {
  expect(CHILD_TOOL_NAMES).toEqual(CHILD_READ_TOOLS);
  expect(CHILD_TOOL_NAMES).toEqual(expect.arrayContaining(['browse_page', 'web_search', 'read_thread', 'query_calendar', 'read_memory']));
  for (const tool of ['delegate_task', 'read_tool_output', 'browse_act', 'send_message', 'workspace_write', 'set_reminder', 'start_task']) expect(CHILD_TOOL_NAMES).not.toContain(tool);
  // One page read at a time: the loop never batches a tool that is not concurrent.
  expect(TOOL_RECORDS.browse_page.concurrent).toBe(false);
});

it('a child spawned after the parent read outside text starts tainted, reads pages, and its report taints the parent', async () => {
  const seen: Array<readonly [string, unknown]> = [];
  const stub = (tool: ToolName, data: unknown): ToolHandler<unknown, unknown, ToolDispatcherContext> => ({
    name: tool, description: tool, schema: TOOL_ARG_SCHEMAS[tool] as never, trigger_allowlist: allowlist(tool), autonomy_gated: false,
    handle: async (_args, ctx) => { seen.push([tool, ctx.toolArgSourceTaint]); return { ok: true, data, source_taint: EXTERNAL_ORIGIN_TOOLS.includes(tool) ? 'external' : null }; },
  });
  const steps: ReadonlyArray<Readonly<{ tool: string; args: Record<string, unknown> }> | Readonly<{ text: string }>> = [
    { tool: 'search_communication', args: { query: 'vendor' } },
    { tool: 'delegate_task', args: { task: 'read the vendor page and report its opening hours' } },
    { tool: 'read_memory', args: { query: 'vendor' } },
    { tool: 'browse_page', args: { url: 'https://example.com/vendor', instruction: 'the opening hours' } },
    { text: 'Open 9 to 5.' },
    { text: 'They open at nine.' },
  ];
  const requests: LLMGatewayRequest[] = [];
  let index = 0;
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    const step = steps[Math.min(index++, steps.length - 1)]!;
    const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    return 'text' in step ? { ok: true, data: { ...base, text: step.text } }
      : { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: `call-${index}`, name: step.tool, arguments: JSON.stringify(step.args) }] } };
  } };
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', primary: 'openai', floorReply: true }];
  args[4] = clock;
  args[5] = [getContextHandler(clock), stub('search_communication', { messages: [] }), stub('read_memory', { claims: [] }), stub('browse_page', { text: 'Open 9 to 5.' })] as never;
  args[10] = gateway; args[16] = ['example.com']; args[18] = ['👌'];
  await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'child-reads', conversationRef: 'telegram-1', surface: 'telegram', text: 'when does the vendor open?', memoryWrites: false }), time);
  const tools = (request: LLMGatewayRequest) => (request.request.tools ?? []).map((tool) => tool.name);
  const child = requests.find((request) => !tools(request).includes('delegate_task'))!;
  expect(tools(child)).toEqual(expect.arrayContaining(['browse_page', 'read_memory', 'search_communication']));
  expect(seen).toEqual([['search_communication', null], ['read_memory', 'external'], ['browse_page', 'external']]);
  const parentAfter = requests.at(-1)!.request.tool_turns ?? [];
  expect(parentAfter.find((turn) => turn.call.name === 'delegate_task')).toMatchObject({ source_taint: 'external' });
});
