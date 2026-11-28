import { expect, it, vi } from 'vitest';
import { derivedHealthDestinationViewSchema } from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { ownerTyped } from './helpers/owner-typed';

// A health view the Scribe refuses for its size is one block left out, never a turn lost: the model is told in words that the
// owner's body view is not in this turn, the owner still gets a reply, the reason is logged by a fixed code, and nothing of the
// refused view reaches the prompt. Every view the schema admits fits the caps, so the refusal is forced here at the Scribe.
const scribe = vi.hoisted(() => ({ refuse: false }));
vi.mock('../src/scribe/prepare', async (load) => {
  const actual = await load<typeof import('../src/scribe/prepare')>();
  return {
    ...actual,
    prepareWithScribe: ((value, schema, destination, taint, canaries) =>
      scribe.refuse && schema === derivedHealthDestinationViewSchema && destination === 'system_prompt'
        ? { ok: false, reason: 'oversize' }
        : actual.prepareWithScribe(value, schema, destination, taint, canaries)) as typeof actual.prepareWithScribe,
  };
});
const { healthContextBook } = await import('../src/channels/health-context');
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { createOwnerTurnContext } = await import('../src/context-composer/owner-turn');
const { ownerMessageAdmission } = await import('../src/identity/owner-message-admission');

const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const material = async () => {
  const call = async (fn: string) => {
    if (fn === 'health_context_read') return { context: {
      id: 'ctx-withheld', day: new Date(NOW).toISOString().slice(0, 10), compiled_at: ago(1), freshness: 'fresh', confidence: 0.8, drivers: [], tags: [],
      recovery: { score: 71, zone: 'good', algorithm_version: 'recovery.candidate.v4' }, form: { score: 66, zone: 'good', algorithm_version: 'form.v10' },
      weight: { score: 40, zone: 'moderate', algorithm_version: 'weight.v5' }, basis: [{ source: 'apple', consent_epoch: 1 }],
    }, previous: null };
    throw new Error(`unexpected rpc ${fn}`);
  };
  const read = await healthContextBook(call, 'owner-withheld', { timezone: 'UTC', now: () => new Date(NOW) }).latest();
  if (read === null || read === 'unreadable') throw new Error('no health material');
  return read;
};
const OWNER = '10000000-0000-0000-0000-000000000001';
const CANARIES = ['0123456789abcdef', '1123456789abcdef', '2123456789abcdef'];
const scope = (): RunEffectScope => ({ runId: 'run-withheld', attempt: 'attempt-withheld', deadline: NOW + 15 * 60_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const context = async (text: string) => createOwnerTurnContext(await ownerMessageAdmission({
  lookup: async () => ({ owner_id: OWNER, do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
  scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
  actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
  allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text,
  occurrenceKey: `withheld:${crypto.randomUUID()}`, occurredAt: Date.now() - 1, now: Date.now,
}), { health: material });
const WITHHELD = /body view (?:is )?not in this turn/i;

it('composes without the refused view, and says in words that the body view is not in this turn', async () => {
  scribe.refuse = true;
  const turn = await context('How am I doing today?');
  const composed = await turn.composer.compose(turn.invocation, { ...turn.snapshot(), canary_tokens: CANARIES, replay_context_ref: null });
  scribe.refuse = false;
  expect(composed.ok, JSON.stringify(composed)).toBe(true);
  if (!composed.ok) return;
  expect(composed.health_withheld).toBe('oversize');
  expect(composed.prompt).toMatch(WITHHELD);
  expect(composed.healthPrompt).toMatch(WITHHELD);
  // Nothing of the view: no zone, no confidence, no freshness line, and no claim that the owner shares nothing.
  for (const text of [composed.prompt, composed.healthPrompt ?? '']) {
    expect(text).not.toMatch(/Form zone:|Recovery zone:|Confidence: |Freshness: /);
    expect(text).not.toContain('No derived health context is available');
  }
});

it('a view the Scribe admits composes as before, with no withheld mark', async () => {
  const turn = await context('How am I doing today?');
  const composed = await turn.composer.compose(turn.invocation, { ...turn.snapshot(), canary_tokens: CANARIES, replay_context_ref: null });
  expect(composed.ok && composed.health_withheld).toBe(undefined);
  expect(composed.ok && composed.prompt).toMatch(/Form zone: /);
});

it('the owner still gets a reply, and the turn logs why the view was left out by a fixed code', async () => {
  const requests: LLMGatewayRequest['request'][] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const text = request.response_format ? '{}' : 'Here is the plan for this afternoon.';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const logs: TurnLogEntry[] = [];
  const text = 'Can I fit a run in this afternoon?';
  const turn = await context(text);
  const runScope = scope();
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[3] = entry => logs.push(entry); args[5] = []; args[10] = gateway; args[18] = []; args[19] = runScope;
  args[21] = { context: turn };
  scribe.refuse = true;
  const reply = await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'withheld-1', conversationRef: turn.conversationRef, surface: 'app', text }), (_name, work) => work());
  scribe.refuse = false;
  expect(JSON.stringify(reply)).toContain('Here is the plan for this afternoon.');
  const replyRequest = requests.find(request => request.response_format === undefined)!;
  expect(JSON.stringify(replyRequest)).toMatch(WITHHELD);
  expect(JSON.stringify(replyRequest)).not.toMatch(/Form zone:/);
  expect(logs.filter(entry => entry.hop === 'health_context')).toEqual([expect.objectContaining({ ok: false, code: 'withheld_oversize' })]);
  expect(JSON.stringify(logs.filter(entry => entry.hop === 'health_context'))).not.toMatch(/zone|score|steady|solid/i);
});
