import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { ConversationStore } from '../src/channels/conversation-store';
import { DAY_CARD_TOOLS, LOOP_CHECK_BACK_TOOLS, OUTSIDE_TEXT_JOB_TOOLS } from '../src/channels/check-back';
import { claimStore, memoryPrompt, withOutsideNotes, WALDO_RUN_REF, type ClaimStore } from '../src/memory/claims';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';
import type { LLMGatewayAdapter } from '../src/llm/provider';

// A run Waldo started (a Brief, a check-back) keeps what it learned instead of losing it until the nightly pass: as Waldo's
// own note, sourced to the run, never as the owner's words. It replaces nothing, names no one and keeps no health detail.
const OWNER = 'prn_10000000000000000000000000000001';
const NOTE = { kind: 'fact', text: 'The Northwind pitch moved to Friday.', evidence_quote: 'Calendar: Northwind pitch, Friday 10:00' };

const withSql = <T,>(name: string, work: (sql: SqlStorage) => Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)), async (_instance, state) => work(state.storage.sql));
const rememberIn = (sql: SqlStorage, store: ClaimStore, conversationRef = 'owner') => memoryHandlers({ sql, store, conversationRef, hideHistory: async () => undefined }).find((tool) => tool.name === 'remember')!;
const runCtx = (over: Partial<MemoryToolContext> = {}) => ({ authenticatedUserId: OWNER, trigger: 'user_message', memoryRun: { ownerId: OWNER, conversationRef: 'owner', runId: 'card:brief:1' }, ...over }) as unknown as MemoryToolContext;

describe('remember in a run Waldo started', () => {
  it('keeps the note as Waldo\'s own, sourced to the run, and memory shows it as Waldo\'s read', async () => {
    await withSql('waldo-run-note', async (sql) => {
      const store = claimStore(sql);
      const result = await rememberIn(sql, store).handle(NOTE as never, runCtx()) as { ok: boolean; data: { status: string; source: string } };
      expect(result).toMatchObject({ ok: true, data: { status: 'stored', source: 'waldo' } });
      const [claim] = store.claims();
      expect(claim).toMatchObject({ text: NOTE.text, origin: 'agent', source: 'inferred', source_ref: `${WALDO_RUN_REF}card:brief:1` });
      expect(memoryPrompt(store)).toContain('Waldo\'s own note from a run it started');
    });
  });

  it('keeps what it read from outside content only as a note learned from outside content, where those are kept', async () => {
    await withSql('waldo-run-outside', async (sql) => {
      const plain = claimStore(sql);
      expect(await rememberIn(sql, plain).handle(NOTE as never, runCtx({ toolArgSourceTaint: 'external' }))).toMatchObject({ ok: false });
      const outside = withOutsideNotes(plain);
      expect(await rememberIn(sql, outside).handle(NOTE as never, runCtx({ toolArgSourceTaint: 'external' }))).toMatchObject({ ok: true, data: { source: 'outside' } });
      expect(plain.allClaims().map((claim) => claim.origin)).toEqual(['untrusted']);
    });
  });

  it.each([
    ['a health note', { ...NOTE, kind: 'health', text: 'Sleep was short this week.' }],
    ['a reading filed as a fact', { ...NOTE, text: 'Resting heart rate was 58 bpm this morning.' }],
    ['a correction of what the owner said', { ...NOTE, replaces_id: 1 }],
    ['a note naming a person', { ...NOTE, people: [{ name: 'Priya' }] }],
  ])('refuses %s', async (_name, args) => {
    await withSql(`waldo-run-refuse-${_name}`, async (sql) => {
      const store = claimStore(sql);
      expect(await rememberIn(sql, store).handle(args as never, runCtx())).toMatchObject({ ok: false });
      expect(store.allClaims()).toEqual([]);
    });
  });

  it('refuses a run for another owner, and a call with no run or turn at all', async () => {
    await withSql('waldo-run-other', async (sql) => {
      const store = claimStore(sql);
      const remember = rememberIn(sql, store);
      expect(await remember.handle(NOTE as never, runCtx({ memoryRun: { ownerId: 'prn_other', conversationRef: 'owner', runId: 'x' } }))).toMatchObject({ ok: false });
      expect(await remember.handle(NOTE as never, runCtx({ memoryRun: undefined }))).toMatchObject({ ok: false });
      expect(store.allClaims()).toEqual([]);
    });
  });
});

const allowed = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly string[]).includes(name));
const offeredTo = async (toolNames: readonly ToolName[]) => {
  const fake = (name: string) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
    handle: async () => ({ ok: true as const, data: { done: name }, source_taint: null }) });
  const requests: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => { requests.push(request); return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } }; } };
  const saved: Parameters<ConversationStore['save']>[0][number][] = [];
  const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[1] = store; args[3] = () => undefined; args[5] = [...new Set([...toolNames, 'remember', 'forget_memory'])].filter((name) => name !== 'get_context').map(fake) as never; args[7] = false; args[10] = gateway;
  await createOwnerResponder(...args).prompt('heartbeat:1', 'telegram-1', 'Check-back due now.', async (_hop, work) => work(), 'telegram', toolNames);
  return (requests.find((request) => !request.response_format)!.tools ?? []).map((tool) => tool.name);
};

describe('which runs Waldo starts hold remember', () => {
  it('a check-back holds remember, never forget_memory; a job over outside text holds neither', async () => {
    const checkBack = await offeredTo(LOOP_CHECK_BACK_TOOLS);
    expect(checkBack).toContain('remember');
    expect(checkBack).not.toContain('forget_memory');
    const outside = await offeredTo(OUTSIDE_TEXT_JOB_TOOLS);
    for (const name of ['remember', 'forget_memory']) expect(outside).not.toContain(name);
  });
});

