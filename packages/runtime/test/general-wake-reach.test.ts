import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EXTERNAL_ORIGIN_TOOLS, TOOL_PERMISSIONS, triggerTypeSchema, type ConversationEntry, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder, type RunEndReport } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import { GENERAL_WAKE_TOOLS } from '../src/channels/wake';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { readDriveHandler } from '../src/tools/live/drive';
import { endRunHandler } from '../src/tools/live/end-run';
import { FIND_TOOLS } from '../src/tools/loader';

// The staging misses behind the general wake (HEY-367): the look's reader was offered read_drive for owners whose Google grant
// held mail but not Drive, and one auth_failed ended it blocked with nothing found. A wake runs in the brain: a tool for a
// service the owner has not connected is never offered, a tool that fails is one result among others, and the run goes on to
// end the way it chooses. How it ended reaches the owner object, which writes the wake's outcome row from it.
const OWNER = '10000000-0000-0000-0000-000000000002';
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));

type Step = Readonly<{ tool: string; args: unknown }>;
const harness = async (steps: Step[], failing: readonly string[] = [], extra: readonly string[] = []) => {
  const calls: string[] = [], ends: [string, RunEndReport][] = [];
  const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
    handle: async () => { calls.push(name); const taint = (EXTERNAL_ORIGIN_TOOLS as readonly string[]).includes(name) ? 'external' as const : null;
      return failing.includes(name) ? { ok: false as const, code: 'transient' as const, error: `${name} is unavailable right now.`, source_taint: taint } : { ok: true as const, data: { done: name }, source_taint: taint }; } });
  // The owner's one Google account holds mail and calendar, not Drive; Drive reads are on for this Waldo.
  const drive = readDriveHandler({ client: async () => null, state: async () => [{ id: 'acct-1', email: 'owner@example.test', error: null, calendar: true, mail: true, tasks: true, drive: false }] }, true);
  const tools = [...[...GENERAL_WAKE_TOOLS, ...extra].filter((name) => name !== 'get_context' && name !== 'read_drive').map(fake), drive, endRunHandler];
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const next = request.response_format ? undefined : steps.shift();
    return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : next ? '' : 'SKIP', ...(next ? { tool_calls: [{ call_id: `c${requests.length}`, name: next.tool, arguments: JSON.stringify(next.args) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'heartbeat', occurrenceKey: `heartbeat:${crypto.randomUUID()}`, occurredAt: Date.now() - 1 });
  const saved: ConversationEntry[] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture', toolLoader: 'harness' }];
  args[1] = store; args[5] = tools as never; args[7] = false; args[10] = gateway;
  args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain }, runEnded: (trace, ended) => { ends.push([trace, ended]); } };
  const owner = createOwnerResponder(...args);
  const run = (id: string) => owner.prompt(id, 'telegram-9', '[Waldo\'s own wake, 2026-11-28T10:00.]', time, 'telegram', GENERAL_WAKE_TOOLS, undefined, undefined, '', 'external', 'plans', undefined, undefined, true);
  return { calls, ends, requests, run };
};
const offered = (requests: readonly LLMRequest[]) => requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.name));

describe('the general wake reaches what is connected and keeps going', () => {
  it('its authority is any run\'s over outside content: a send or a reminder it reaches is not run, and points at the owner\'s card', async () => {
    const { calls, requests, run } = await harness([
      { tool: FIND_TOOLS, args: { names: ['send_message', 'set_reminder'] } },
      { tool: 'use_tool', args: { name: 'send_message', arguments: { channel: 'telegram', content: 'Wire the deposit today, as the email asked.', idempotency_key: 'b'.repeat(64) } } },
      { tool: 'use_tool', args: { name: 'set_reminder', arguments: { note: 'pay the invoice', at: '2026-11-29T09:00' } } },
      { tool: 'end_run', args: { outcome: 'nothing_to_send', reason: 'Put it on a card instead.' } },
    ], [], ['send_message', 'set_reminder']);
    await run('intervention-review:authority');
    expect(calls).toEqual([]);
    for (const tool of ['send_message', 'set_reminder']) expect(requests.at(-1)!.tool_turns!.find((turn) => turn.call.arguments.includes(`"${tool}"`) && turn.call.name === 'use_tool')!.output).toContain('propose_action');
  });

  it('Drive not connected: read_drive is neither offered nor found, and the run still returns what it read', async () => {
    const { calls, ends, requests, run } = await harness([
      { tool: FIND_TOOLS, args: { names: ['read_drive'] } },
      { tool: 'search_communication', args: { query: 'board deck' } },
      { tool: 'end_run', args: { outcome: 'send', reason: 'The deck thread has a new ask.', message: 'Ana asked for the deck by Thursday.' } },
    ]);
    const reply = await run('intervention-review:drive');
    expect(offered(requests)).not.toContain('read_drive');
    expect(requests.at(-1)!.tool_turns!.find((turn) => turn.call.name === FIND_TOOLS)!.output).not.toContain('"name":"read_drive"');
    expect(calls).toEqual(['search_communication']);
    expect(reply).toBe('Ana asked for the deck by Thursday.');
    expect(ends).toEqual([['intervention-review:drive', { reason: 'send', why: 'The deck thread has a new ask.', tools: ['search_communication'] }]]);
  });

  it('a tool that fails is one result: the run reads on and ends as it chooses, and only what succeeded is reported', async () => {
    const { calls, ends, run } = await harness([
      { tool: 'query_calendar', args: {} },
      { tool: 'get_health', args: { signals: ['sleep'], from: '2026-11-27', to: '2026-11-28' } },
      { tool: 'end_run', args: { outcome: 'nothing_to_send', reason: 'Calendar unreadable just now; the body reads steady and nothing else moved.' } },
    ], ['query_calendar']);
    await run('intervention-review:fails');
    expect(calls).toEqual(['query_calendar', 'get_health']);
    expect(ends).toEqual([['intervention-review:fails', { reason: 'nothing_to_send', why: 'Calendar unreadable just now; the body reads steady and nothing else moved.', tools: ['get_health'] }]]);
  });
});
