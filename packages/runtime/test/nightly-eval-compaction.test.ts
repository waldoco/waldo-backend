import { describe, expect, it } from 'vitest';
import { compactionSummaryOpen, type AdapterResult, type LLMResponse } from '@waldo/contracts';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { nightlyConfig } from '../evals/nightly/config';
import { conversationStorage, evalConversation } from '../evals/nightly/conversation-world';
import { BROCHURE, FORGOTTEN_TOPIC, INSTRUCTION_CODE, LONG_CONVERSATION_SCENARIO, LONG_HISTORY, PROMISED_QUOTE } from '../evals/nightly/long-conversation';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';
import { CHAT_REF } from '../evals/nightly/world';
import { durableConversationStore } from '../src/channels/conversation-store';
import { COMPACTION, COMPACTION_INSTRUCTION, compactionSettings } from '../src/conversation/compaction';
import { estimateMessageTokens } from '../src/conversation/window';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { numericHealthIn } from '../src/scribe/sanitiser';

const ON = compactionSettings({ WALDO_COMPACTION: 'on' });
const NO_CLAIM_OPS = '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}';
const SUMMARY = `Owner instructions:\n- End every planning summary with ${INSTRUCTION_CODE}.\nOpen items:\n- Bring up the caterer's revised quote ${PROMISED_QUOTE} when the owner asks what is open.`;
const tokens = (text: string) => estimateMessageTokens({ role: 'user', content: text });

// A model that does what the scenario asks of a good one, and can only use what it is shown: it forgets the topic it is
// asked to, writes a fixed summary when asked to compact, and ends its planning summary with the code only when the
// code is in its input.
const model = () => {
  const requests: LLMGatewayRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input): Promise<AdapterResult<LLMResponse>> => {
    requests.push(input);
    const { request } = input;
    const reply = (text: string, toolCalls?: LLMResponse['tool_calls']): AdapterResult<LLMResponse> =>
      ({ ok: true, data: { model: request.model, text, ...(toolCalls ? { tool_calls: toolCalls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } });
    if (request.response_format?.name === 'claim_ops') return reply(NO_CLAIM_OPS);
    if (request.system === COMPACTION_INSTRUCTION) return reply(SUMMARY);
    const said = request.messages.at(-1)?.content ?? '';
    if (said.includes('Please forget everything') && !request.tool_turns?.length) {
      return reply('', [{ call_id: 'forget-1', name: 'forget_memory', arguments: JSON.stringify({ topic: FORGOTTEN_TOPIC, scope_note: 'the party' }) }]);
    }
    if (said.includes('sum up where')) return reply(`The offsite is on track: venue held, seating and signage drafted.${JSON.stringify(request.messages).includes(INSTRUCTION_CODE) ? ` ${INSTRUCTION_CODE}` : ''}`);
    if (said.includes('approve the deposit')) return reply('No. The deposit email is drafted and on hold; nothing was sent.');
    return reply('Noted.');
  } };
  const turnOf = (words: string) => requests.find((request) => request.request.system !== COMPACTION_INSTRUCTION && (request.request.messages.at(-1)?.content ?? '').includes(words))!;
  return { gateway, requests, turnOf, compactions: () => requests.filter((request) => request.request.system === COMPACTION_INSTRUCTION) };
};
const trial = async (compaction: boolean) => {
  const fake = model();
  const scenario = compaction ? { ...LONG_CONVERSATION_SCENARIO, world: { ...LONG_CONVERSATION_SCENARIO.world, compaction: ON } } : LONG_CONVERSATION_SCENARIO;
  const record = await runTrial(scenario, { gateway: fake.gateway, budget: callBudget(200) });
  expect(record.status).toBe('ran');
  return { fake, record, failed: failedReceipts([...STATE_INVARIANTS, ...LONG_CONVERSATION_SCENARIO.receipts!], record) };
};
const TOKEN_RECEIPT = `the first instruction is honoured: the planning summary ends with ${INSTRUCTION_CODE}`;

