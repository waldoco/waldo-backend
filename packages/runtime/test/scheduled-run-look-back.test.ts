import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import { OUTSIDE_TEXT_JOB_TOOLS } from '../src/channels/check-back';
import { episodeIndex } from '../src/channels/episodes';
import { LOOK_BACK, SCHEDULED_MENU } from '../src/channels/scheduled-run';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { searchEpisodesHandler } from '../src/tools/live/search-episodes';

// A Brief written by a run Waldo started reaches a week-old WhatsApp discussion about the owner's pitch: the run is offered
// search_episodes in its function list (not one find_tools hop away), told that older conversation lives there, and what it
// finds reaches its next call. The row sits on another surface and outside the last three owner messages a lean run reads.
const OWNER = '10000000-0000-0000-0000-000000000001';
const PRINCIPAL = 'prn_10000000000000000000000000000001';
const PITCH = 'For the Northwind pitch on Friday, lead with the pilot numbers and keep the ask to one slide.';
const WEEK_AGO = Date.parse('2026-11-12T09:00:00Z');

const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));
const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
  handle: async () => ({ ok: true as const, data: { done: name }, source_taint: null }) });
const PROPOSES = ['propose_calendar_change', 'propose_action'] as const;

const briefRun = async (sql: SqlStorage, loader: boolean, offload = false) => {
  const index = episodeIndex(sql);
  index.add('whatsapp-1', 'owner', PITCH, WEEK_AGO);
  const tools = [...SCHEDULED_MENU.filter((name) => name !== 'get_context' && name !== 'search_episodes').map(fake), searchEpisodesHandler(index)];
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const offered = (request.tools ?? []).map((tool) => tool.name);
    const first = requests.filter((seen) => !seen.response_format).length === 1;
    const call = !request.response_format && first && offered.includes('search_episodes') ? { call_id: 'look', name: 'search_episodes', arguments: JSON.stringify({ query: 'pitch' }) } : undefined;
    const text = request.response_format ? '{}' : call ? '' : 'Your Northwind pitch is Friday: lead with the pilot numbers, one slide for the ask.';
    return { ok: true, data: { model: request.model, text, ...(call ? { tool_calls: [call] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'heartbeat', occurrenceKey: `brief:${crypto.randomUUID()}`, occurredAt: Date.now() - 1 });
  const saved: Parameters<ConversationStore['save']>[0][number][] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = [loader ? { openaiApiKey: 'fixture', toolLoader: 'harness' } : 'fixture'];
  args[1] = store; args[3] = () => undefined; args[5] = tools as never; args[7] = offload; args[10] = gateway;
  args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain }, dayCards: () => 'Today: Brief due 07:30.', leanScheduled: true };
  const owner = createOwnerResponder(...args);
  const reply = await owner.prompt('card:brief:2026-11-19', 'app-main', 'Write the Daily Brief for today. Calendar: 10:00 Northwind pitch rehearsal.', async (_hop, work) => work(), 'app',
    [...OUTSIDE_TEXT_JOB_TOOLS, ...PROPOSES], undefined, undefined, 'Recent health logs: none.', 'external', 'plans', undefined, [...PROPOSES], true);
  return { reply, requests: requests.filter((request) => !request.response_format) };
};

const withSql = <T,>(name: string, work: (sql: SqlStorage) => Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)), async (_instance, state) => work(state.storage.sql));

describe('a Brief run Waldo started looks back past its lean view', () => {
  it.each([true, false])('is offered search_episodes directly and told where older conversation is; what it finds reaches its next call (harness loader %s)', async (loader) => {
    const { reply, requests } = await withSql(`look-back-${loader}`, (sql) => briefRun(sql, loader));
    const [first, second] = requests;
    expect((first!.tools ?? []).map((tool) => tool.name)).toContain('search_episodes');
    expect(first!.messages.at(-1)!.content).toContain(LOOK_BACK);
    expect(JSON.stringify(second)).toContain('lead with the pilot numbers');
    expect(reply).toContain('Northwind');
  });

  it('holds read_tool_output when its results can be stored, so a pointer in a long result is one call away', async () => {
    const { requests } = await withSql('look-back-offload', (sql) => briefRun(sql, true, true));
    expect((requests[0]!.tools ?? []).map((tool) => tool.name)).toEqual(expect.arrayContaining(['read_memory', 'search_episodes', 'read_tool_output']));
  });
});