describe('a run that read outside content', () => {
  it('reaches remember marked as having read it, so the note is kept as outside content or not at all', async () => {
    const seen: Record<string, unknown>[] = [];
    const fake = (name: string, source_taint: 'external' | null) => ({ name: name as ToolName, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(name),
      handle: async (_args: unknown, ctx: Record<string, unknown>) => { if (name === 'remember') seen.push({ ...ctx }); return { ok: true as const, data: { done: name }, source_taint }; } });
    const script = [{ name: 'search_communication', args: { query: 'Northwind' } }, { name: 'remember', args: NOTE }];
    let round = 0;
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      const step = request.response_format ? undefined : script[round++];
      const tool_calls = step ? [{ call_id: `c${round}`, name: step.name, arguments: JSON.stringify(step.args) }] : undefined;
      return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : tool_calls ? '' : 'SKIP', ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    } };
    const saved: Parameters<ConversationStore['save']>[0][number][] = [];
    const store: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[1] = store; args[3] = () => undefined; args[5] = [fake('search_communication', 'external'), fake('remember', null)] as never; args[7] = false; args[10] = gateway;
    await createOwnerResponder(...args).prompt('heartbeat:2', 'telegram-1', 'Check-back due now.', async (_hop, work) => work(), 'telegram', ['search_communication', 'remember']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolArgSourceTaint: 'external', memoryRun: { runId: expect.any(String) } });
    expect(seen[0]!.memoryTurn).toBeUndefined();
  });
});

// The Brief and every day card run tainted, since each reads calendar or mail text someone else wrote (owner-do ledgerJob),
// and so does the heartbeat's check-back. While notes learned from outside content are off (MEMORY_OUTSIDE_NOTES, off in
// staging), what such a run tries to keep is refused, not stored as Waldo's own note; it is kept, labelled as outside
// content, only where those notes are on.
describe('a Brief over the owner\'s calendar', () => {
  const brief = async (name: string, outsideNotes: boolean, clean = false, readsMail = false) => withSql(name, async (sql) => {
    const store = outsideNotes ? withOutsideNotes(claimStore(sql)) : claimStore(sql);
    const fake = (tool: string) => ({ name: tool as ToolName, description: `The ${tool} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowed(tool),
      handle: async () => ({ ok: true as const, data: { done: tool }, source_taint: tool === 'search_communication' ? 'external' as const : null }) });
    // A Brief of the owner's own text (clean) reads a mail first when asked to, then tries to keep what it read.
    const script = readsMail ? [{ name: 'search_communication', args: { query: 'Northwind' } }, { name: 'remember', args: NOTE }] : [{ name: 'remember', args: NOTE }];
    // Bound to the surface's chat, as owner-do binds the memory tools, which is the chain a Telegram job runs on.
    const tools = [rememberIn(sql, store, 'telegram-1'), ...DAY_CARD_TOOLS.filter((tool) => tool !== 'remember' && tool !== 'get_context').map(fake)];
    const requests: LLMRequest[] = [];
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      requests.push(request);
      const step = request.response_format ? undefined : script[requests.filter((seen) => !seen.response_format).length - 1];
      const call = step ? { call_id: `c-${step.name}`, name: step.name, arguments: JSON.stringify(step.args) } : undefined;
      return { ok: true, data: { model: request.model, text: request.response_format ? '{}' : call ? '' : 'SKIP', ...(call ? { tool_calls: [call] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    } };
    const saved: Parameters<ConversationStore['save']>[0][number][] = [];
    const conversation: ConversationStore = { load: async () => ({ entries: [...saved], leafId: saved.at(-1)?.id ?? null }), save: async (rows) => { saved.push(...rows); } };
    const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: '10000000-0000-0000-0000-000000000001', bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
      expectedPhysicalDoId: 'actual-do', job: 'brief', occurrenceKey: `brief:${crypto.randomUUID()}`, occurredAt: Date.now() - 1 });
    const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture', toolLoader: 'harness' }];
    args[1] = conversation; args[3] = () => undefined; args[5] = tools as never; args[7] = false; args[10] = gateway;
    args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain }, leanScheduled: true, promptOwnText: () => clean };
    await createOwnerResponder(...args).prompt('card:brief:1', 'telegram-1', 'Write the Daily Brief for today.\n\nCalendar: Northwind pitch, Friday 10:00',
      async (_hop, work) => work(), 'telegram', DAY_CARD_TOOLS, undefined, undefined, undefined, 'external', 'plans', undefined, undefined, true);
    const asked = requests.filter((request) => !request.response_format);
    return { offered: (asked[0]!.tools ?? []).map((tool) => tool.name), answer: JSON.stringify(asked.at(-1)), claims: store.allClaims() };
  });

  it('is offered remember, but keeps nothing while notes learned from outside content are off', async () => {
    const { offered, answer, claims } = await brief('brief-outside-off', false);
    expect(offered).toContain('remember');
    expect(answer).toContain('keeps no note from it');
    expect(claims).toEqual([]);
  });

  it('keeps the note as learned from outside content where those notes are on', async () => {
    const { claims } = await brief('brief-outside-on', true);
    expect(claims.map((claim) => claim.origin)).toEqual(['untrusted']);
  });

  it('of the owner\'s own text keeps Waldo\'s own note, though it runs tainted for its actions', async () => {
    const { claims } = await brief('brief-own-text', false, true);
    expect(claims.map((claim) => claim.origin)).toEqual(['agent']);
  });

  it('of the owner\'s own text is outside once it reads a mail: it keeps no note while those notes are off', async () => {
    const { answer, claims } = await brief('brief-own-text-reads-mail', false, true, true);
    expect(answer).toContain('keeps no note from it');
    expect(claims).toEqual([]);
  });
});
