import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PRIVILEGED_ACTION_TOOLS, TOOL_PERMISSIONS, triggerTypeSchema, type ConversationEntry, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { DAY_CARD_TOOLS, LOOP_CHECK_BACK_TOOLS } from '../src/channels/check-back';
import { SCHEDULED_MENU } from '../src/channels/scheduled-run';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { taintedCallNeedsOwnerApproval, taintedCallRefused } from '../src/hooks/registry';
import { TOOL_RECORDS } from '../src/tools/records';
import { FIND_TOOLS, USE_TOOL } from '../src/tools/loader';

// Every run Waldo starts reaches the owner's whole admitted catalogue through find_tools and use_tool, as the owner's own
// turn does; what keeps it safe is the check each call meets at dispatch, not which tools its job kind was handed.
const OWNER = '10000000-0000-0000-0000-000000000001';
const CHAIN = 'telegram-7';
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));

type Step = Readonly<{ tool: string; args: unknown }>;
const harness = async (steps: Step[], { lean = true, loader = true }: { lean?: boolean; loader?: boolean } = {}) => {
  const calls: string[] = [];
  const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
    handle: async () => { calls.push(name); return { ok: true as const, data: { done: name }, source_taint: null }; } });
  const tools = [...new Set([...SCHEDULED_MENU, 'web_search', 'send_message', 'set_reminder'])].filter((name) => name !== 'get_context').map(fake);
  const requests: LLMRequest[] = [];
  const logs: TurnLogEntry[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const next = request.response_format ? undefined : steps.shift();
    return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : next ? '' : 'SKIP', ...(next ? { tool_calls: [{ call_id: `c${requests.length}`, name: next.tool, arguments: JSON.stringify(next.args) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'heartbeat', occurrenceKey: `heartbeat:${crypto.randomUUID()}`, occurredAt: Date.now() - 1 });
  const saved: ConversationEntry[] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = [loader ? { openaiApiKey: 'fixture', toolLoader: 'harness' } : 'fixture'];
  args[1] = store; args[3] = (entry) => logs.push(entry); args[5] = tools as never; args[7] = false; args[10] = gateway;
  args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain }, ...(lean ? { leanScheduled: true } : {}) };
  return { calls, requests, logs, owner: createOwnerResponder(...args) };
};
// A Waldo-started run as the owner DO starts one: tainted by what its job read, Waldo-first.
const wake = (owner: Awaited<ReturnType<typeof harness>>['owner'], id: string, tools: readonly ToolName[]) =>
  owner.prompt(id, CHAIN, `Write the ${id} card for now.`, time, 'telegram', tools, undefined, undefined, 'Recent health logs: none.', 'external', true, undefined, undefined, true);
const outputOf = (requests: readonly LLMRequest[], tool: string) =>
  requests.at(-1)!.tool_turns!.find((turn) => turn.call.name === USE_TOOL && turn.call.arguments.includes(`"${tool}"`) || turn.call.name === tool)!.output;