describe('the long conversation compaction is measured on', () => {
  it('is in the catalogue, stays under the trigger until the brochure, then goes past the window with more than ten owner rows', () => {
    expect(NIGHTLY_SCENARIOS).toContain(LONG_CONVERSATION_SCENARIO);
    const history = LONG_HISTORY.reduce((sum, round) => sum + tokens(round.owner) + tokens(round.waldo), 0);
    const [forget, brochure] = LONG_CONVERSATION_SCENARIO.steps.slice(0, 2).map((step) => tokens((step as { say: string }).say));
    expect(history + forget!).toBeLessThan(COMPACTION.triggerFraction * COMPACTION.budgetTokens);
    // With room for the replies a live model writes, the brochure turn is past the budget by several earlier rounds.
    expect(history + forget! + brochure!).toBeGreaterThan(COMPACTION.budgetTokens + 5_000);
    expect(LONG_HISTORY.length).toBeGreaterThanOrEqual(COMPACTION.minOwnerRows);
    // Synthetic text with no reading, so nothing the summary could carry trips the numeric floor.
    for (const text of [...LONG_HISTORY.flatMap((round) => [round.owner, round.waldo]), BROCHURE]) expect(numericHealthIn(text)).toBe(false);
  });

  it('with compaction off, the turn after the first no longer shows the first instruction, and only the receipt that needs it fails', async () => {
    const { fake, record, failed } = await trial(false);
    expect(fake.compactions()).toHaveLength(0);
    expect(record.final_state).not.toHaveProperty('compaction');
    expect(JSON.stringify(fake.turnOf('sum up where').request.messages)).not.toContain(INSTRUCTION_CODE);
    expect(failed).toEqual([TOKEN_RECEIPT]);
   }, 60_000);

  it('with compaction on, the first turn writes one summary from a span that carries the instruction and the promise but not the forgotten topic, and the next turn reads it first', async () => {
    const { fake, record, failed } = await trial(true);
    expect(fake.compactions()).toHaveLength(1);
    const span = JSON.stringify(fake.compactions()[0]!.request.messages);
    expect(span).toContain(INSTRUCTION_CODE);
    expect(span).toContain(PROMISED_QUOTE);
    expect(span).not.toContain('Lotus Hall');
    expect((record.final_state as { compaction: unknown }).compaction).toEqual([{ text: SUMMARY, live: true }]);
    const next = fake.turnOf('sum up where').request.messages;
    expect(next[0]!.content.startsWith(compactionSummaryOpen(0).split(' 0 ')[0]!)).toBe(true);
    expect(next[0]!.content).toContain(SUMMARY);
    expect(failed).toEqual([]);
   }, 60_000);

  it('names the compaction run on its scorecard and passes its settings to every trial', () => {
    const on = nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_COMPACTION: 'on' });
    expect(on.candidate).toBe('recorded+compaction');
    expect(on.compaction).toEqual(ON);
    const off = nightlyConfig({ WALDO_EVAL_MODE: 'recorded' });
    expect(off.candidate).toBe('recorded');
    expect(off).not.toHaveProperty('compaction');
  });

  it('an ablated compaction run keeps compaction on, and its card names the compaction baseline it is compared with', () => {
    const ablated = nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_COMPACTION: 'on', WALDO_EVAL_ABLATE: '0badc0de' });
    expect(ablated.compaction).toEqual(ON);
    expect(ablated.candidate).toBe('recorded+compaction+ablate:0badc0de');
    expect(ablated.candidate.split('+ablate:')[0]).toBe(nightlyConfig({ WALDO_EVAL_MODE: 'recorded', WALDO_EVAL_COMPACTION: 'on' }).candidate);
  });

  it('a turn read of the long chat with compaction on and no summary yet stops at the window, as with it off', async () => {
    // Six times the seeded history, so the chain is well past one page of rows.
    const history = Array.from({ length: 6 }, () => LONG_HISTORY).flat();
    const storage = conversationStorage();
    const chat = evalConversation({ history, compaction: ON }, CHAT_REF, LONG_CONVERSATION_SCENARIO.start, () => durableConversationStore(storage as never), storage);
    await chat.seed(chat.store);
    let read = 0;
    const listing = storage.list.bind(storage);
    storage.list = async (options) => { const page = await listing(options); read += page.size; return page; };
    const { entries } = await chat.store.load();
    expect(entries.length).toBeLessThan(history.length * 2);
    expect(read).toBeLessThanOrEqual(128);
   }, 60_000);
});
