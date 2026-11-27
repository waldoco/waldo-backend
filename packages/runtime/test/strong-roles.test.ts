import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, type ModelName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { OwnerJobModel } from '../src/channels/owner-turn-envelope';
import { durableConversationStore } from '../src/channels/conversation-store';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';

// WALDO_STRONG_ROLES. Before: the nightly memory writer, the day plan and every background job a caller did not mark run on
// the auxiliary model (Haiku on Claude), and no run asks for more effort than its model's own. After: a run that writes
// memory or decides something runs on the chat model (Sonnet), and a planning run asks the chat model for PLANNING_EFFORT.
// With the switch off nothing moves.
const NO_OPS = '{"add":[],"corrections":[],"retire":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}';
type Seen = Readonly<{ kind: string; model: ModelName; effort?: string }>;

const roles = (strongRoles: boolean) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`strong-roles-${strongRoles}`)), async (_instance, state) => {
  const seen: Seen[] = [];
  const gateway: LLMGatewayAdapter = { async complete({ request }) {
    seen.push({ kind: request.response_format?.name ?? 'reply', model: request.model, ...(request.reasoning_effort ? { effort: request.reasoning_effort } : {}) });
    const text = request.response_format?.name === 'claim_ops' ? NO_OPS : request.response_format?.name === 'day_plan' ? '{"cards":[]}' : request.response_format ? '{}' : 'Nothing to add.';
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const memory = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
  const access = { openaiApiKey: '', anthropicApiKey: 'sk-ant-api03-synthetic-fixture-0000000000000000000000', primary: 'anthropic' as const, ...(strongRoles ? { strongRoles } : {}) };
  const responder = createOwnerResponder(access, durableConversationStore(state.storage), memory, undefined, undefined, [], undefined, false, undefined, undefined, gateway);
  const timer = async <T,>(_hop: string, work: () => Promise<T>) => work();
  const job = async (kind: string, ownerModel: OwnerJobModel | undefined, decision?: Readonly<{ name: string; schema: Record<string, unknown> }>) => {
    const before = seen.length;
    await responder.prompt(`job-${kind}`, 'owner', `A ${kind} job.`, timer, undefined, [], async () => {}, decision, undefined, undefined, ownerModel).catch(() => '');
    return seen.slice(before).map((call) => ({ ...call, kind }));
  };
  await responder.consolidate('nightly-1', 'owner: I moved to Lisbon.');
  await responder.planDay('day-1', 'Calendar: standup at 10.').catch(() => '');
  await responder.importDoc!('import-1', 'A summary of the owner.').catch(() => '');
  const prep = await job('meeting_prep', 'decides', { name: 'calendar_prep', schema: { type: 'object' } });
  const plan = await job('day_card', 'plans');
  const unmarked = await job('unmarked', undefined);
  const late = await job('late_answer', true);
  return [...seen.filter((call) => call.kind === 'claim_ops' || call.kind === 'day_plan' || call.kind === 'doc_import'), ...prep, ...plan, ...unmarked, ...late];
});

it('with the switch off, memory, the day plan and deciding jobs stay on the auxiliary model at its own effort', async () => {
  expect(await roles(false)).toEqual([
    { kind: 'claim_ops', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, effort: 'low' },
    { kind: 'day_plan', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, effort: 'low' },
    { kind: 'doc_import', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, effort: 'low' },
    { kind: 'meeting_prep', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, effort: 'low' },
    { kind: 'day_card', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'medium' },
    { kind: 'unmarked', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, effort: 'low' },
    { kind: 'late_answer', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'medium' },
  ]);
});

it('with the switch on, memory and deciding jobs move to the chat model, and planning runs ask it for high effort', async () => {
  expect(await roles(true)).toEqual([
    { kind: 'claim_ops', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'medium' },
    { kind: 'day_plan', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'high' },
    { kind: 'doc_import', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'medium' },
    { kind: 'meeting_prep', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'medium' },
    { kind: 'day_card', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'high' },
    { kind: 'unmarked', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, effort: 'low' },
    { kind: 'late_answer', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, effort: 'medium' },
  ]);
});
