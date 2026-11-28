import { describe, expect, it } from 'vitest';
import { buildSessionState, getContextArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolCall, type ToolHandler } from '@waldo/contracts';
import { runToolLoop } from '../src/conversation/tool-loop';
import { NOTHING_TO_SEND, sendsNothing, type RunEnd } from '../src/conversation/run-end';
import { endRunHandler } from '../src/tools/live/end-run';
import { CHILD_READ_TOOLS } from '../src/conversation/subagent';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
import { reminderCheckBackText, loopCheckBackText } from '../src/channels/check-back';
import { dayCardPrompt, DAY_CARDS } from '../src/prompt/day-cards';
import { updateCardPrompt, mailFollowupPrompt } from '../src/prompt/update-cards';
import { resultApplyText } from '../src/tasks/lane';
import { retryTurnText } from '../src/tasks/retry-turn';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { ownerTyped } from './helpers/owner-typed';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = (): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null, hasApproval: () => true, sanitise: adapters.safety.sanitise,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }),
});
let reads = 0;
const read: ToolHandler<never, never, ToolDispatcherContext> = {
  name: 'get_context', description: 'Read context.', schema: getContextArgsSchema as never,
  trigger_allowlist: triggerTypeSchema.options.filter((t) => TOOL_PERMISSIONS[t].includes('get_context')), autonomy_gated: false,
  handle: async () => { reads += 1; return { ok: true, data: { now: 'synthetic' }, source_taint: null }; },
} as never;

// One script of model rounds; a round past the script answers with closing words.
const run = async (rounds: readonly (readonly Omit<LLMToolCall, 'call_id'>[] | string)[], maxSteps = 10) => {
  const ends: RunEnd[] = [];
  let round = 0;
  reads = 0;
  const reply = await runToolLoop({
    handlers: [read, endRunHandler] as never, ctx: ctx(), maxSteps, onRunEnd: (end) => ends.push(end),
    step: async (tools) => {
      const next = rounds[round++];
      if (typeof next === 'string' || next === undefined || !tools) return { text: typeof next === 'string' ? next : 'closing words' };
      return { text: '', tool_calls: next.map((call, index) => ({ ...call, call_id: `r${round}-${index}` })) };
    },
  });
  return { reply, ends, rounds: round };
};
const end = (args: object) => ({ name: 'end_run', arguments: JSON.stringify(args) });

describe('a run the model ends with end_run', () => {
  it('sends nothing, records the reason, and makes no further model call', async () => {
    const result = await run([[{ name: 'get_context', arguments: '{}' }], [end({ outcome: 'nothing_to_send', reason: 'meeting already moved' })]]);
    expect(sendsNothing(result.reply)).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.ends).toEqual([{ reason: 'nothing_to_send', why: 'meeting already moved' }]);
  });

  it('sends the chosen words for send and ask_owner, and records which', async () => {
    const sent = await run([[end({ outcome: 'send', reason: 'moved', message: 'Your 3pm moved to 4.' })]]);
    expect(sent.reply).toBe('Your 3pm moved to 4.');
    expect(sent.ends).toEqual([{ reason: 'send', why: 'moved' }]);
    const asked = await run([[end({ outcome: 'ask_owner', reason: 'two slots fit', message: 'Gym at 6 or 7?' })]]);
    expect(asked.reply).toBe('Gym at 6 or 7?');
    expect(asked.ends).toEqual([{ reason: 'ask_owner', why: 'two slots fit' }]);
  });

  it('records a follow-up as an end that sends nothing now', async () => {
    const result = await run([[end({ outcome: 'follow_up', reason: 'reply not in; reminder at 5pm' })]]);
    expect(sendsNothing(result.reply)).toBe(true);
    expect(result.ends).toEqual([{ reason: 'follow_up', why: 'reply not in; reminder at 5pm' }]);
  });

  it('does not end on a malformed end: the model hears the schema error and the run goes on', async () => {
    const result = await run([[end({ outcome: 'send', reason: 'no words' })], 'Your 3pm moved to 4.']);
    expect(result.reply).toBe('Your 3pm moved to 4.');
    expect(result.rounds).toBe(2);
    expect(result.ends).toEqual([{ reason: 'replied' }]);
  });

  it('never needs the exact word: plain words are a send, and the old word is still read as nothing to send', async () => {
    expect((await run(['Heads up: the 3pm moved.'])).ends).toEqual([{ reason: 'replied' }]);
    const typed = await run([NOTHING_TO_SEND]);
    expect(sendsNothing(typed.reply)).toBe(true);
    expect(typed.ends).toEqual([{ reason: 'nothing_to_send', why: 'typed' }]);
  });
});

