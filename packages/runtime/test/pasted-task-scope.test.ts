import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { PASTED_TASK_SCOPE_CASE as fixture } from '../evals/pasted-task-scope-case';
import { scoreTrace, type RecordedTrace } from '../evals/trace-replay';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { durableConversationStore } from '../src/channels/conversation-store';
import { claimStore } from '../src/memory/claims';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { createTaskSourceScope } from '../src/channels/task-source-scope';

// The provider deliberately drifts. This tests host custody/dispatch, not real-model intent.
const run = (name: string, drift: boolean, incomplete: boolean) => runInDurableObject(
  env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const searches = vi.fn(async () => []);
    const reads = vi.fn(async () => []);
    const google = { client: async () => ({ searchMail: searches, readThread: reads }) } as unknown as GoogleAccess;
    const handlers = googleHandlers(google, { propose: async () => 'unused', proposeSendEmail: async () => 'unused', record: () => {} }, { timezone: 'UTC', now: () => new Date() })
      .filter(h => h.name === 'search_communication' || h.name === 'read_thread');
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'preference', text: 'FORBIDDEN_RETAINED_SENTINEL', source: 'stated', evidence: 'fixture', origin: 'owner' }, new Date().toISOString());
    const taskContext = vi.fn(async () => 'FORBIDDEN_WORKSPACE_SENTINEL');
    const standingOrders = vi.fn(() => 'FORBIDDEN_ORDER_SENTINEL');
    let turn = 0;
    let step = 0;
    const inputs: string[] = [];
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      if (request.response_format?.name === 'task_source_scope') return { ok: true, data: { text: JSON.stringify({ decision: turn === 1 ? 'restrict' : 'retain', sources: [] }), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
      inputs.push(JSON.stringify({ system: request.system, messages: request.messages }));
      const call = drift && turn === 3 && step++ < 7
        ? [{ call_id: `synthetic-${step}`, name: step <= 5 ? 'search_communication' : 'read_thread', arguments: JSON.stringify(step <= 5 ? { query: `Alex synthetic-topic-${step}`, limit: 5 } : { thread_id: `fictional-unrelated-thread-${step}`, limit: 5 }) }]
        : undefined;
      return { ok: true, data: { text: call ? '' : turn === 1 ? fixture.visible.conversation[1].content : fixture.visible.conversation[3].content,
        ...(call ? { tool_calls: call } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
    } };
    const make = () => {
      const args: Parameters<typeof createOwnerResponder> = ['fixture', durableConversationStore(state.storage), memory];
      args[5] = handlers; args[10] = gateway; args[13] = standingOrders;
      const scope = { runId: name, attempt: 'fixture-attempt', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit: () => {}, commit: <T>(work: () => T) => work() };
      args[19] = scope;
      args[21] = { sourceScope: createTaskSourceScope(state.storage.sql, name, scope, async () => {}), requireTaskScope: true, skills: { handlers: [], prompt: async () => '', metadata: () => '', taskContext, assertProcedureCurrent: async () => {} } };
      return createOwnerResponder(...args);
    };
    let responder = make();
    for (const index of [0, 2, 4]) {
      turn++; step = 0;
      if (turn === 3) {
        if (incomplete) memory.beginTopicCoverage('unrelated retained preference', new Date().toISOString());
        responder = make(); // re-create the real responder against durable owner storage
      }
      await responder.respond({ traceId: `${name}-${turn}`, conversationRef: 'fictional-owner', surface: 'telegram', text: fixture.visible.conversation[index]!.content, memoryWrites: false }, (_label, work) => work());
    }
    expect(taskContext).not.toHaveBeenCalled();
    expect(standingOrders).not.toHaveBeenCalled();
    expect(inputs.join('\n')).not.toContain('FORBIDDEN_');
    return { finalInput: inputs[2]!, searches: searches.mock.calls.length, reads: reads.mock.calls.length };
  });

it('retains the initiating source restriction and Thursday correction across ordinary responder recreation', async () => {
  const result = await run('pasted-scope-normal', false, false);
  expect(result.finalInput).toContain('Use ONLY the pasted fictional threads');
  expect(result.finalInput).toContain('Correction: the agenda arrives Thursday');
  const system = (JSON.parse(result.finalInput) as { system: string }).system;
  expect(system).toContain('Current owner task source limits outrank');
  expect(system.indexOf('Current owner task source limits outrank')).toBeLessThan(system.indexOf('Gmail topic retrieval'));
  expect(result.searches + result.reads).toBe(0);
});

it('durable pasted-task read scope prevents a drifting provider from reaching connected mail', async () => {
  const result = await run('pasted-scope-drift', true, false);
  expect(result.finalInput).toContain('Use ONLY the pasted fictional threads');
  expect({ searches: result.searches, reads: result.reads }).toEqual({ searches: 0, reads: 0 });
});

it('an unrelated recall hold keeps non-content source restrictions while withholding earlier task data', async () => {
  const result = await run('pasted-scope-recall-hold', false, true);
  expect(result.finalInput).toContain('supplied task data only');
  expect(result.finalInput).not.toContain('Alex Vale');
  expect(result.finalInput).not.toContain('Thread A:');
});

it('grades source reads even when no send or write occurred; semantic answer correctness remains unscored', () => {
  const trace: RecordedTrace = { case_id: fixture.id, model: 'scripted-no-model', effects: [], reads: [], approvals: [], claimed_effects: [], receipt_effects: [], terminal: 'completed', usage: { input_tokens: 0, output_tokens: 0, calls: 0 } };
  expect(scoreTrace(trace, fixture.grader.expectation).structural_ok).toBe(true);
  for (const family of ['mail', 'calendar', 'contacts']) {
    expect(scoreTrace({ ...trace, reads: [{ owner: 'fictional-owner', family, id: 'fictional-unrelated-source' }] }, fixture.grader.expectation).failed).toContain('source_evidence');
  }
});

it('steering during awaited authentication fences the next physical read before classification', () => runInDurableObject(
  env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('scope-steering-auth')), async (_instance, state) => {
    const physical = vi.fn(async () => []);
    let responder: ReturnType<typeof createOwnerResponder>;
    let calls = 0;
    let classifications = 0;
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      const classifier = request.response_format?.name === 'task_source_scope';
      const text = classifier ? JSON.stringify({ decision: classifications++ === 0 ? 'retain' : 'restrict', sources: [] }) : 'Use supplied data.';
      const tool_calls = !classifier && calls++ === 0 ? [{ call_id: 'read', name: 'search_communication', arguments: '{"query":"fictional","limit":1}' }] : undefined;
      return { ok: true, data: { text: tool_calls ? '' : text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
    } };
    const google = { client: async () => {
      await Promise.resolve();
      expect(responder.control.steer(999, 'Use only the supplied data now.')).toBe(true);
      return { searchMail: physical };
    } } as unknown as GoogleAccess;
    const handlers = googleHandlers(google, { propose: async () => 'unused', proposeSendEmail: async () => 'unused', record() {} }, { timezone: 'UTC', now: () => new Date() }).filter(h => h.name === 'search_communication');
    const scope = { runId: 'scope-steering-auth', attempt: 'fixture', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit() {}, commit: <T>(fn: () => T) => fn() };
    const args: Parameters<typeof createOwnerResponder> = ['fixture', durableConversationStore(state.storage)];
    args[5] = handlers; args[10] = gateway; args[19] = scope;
    args[21] = { sourceScope: createTaskSourceScope(state.storage.sql, 'owner', scope, async () => {}), requireTaskScope: true };
    responder = createOwnerResponder(...args);
    await responder.respond({ traceId: 'auth-turn', conversationRef: 'fixture', surface: 'telegram', text: 'Read the fictional inbox', memoryWrites: false }, (_label, fn) => fn());
    expect(physical).not.toHaveBeenCalled();
    expect(classifications).toBe(2);
  }));