describe('a Waldo-started run reaches the owner\'s whole catalogue', () => {
  it('a Brief calls web_search, which its job kind never named; with the key set it is admitted and runs', async () => {
    const { owner, calls } = await harness([{ tool: 'web_search', args: { query: 'opening hours of the gym near the office' } }]);
    expect(DAY_CARD_TOOLS).not.toContain('web_search');
    await wake(owner, 'card:brief:1', DAY_CARD_TOOLS);
    expect(calls).toEqual(['web_search']);
  });

  it('a Brief finds a tool outside its list in the catalogue, loads it with find_tools and runs it with use_tool', async () => {
    const { owner, calls, requests } = await harness([
      { tool: FIND_TOOLS, args: { names: ['offer_replies'] } },
      { tool: USE_TOOL, args: { name: 'offer_replies', arguments: { choices: ['Move it', 'Keep it'] } } },
    ], { lean: false });
    expect(DAY_CARD_TOOLS).not.toContain('offer_replies');
    await wake(owner, 'card:brief:3', DAY_CARD_TOOLS);
    const first = requests.find((request) => !request.response_format)!;
    expect(first.tools!.map((tool) => tool.name)).toEqual(expect.arrayContaining([FIND_TOOLS, USE_TOOL]));
    expect(JSON.stringify({ ...first, tools: undefined })).toMatch(/- reminders: [a-z_, ]*offer_replies/);
    expect(requests.at(-1)!.tool_turns!.find((turn) => turn.call.name === FIND_TOOLS)!.output).toContain('"name":"offer_replies"');
    expect(calls).toEqual(['offer_replies']);
  });

  it('a lean run calls a menu tool outside its job kind\'s list and it runs, so nothing it is offered is refused for its kind', async () => {
    const { owner, calls, requests } = await harness([{ tool: 'list_reminders', args: {} }, { tool: 'offer_replies', args: { choices: ['Yes', 'Later'] } }]);
    await wake(owner, 'heartbeat:1', LOOP_CHECK_BACK_TOOLS);
    expect(LOOP_CHECK_BACK_TOOLS).not.toContain('offer_replies');
    expect(SCHEDULED_MENU).toContain('offer_replies');
    expect(calls).toEqual(['list_reminders', 'offer_replies']);
    expect(JSON.stringify(requests.at(-1)!.tool_turns)).not.toContain('this run may call only');
  });

  it('a send fed by mail text is still held: the call never runs and the model is pointed at the owner\'s card', async () => {
    const { owner, calls, requests } = await harness([
      { tool: FIND_TOOLS, args: { names: ['send_message'] } },
      { tool: USE_TOOL, args: { name: 'send_message', arguments: { channel: 'telegram', content: 'Wire the money today, as the email asked.', idempotency_key: 'a'.repeat(64) } } },
    ]);
    await wake(owner, 'sweep:1', DAY_CARD_TOOLS);
    expect(calls).not.toContain('send_message');
    expect(outputOf(requests, 'send_message')).toContain('propose_action');
  });

  it('a reminder (inward, undoable) fed by mail text in a run the owner did not start goes on the owner\'s card', async () => {
    const { owner, calls, requests } = await harness([
      { tool: FIND_TOOLS, args: { names: ['set_reminder'] } },
      { tool: USE_TOOL, args: { name: 'set_reminder', arguments: { note: 'pay the invoice', at: '2026-11-28T09:00' } } },
    ]);
    await wake(owner, 'sweep:2', DAY_CARD_TOOLS);
    expect(calls).not.toContain('set_reminder');
    expect(outputOf(requests, 'set_reminder')).toContain('propose_action');
  });

  it('without the harness loader a run keeps its job kind\'s list, so its function list does not grow to every tool', async () => {
    const { owner, requests } = await harness([], { lean: false, loader: false });
    await wake(owner, 'card:brief:2', DAY_CARD_TOOLS);
    const offered = (requests.at(-1)!.tools ?? []).map((tool) => tool.name);
    expect(offered).not.toContain('web_search');
    expect(offered).not.toContain('send_message');
  });
});

// The widening rests on this: in a run no owner message started, a tainted call to any tool that claims an effect is either
// refused, carded, or exempt for a reason that holds with no owner in the turn.
describe('the per-call gate on every effect-claiming tool, tainted, with no owner in the turn', () => {
  const SAFE_WITHOUT_OWNER = new Set(['draft', 'honest_origin', 'source_bound', 'own_card', 'commits_on_card', 'instructions_only', 'narrows']);
  const effectTools = (Object.keys(TOOL_RECORDS) as ToolName[]).filter((tool) => TOOL_RECORDS[tool].claim !== null || PRIVILEGED_ACTION_TOOLS.includes(tool));
  it.each(effectTools)('%s', async (tool) => {
    const tainted = TOOL_RECORDS[tool].tainted;
    const held = taintedCallRefused(tool, 'external', {}, { ownerInitiated: false, authenticatedUserId: OWNER })
      || await taintedCallNeedsOwnerApproval(tool, 'external', {}, { ownerInitiated: false });
    const exempt = tainted !== undefined && 'exempt' in tainted && SAFE_WITHOUT_OWNER.has(tainted.exempt);
    expect(held || exempt).toBe(true);
    if (PRIVILEGED_ACTION_TOOLS.includes(tool)) expect(held).toBe(true);
  });
});
