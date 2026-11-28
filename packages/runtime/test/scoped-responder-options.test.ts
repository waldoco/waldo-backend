import { describe, expect, it } from 'vitest';
import { draftEmailArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type ToolName } from '@waldo/contracts';
import { createOwnerResponder, scopedOwner } from '../src/channels/owner-turn';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { FIND_TOOLS, USE_TOOL } from '../src/tools/loader';
import { ownerTyped } from './helpers/owner-typed';

const timer = async <T,>(_hop: string, work: () => Promise<T>) => work();
const scope = (runId: string): RunEffectScope => ({ runId, attempt: `${runId}-attempt`, deadline: Date.now() + 600_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() });
const allowed = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));

// Every owner message on a live surface carries a run scope, so the owner's turn runs in a responder built for that scope.
// What the model loaded on one turn must still be offered on the next one there, as it is in an unscoped responder.
describe('a scoped owner turn keeps the tools the model loaded', () => {
  it('a tool loaded on turn N is in the function list on turn N+1', async () => {
    const { loadedToolsBook } = await import('../src/tools/loaded');
    const map = new Map<string, unknown>();
    const book = loadedToolsBook({ get: <T,>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } });
    const args = { to: ['sam@example.test'], subject: 'Notes', body_markdown: 'Here are the notes.' };
    const requests: LLMGatewayRequest['request'][] = [];
    const steps = [{ name: FIND_TOOLS, arguments: JSON.stringify({ names: ['draft_email'] }) }, { name: USE_TOOL, arguments: JSON.stringify({ name: 'draft_email', arguments: args }) }];
    const gateway: LLMGatewayAdapter = { async complete(request) {
      requests.push(request.request);
      const reply = (text: string, call?: { name: string; arguments: string }) => ({ ok: true as const, data: { model: request.request.model, text, ...(call ? { tool_calls: [{ call_id: `c${requests.length}`, ...call }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
      if (request.request.response_format) return reply('{}');
      const next = steps.shift();
      return next ? reply('', next) : reply('Done.');
    } };
    const handler = { name: 'draft_email', description: 'fixture draft_email', schema: draftEmailArgsSchema, trigger_allowlist: allowed('draft_email'), autonomy_gated: false,
      handle: async () => ({ ok: true as const, data: { done: true }, source_taint: null }) };
    const owner = { promotedTools: () => book.names(Date.now()), noteLoaded: (names: readonly string[]) => book.note(names, Date.now()) };
    const responder = createOwnerResponder({ openaiApiKey: 'fixture-openai', primary: 'openai', toolLoader: 'harness' }, undefined, undefined, undefined, undefined, [handler] as never, undefined, false, undefined, undefined, gateway,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, owner);
    const say = (id: string) => responder.respond(ownerTyped({ traceId: `owner-${id}`, conversationRef: 'owner', surface: 'whatsapp', text: 'hello', messageRef: { id: `wamid.${id}`, conversationRef: 'owner' }, runScope: scope(`run-${id}`) }), timer);
    await say('one');
    expect(book.names(Date.now())).toEqual(['draft_email']);
    const before = requests.length;
    await say('two');
    const second = requests.slice(before).find((request) => !request.response_format)!;
    expect(second.tools!.map((offered) => offered.name)).toContain('draft_email');
  });
});

// The fields each scoped responder is built with. A Waldo-started run's own fields never reach the owner's chat, and the
// job host never reaches any scoped responder (asOwnerJob reads its absence as "already the owner's job").
describe('scopedOwner', () => {
  const fn = () => [] as readonly string[];
  const everything = {
    jobHost: { admit: async () => undefined, chain: () => 'c' }, leanScheduled: true, jobOutcomeRows: true, machineTime: () => undefined,
    waldoSent: () => [], memoryChat: () => 'c', promptOwnText: () => true, promotedTools: fn, noteLoaded: () => undefined,
    spend: () => ({ spentUsd: 0, ceilingUsd: 1 }), forgetBarrier: 'items' as const, watchStatus: () => '', asyncTools: true,
    history: (() => undefined) as never, compactionFlush: (async () => undefined) as never, timelineSeed: {} as never,
  };

  it('chat gets the tools the model loaded and none of a Waldo-started run\'s own fields', () => {
    const chat = scopedOwner('chat', everything, {});
    expect(chat.promotedTools).toBe(fn);
    expect(chat.noteLoaded).toBe(everything.noteLoaded);
    expect(chat.spend).toBe(everything.spend);
    expect(chat.asyncTools).toBe(true);
    for (const jobOnly of ['leanScheduled', 'jobOutcomeRows', 'machineTime', 'waldoSent', 'memoryChat', 'promptOwnText', 'jobHost'] as const) expect(chat[jobOnly]).toBeUndefined();
  });

  it('a job keeps its own fields and gets no chat-only host', () => {
    const job = scopedOwner('job', everything, {});
    expect(job.leanScheduled).toBe(true);
    expect(job.jobOutcomeRows).toBe(true);
    expect(job.promotedTools).toBe(fn);
    expect(job.watchStatus).toBeUndefined();
    expect(job.asyncTools).toBeUndefined();
    expect(job.history).toBeUndefined();
    expect(job.jobHost).toBeUndefined();
  });

  it('compaction gets its history, flush and timeline seed only', () => {
    const compaction = scopedOwner('compaction', everything, {});
    expect(Object.keys(compaction).sort()).toEqual(['compactionFlush', 'forgetBarrier', 'history', 'timelineSeed']);
  });

  it('what the scope itself prepared wins, and a falsy field is left out', () => {
    const built = scopedOwner('chat', { ...everything, asyncTools: false }, { context: 'mine' as never });
    expect(built.context).toBe('mine');
    expect('asyncTools' in built).toBe(false);
  });
});
