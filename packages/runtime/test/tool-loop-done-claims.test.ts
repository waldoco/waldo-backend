import { describe, expect, it } from 'vitest';
import { buildSessionState, type LLMTool, type LLMToolCall, type LLMToolTurn } from '@waldo/contracts';
import { runToolLoop, type ToolLoopEvent } from '../src/conversation/tool-loop';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { getContextHandler } from '../src/tools/live/get-context';
import type { LoopEventLike } from '../src/hooks/claim-hook';
import { doneClaimDesk, NOTE_DONE } from '../src/hooks/done-claims';
import { FINAL_ANSWER_RESERVE_MS } from '../src/llm/time-budget';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = () => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
});
// get_context stands in for an effect tool: its receipt is mapped here exactly as the owner turn maps an effect event.
const handlers = [getContextHandler({ timezone: 'UTC', now: () => new Date('2026-10-14T08:00:00Z') })];
const noteDone = (effect: string, id = 'n1'): LLMToolCall => ({ call_id: id, name: NOTE_DONE, arguments: JSON.stringify({ effect }) });

const run = async (script: (tools: readonly LLMTool[] | undefined, turns: readonly LLMToolTurn[], round: number) => { text: string; tool_calls?: LLMToolCall[] }, opts: { effect?: boolean; budget?: { remaining: number; deadline?: number } } = {}) => {
  const events: LoopEventLike[] = [];
  const desk = doneClaimDesk(() => events);
  const offered: (string[] | undefined)[] = [];
  let round = 0;
  const text = await runToolLoop({
    handlers, ctx: ctx(), maxSteps: 25, claims: desk, ...(opts.budget ? { budget: opts.budget } : {}),
    onTool: (event: ToolLoopEvent) => { if (opts.effect) events.push({ seq: events.length + 1, call: { name: 'set_reminder', args: {} }, ok: event.ok }); },
    step: async (tools, turns) => { offered.push(tools?.map(tool => tool.name)); return script(tools, turns, round++); },
  });
  return { text, notice: desk.notice(), offered };
};

describe('done-claims in the tool loop', () => {
  it('a reply that claims nothing never sees a revision', async () => {
    const result = await run(() => ({ text: 'Hello.' }));
    expect(result).toEqual({ text: 'Hello.', notice: null, offered: [['get_context', NOTE_DONE]] });
  });

  it('a backed claim declared with the reply passes untouched, with no extra model round', async () => {
    const result = await run((_tools, turns) => turns.length === 0
      ? { text: '', tool_calls: [{ call_id: 'r', name: 'get_context', arguments: '{}' }] }
      : { text: 'Reminder set.', tool_calls: [noteDone('reminder_set')] }, { effect: true });
    expect(result.text).toBe('Reminder set.');
    expect(result.notice).toBeNull();
    expect(result.offered).toHaveLength(2);
  });

  it('a claim with no effect call gets exactly one revision, offering only note_done, with the findings as host facts', async () => {
    const seen: (readonly LLMToolTurn[])[] = [];
    const result = await run((_tools, turns, round) => {
      seen.push(turns);
      return round === 0 ? { text: 'Sent it.', tool_calls: [noteDone('message_send_proposed')] } : { text: 'I have not sent it yet.' };
    });
    expect(result.offered).toEqual([['get_context', NOTE_DONE], [NOTE_DONE]]);
    expect(seen[1]!.at(-1)!.output).toContain('message_send_proposed (no_matching_receipt)');
    expect(result.text).toBe('I have not sent it yet.');
    expect(result.notice, 'the rewrite dropped the claim').toBeNull();
  });

  it('a claim still made after the revision is delivered with the not-confirmed line, and the turn does not loop', async () => {
    const result = await run(() => ({ text: 'Sent it.', tool_calls: [noteDone('message_send_proposed')] }));
    expect(result.offered).toHaveLength(2);
    expect(result.text).toBe('Sent it.');
    expect(result.notice).toBe('Not confirmed: message send proposed (nothing ran)');
  });

  it('a failed receipt is revised, and still claimed it reads as failed', async () => {
    const result = await run((_tools, turns) => turns.length === 0
      ? { text: '', tool_calls: [{ call_id: 'r', name: 'get_context', arguments: '{"bad":1}' }] }
      : { text: 'Set.', tool_calls: [noteDone('reminder_set', `n${turns.length}`)] }, { effect: true });
    expect(result.offered).toHaveLength(3);
    expect(result.notice).toBe('Not confirmed: reminder set (it failed)');
  });

  it('a claim declared in an earlier round returns its finding then, so the plain reply after it is not revised again', async () => {
    const seen: (readonly LLMToolTurn[])[] = [];
    const result = await run((_tools, turns, round) => { seen.push(turns); return round === 0 ? { text: '', tool_calls: [noteDone('message_send_proposed')] } : { text: 'Sent it.' }; });
    expect(JSON.parse(seen[1]![0]!.output)).toMatchObject({ backed: false, finding: 'no_matching_receipt' });
    expect(result.offered).toHaveLength(2);
    expect(result.notice).toBe('Not confirmed: message send proposed (nothing ran)');
  });

  it('an empty rewrite keeps the original reply and its claims', async () => {
    const result = await run((_tools, _turns, round) => round === 0 ? { text: 'Sent it.', tool_calls: [noteDone('message_send_proposed')] } : { text: '' });
    expect(result.text).toBe('Sent it.');
    expect(result.notice).toBe('Not confirmed: message send proposed (nothing ran)');
  });

  it('the revision spends the shared round budget, and is skipped when none is left', async () => {
    const budget = { remaining: 2 };
    await run(() => ({ text: 'Sent it.', tool_calls: [noteDone('message_send_proposed')] }), { budget });
    expect(budget.remaining).toBe(0);
    const spent = await run(() => ({ text: 'Sent it.', tool_calls: [noteDone('message_send_proposed')] }), { budget: { remaining: 1 } });
    expect(spent.offered).toHaveLength(1);
    expect(spent.notice).toBe('Not confirmed: message send proposed (nothing ran)');
  });

  it('the revision is skipped when the turn has no time left for another model call', async () => {
    const realNow = Date.now;
    const start = realNow();
    let now = start;
    Date.now = () => now;
    try {
      const budget = { remaining: 25, deadline: start + FINAL_ANSWER_RESERVE_MS + 5_000 };
      // The reply comes back with less than one model call's time left before the turn's deadline.
      const result = await run(() => { now = start + 5_001; return { text: 'Sent it.', tool_calls: [noteDone('message_send_proposed')] }; }, { budget });
      expect(result.offered).toHaveLength(1);
      expect(budget.remaining).toBe(24);
      expect(result.notice).toBe('Not confirmed: message send proposed (nothing ran)');
    } finally { Date.now = realNow; }
  });
});
