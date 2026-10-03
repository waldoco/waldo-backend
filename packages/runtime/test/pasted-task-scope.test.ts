import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { PASTED_TASK_SCOPE_CASE as fixture } from '../evals/pasted-task-scope-case';
import { scoreTrace, type RecordedTrace } from '../evals/trace-replay';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { durableConversationStore } from '../src/channels/conversation-store';
import { claimStore } from '../src/memory/claims';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';

// The provider deliberately drifts. This tests host custody/dispatch, not real-model intent.
const run = (name: string, drift: boolean, incomplete: boolean) => runInDurableObject(
  env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const searches = vi.fn(async () => []);
    const reads = vi.fn(async () => []);
    const google = { client: async () => ({ searchMail: searches, readThread: reads }) } as unknown as GoogleAccess;
    const handlers = googleHandlers(google, { propose: async () => 'unused', proposeSendEmail: async () => 'unused', record: () => {} }, { timezone: 'UTC', now: () => new Date() })
      .filter(h => h.name === 'search_communication' || h.name === 'read_thread');
    const memory = claimStore(state.storage.sql);
    let turn = 0;
    let step = 0;
    const inputs: string[] = [];
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      inputs.push(JSON.stringify({ system: request.system, messages: request.messages }));
      const call = drift && turn === 3 && step++ < 7
        ? [{ call_id: `synthetic-${step}`, name: step <= 5 ? 'search_communication' : 'read_thread', arguments: JSON.stringify(step <= 5 ? { query: `Alex synthetic-topic-${step}`, limit: 5 } : { thread_id: `fictional-unrelated-thread-${step}`, limit: 5 }) }]
        : undefined;
      return { ok: true, data: { text: call ? '' : turn === 1 ? fixture.visible.conversation[1].content : fixture.visible.conversation[3].content,
        ...(call ? { tool_calls: call } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, model: request.model, latency_ms: 1 } };
    } };
    const make = () => {
      const args: Parameters<typeof createOwnerResponder> = ['fixture', durableConversationStore(state.storage), memory];
      args[5] = handlers; args[10] = gateway;
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
    return { finalInput: inputs[2]!, searches: searches.mock.calls.length, reads: reads.mock.calls.length };
  });

it('retains the initiating source restriction and Thursday correction across ordinary responder recreation', async () => {
  const result = await run('pasted-scope-normal', false, false);
  expect(result.finalInput).toContain('Use ONLY the pasted fictional threads');
  expect(result.finalInput).toContain('Correction: the agenda arrives Thursday');
  expect(result.searches + result.reads).toBe(0);
});

it('RED: durable pasted-task read scope prevents a drifting provider from reaching connected mail', async () => {
  const result = await run('pasted-scope-drift', true, false);
  expect(result.finalInput).toContain('Use ONLY the pasted fictional threads');
  expect({ searches: result.searches, reads: result.reads }).toEqual({ searches: 0, reads: 0 });
});

it('RED: an unrelated recall hold loses earlier task restriction custody', async () => {
  const result = await run('pasted-scope-recall-hold', false, true);
  expect(result.finalInput).toContain('Use ONLY the pasted fictional threads');
});

it('grades source reads even when no send or write occurred; semantic answer correctness remains unscored', () => {
  const trace: RecordedTrace = { case_id: fixture.id, model: 'scripted-no-model', effects: [], reads: [], approvals: [], claimed_effects: [], receipt_effects: [], terminal: 'completed', usage: { input_tokens: 0, output_tokens: 0, calls: 0 } };
  expect(scoreTrace(trace, fixture.grader.expectation).structural_ok).toBe(true);
  for (const family of ['mail', 'calendar', 'contacts']) {
    expect(scoreTrace({ ...trace, reads: [{ owner: 'fictional-owner', family, id: 'fictional-unrelated-source' }] }, fixture.grader.expectation).failed).toContain('source_evidence');
  }
});