describe('every run end is recorded', () => {
  it('a run with no words records no_reply', async () => {
    expect((await run([''])).ends).toEqual([{ reason: 'no_reply' }]);
  });

  it('a run out of rounds records it, once', async () => {
    const result = await run([[{ name: 'get_context', arguments: '{}' }], [{ name: 'get_context', arguments: '{"topic":"x"}' }], ''], 1);
    expect(result.ends).toEqual([{ reason: 'budget_exhausted' }]);
  });
});

const taskRow = {
  id: 'job-1', profile: 'research', taint: null, park_reason: null, rounds: 3,
  brief_json: JSON.stringify({ title: 'find flights', started_at: Date.UTC(2026, 10, 23, 9) }),
  result_json: JSON.stringify({ status: 'done', summary: 'found two', findings: [], proposals: [], left: [] }),
} as never;

describe('prompts for runs Waldo starts', () => {
  it('ask for end_run and never for an exact word', () => {
    const now = Date.parse('2026-11-23T09:00:00Z');
    const cardContext = { calendar: '', ledger: '', today: '', updates: '' };
    const texts = [
      reminderCheckBackText('call the bank'),
      loopCheckBackText([{ id: 'l1', title: 'reply to Sam', due: null } as never], now, 'UTC'),
      ...[false, true].map((dayShape) => dayCardPrompt(DAY_CARDS.find((card) => card.id === 'card:midday')!, '2026-11-23T14:00', cardContext, false, dayShape)),
      updateCardPrompt('2026-11-23T09:00', { changes: '- synthetic', ledger: '', feedback: '', volume: 'normal' }),
      mailFollowupPrompt('2026-11-23T09:00', { id: 'l1', title: 'reply to Sam', due: '2026-11-23T10:00', source_ref: 'm1' } as never, ''),
      retryTurnText({ message_ref: 'm', text: 'hi', conversation_ref: 'c', said_at: now, promised_by: now } as never, 'UTC'),
      resultApplyText(taskRow),
      resultApplyText(taskRow, 'Waldo: the summary is ready.'),
    ].filter((text): text is string => typeof text === 'string');
    expect(texts.length).toBeGreaterThan(5);
    for (const card of DAY_CARDS) expect(dayCardPrompt(card, '2026-11-23T09:00', cardContext)).not.toMatch(/exactly SKIP/);
    for (const text of texts) {
      expect(text).not.toMatch(/exactly SKIP/);
      expect(text).toContain('end_run');
    }
  });
});

describe('end_run is not a child tool', () => {
  it('stays out of a subagent\'s reads', () => {
    expect(CHILD_READ_TOOLS).not.toContain('end_run');
  });
});

describe('through the owner responder', () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
  const setup = () => {
    const offered: string[][] = [];
    const logs: TurnLogEntry[] = [];
    const gateway: LLMGatewayAdapter = { complete: async (input) => {
      const base = { ...usage, model: input.request.model };
      const names = (input.request.tools ?? []).map((tool) => tool.name);
      offered.push(names);
      const ended = input.request.tool_turns?.some((turn) => turn.call.name === 'end_run');
      if (names.includes('end_run') && !ended) return { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: 'e1', name: 'end_run', arguments: JSON.stringify({ outcome: 'nothing_to_send', reason: 'already handled' }) }] } };
      return { ok: true, data: { ...base, text: 'Morning.' } };
    } };
    const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai' }];
    args[3] = (entry) => logs.push(entry);
    args[5] = [read, endRunHandler] as never; args[10] = gateway;
    return { responder: createOwnerResponder(...args), offered, logs };
  };
  const time = async <T,>(_hop: string, work: () => Promise<T>) => work();

  it('a run Waldo started may end with nothing to send, and its closed reason is logged', async () => {
    const { responder, offered, logs } = setup();
    const reply = await responder.prompt('job-1', 'telegram-1', '[Reminder due now, set earlier by the owner: "check the bank"]', time, 'telegram', ['get_context']);
    expect(sendsNothing(reply)).toBe(true);
    expect(offered).toHaveLength(1);
    expect(logs.filter((entry) => entry.hop === 'run_end')).toEqual([expect.objectContaining({ code: 'nothing_to_send', detail: 'already handled', ok: true })]);
  });

  it('the owner\'s own chat turn is never offered end_run, and its reply is logged as replied', async () => {
    const { responder, offered, logs } = setup();
    const reply = await responder.respond(ownerTyped({ traceId: 'owner-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'morning', memoryWrites: false }), time);
    expect(reply).toBe('Morning.');
    expect(offered.flat()).not.toContain('end_run');
    expect(logs.filter((entry) => entry.hop === 'run_end')).toEqual([expect.objectContaining({ code: 'replied' })]);
  });
});
