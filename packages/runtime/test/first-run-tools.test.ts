import { describe, expect, it } from 'vitest';
import { approveShownArgsSchema, draftEmailArgsSchema, proposeCalendarChangeArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { FIND_TOOLS, USE_TOOL } from '../src/tools/loader';
import { ownerTyped } from './helpers/owner-typed';

// The three tools a new owner reaches for in their first chat (a go-ahead on a card shown there, a calendar change, a
// draft) are deferred under the harness loader. Each must be named in the catalogue the model reads on that first turn, and
// one find_tools hop then use_tool must reach it. Whether the model takes the hop is measured by the live eval, not here.
const allowed = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
const timer = async <T,>(_hop: string, work: () => Promise<T>) => work();
const FIRST_RUN = [
  { name: 'approve_shown' as const, schema: approveShownArgsSchema, args: { approval_id: 'p1' } },
  { name: 'propose_calendar_change' as const, schema: proposeCalendarChangeArgsSchema, args: { action: 'create', title: 'Focus', start: '2026-11-10T09:00:00Z', end: '2026-11-10T10:00:00Z', reason: 'deep work' } },
  { name: 'draft_email' as const, schema: draftEmailArgsSchema, args: { to: ['sam@example.test'], subject: 'Notes', body_markdown: 'Here are the notes.' } },
];

describe('first-run tools are one find_tools hop away on an owner\'s first turn', () => {
  for (const tool of FIRST_RUN) {
    it(`${tool.name}: named in the catalogue, then loaded and run`, async () => {
      const ran: unknown[] = [];
      const requests: LLMGatewayRequest['request'][] = [];
      const steps = [
        { name: FIND_TOOLS, arguments: JSON.stringify({ names: [tool.name] }) },
        { name: USE_TOOL, arguments: JSON.stringify({ name: tool.name, arguments: tool.args }) },
      ];
      const gateway: LLMGatewayAdapter = { async complete(request) {
        requests.push(request.request);
        const reply = (text: string, call?: { name: string; arguments: string }) => ({ ok: true as const, data: { model: request.request.model, text, ...(call ? { tool_calls: [{ call_id: `c${requests.length}`, ...call }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
        if (request.request.response_format) return reply('{}');
        const next = steps.shift();
        return next ? reply('', next) : reply('Done.');
      } };
      const handler = { name: tool.name, description: `fixture ${tool.name}`, schema: tool.schema, trigger_allowlist: allowed(tool.name), autonomy_gated: false,
        handle: async (args: unknown) => { ran.push(args); return { ok: true as const, data: { done: true }, source_taint: null }; } };
      const responder = createOwnerResponder({ openaiApiKey: 'fixture-openai', primary: 'openai', toolLoader: 'harness' }, undefined, undefined, undefined, undefined, [handler] as never, undefined, false, undefined, undefined, gateway);
      await responder.respond(ownerTyped({ traceId: `owner-${crypto.randomUUID()}`, conversationRef: 'owner', surface: 'whatsapp', text: 'hello', messageRef: { id: 'wamid.first', conversationRef: 'owner' } }), timer);

      const first = requests.find((request) => !request.response_format)!;
      // Offered in the function list, or named on its group's catalogue line ("- <group>: a, b. <what the group is for>").
      const catalogued = new RegExp(`- [a-z_]+: (?:[a-z_]+, )*${tool.name}[,.]`).test(JSON.stringify({ ...first, tools: undefined }));
      expect(catalogued || first.tools!.some((offered) => offered.name === tool.name)).toBe(true);
      expect(ran).toEqual([tool.args]);
    });
  }
});
