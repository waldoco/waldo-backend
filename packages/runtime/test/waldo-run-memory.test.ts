import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type LLMRequest, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { ConversationStore } from '../src/channels/conversation-store';
import { LOOP_CHECK_BACK_TOOLS, OUTSIDE_TEXT_JOB_TOOLS } from '../src/channels/check-back';
import { claimStore, memoryPrompt, withOutsideNotes, WALDO_RUN_REF, type ClaimStore } from '../src/memory/claims';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';
import type { LLMGatewayAdapter } from '../src/llm/provider';

// A run Waldo started (a Brief, a check-back) keeps what it learned instead of losing it until the nightly pass: as Waldo's
// own note, sourced to the run, never as the owner's words. It replaces nothing, names no one and keeps no health detail.
const OWNER = 'prn_10000000000000000000000000000001';
const NOTE = { kind: 'fact', text: 'The Northwind pitch moved to Friday.', evidence_quote: 'Calendar: Northwind pitch, Friday 10:00' };

const withSql = <T,>(name: string, work: (sql: SqlStorage) => Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)), async (_instance, state) => work(state.storage.sql));
const rememberIn = (sql: SqlStorage, store: ClaimStore) => memoryHandlers({ sql, store, conversationRef: 'owner', hideHistory: async () => undefined }).find((tool) => tool.name === 'remember')!;
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
