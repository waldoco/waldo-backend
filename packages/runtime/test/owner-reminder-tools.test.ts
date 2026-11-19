import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import type { LLMGatewayAdapter } from '../src/llm/provider';

// "At 6, send Sam the deck": the reminder the owner set carries that request, so when it fires it can draft the mail and put
// it on the owner's card, not only nudge. It holds every tool a Waldo-started run may hold, never the owner-only ones or
// memory writes: its note is Waldo's wording of the request, not the owner's own words.
const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));
const NAMES = ['search_communication', 'web_search', 'send_email', 'draft_email', 'propose_action', 'set_reminder', 'remember', 'track_medication'];

const remind = async (call?: Readonly<{ name: string; args: object }>) => {
  const ran: string[] = [];
  const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
    handle: async () => { ran.push(name); return { ok: true as const, data: { done: name }, source_taint: null }; } });
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const first = !request.response_format && requests.filter((seen) => !seen.response_format).length === 1;
    const tool_calls = first && call ? [{ call_id: 'c1', name: call.name, arguments: JSON.stringify(call.args) }] : undefined;
    return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : tool_calls ? '' : 'The deck for Sam is drafted and waiting on your card.', ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const saved: Parameters<ConversationStore['save']>[0][number][] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[1] = store; args[3] = () => undefined; args[5] = NAMES.map(fake) as never; args[7] = false; args[10] = gateway;
  const owner = createOwnerResponder(...args);
  const reply = await owner.remind('reminder:deck', 'telegram-1', 'Send Sam the Northwind deck', async (_hop, work) => work(), 'telegram');
  const asked = requests.find((request) => !request.response_format)!;
  return { reply, ran, asked, offered: (asked.tools ?? []).map((tool) => tool.name) };
};

describe('a reminder the owner set can do what they asked for at that time', () => {
  it('holds the sends that go on the owner\'s card and the reads, never the owner-only tools or memory writes', async () => {
    const { offered, asked } = await remind();
    expect(offered).toEqual(expect.arrayContaining(['search_communication', 'web_search', 'send_email', 'draft_email', 'propose_action', 'set_reminder']));
    for (const name of ['remember', 'track_medication']) expect(offered).not.toContain(name);
    expect(asked.messages.at(-1)!.content).toContain('do it now with your tools');
  });

  it('drafts the mail it was asked for when the reminder fires', async () => {
    const { ran, reply } = await remind({ name: 'draft_email', args: { to: ['sam@example.test'], subject: 'Northwind deck', body_markdown: 'Here is the deck.' } });
    expect(ran).toContain('draft_email');
    expect(reply).toContain('drafted');
  });

});
