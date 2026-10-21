import { expect, it } from 'vitest';
import { z } from 'zod';
import { browsePageArgsSchema, buildSessionState, createArtifactArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolTurn, type ToolName } from '@waldo/contracts';
import { runToolLoop, TOOL_OUTPUT_LIMIT, TOOL_RESULTS_KEEP_CHARS } from '../src/conversation/tool-loop';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { readToolOutputHandler } from '../src/tools/read-tool-output';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';

// A long turn resends every earlier result each round. Old results are cleared first, before anything else gives way:
// the newest round always reaches the model whole, the calls stay visible, what was cleared stays cleared, and a cleared
// result is one call away: read_tool_output reads its stored copy, a read can run again, and a write keeps its receipt.

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = () => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
});
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name));
// A read whose result is just under the per-result cap, so each round adds about TOOL_OUTPUT_LIMIT characters.
const bigRead = {
  name: 'read_memory', description: 'fixture read', schema: z.object({ query: z.string() }), autonomy_gated: false, trigger_allowlist: allowlist('read_memory'),
  handle: async (args: unknown) => ({ ok: true, data: { query: (args as { query: string }).query, text: 'x'.repeat(TOOL_OUTPUT_LIMIT - 200) }, source_taint: null }),
};
const size = (turns: readonly LLMToolTurn[]) => turns.reduce((sum, turn) => sum + turn.output.length, 0);
const isCleared = (output: string) => output.startsWith('[cleared: ');

it('a turn whose results outgrow the keep budget clears the oldest results, keeps every call and the newest round whole, and stays within budget', async () => {
  const sent: (readonly LLMToolTurn[])[] = [];
  const rounds = 24;
  let step = 0;
  const text = await runToolLoop({
    handlers: [bigRead] as never, ctx: ctx(), maxSteps: rounds + 1,
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      return step <= rounds ? { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] } : { text: 'Done.' };
    },
  });
  expect(text).toBe('Done.');
  const last = sent.at(-1)!;
  // every call is still there, in order; only results gave way
  expect(last.map((turn) => JSON.parse(turn.call.arguments).query)).toEqual(Array.from({ length: rounds }, (_value, index) => `topic ${index + 1}`));
  expect(isCleared(last[0]!.output)).toBe(true);
  expect(last[0]!.output).toContain('read memory result from earlier in this turn (it succeeded)');
  expect(last[0]!.output).toContain('Run it again if you still need it.');
  expect(JSON.parse(last.at(-1)!.output.split('\n[')[0]!)).toMatchObject({ ok: true, data: { query: `topic ${rounds}` } });
  for (const turns of sent) expect(size(turns)).toBeLessThanOrEqual(TOOL_RESULTS_KEEP_CHARS + TOOL_OUTPUT_LIMIT);
  // without clearing the last request would carry every result
  expect(rounds * (TOOL_OUTPUT_LIMIT - 200)).toBeGreaterThan(2 * TOOL_RESULTS_KEEP_CHARS);
});

it('clearing only moves forward: a result once cleared is sent cleared in every later round, and a kept one is never rewritten', async () => {
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  await runToolLoop({
    handlers: [bigRead] as never, ctx: ctx(), maxSteps: 16,
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      return step <= 15 ? { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] } : { text: 'Done.' };
    },
  });
  for (let round = 1; round < sent.length; round += 1) {
    const before = sent[round - 1]!, after = sent[round]!;
    for (const [index, turn] of before.entries()) {
      if (isCleared(turn.output)) expect(after[index]!.output).toBe(turn.output);
      else if (after[index]!.output !== turn.output) expect(isCleared(after[index]!.output)).toBe(true);
    }
  }
  // it clears in steps down to half the budget, not one result per round, so most rounds resend the same prefix
  const clears = sent.slice(1).filter((turns, round) => turns.filter((turn) => isCleared(turn.output)).length > sent[round]!.filter((turn) => isCleared(turn.output)).length).length;
  expect(clears).toBeGreaterThan(0);
  expect(clears).toBeLessThan(sent.length / 2);
});

it('a turn under the keep budget is sent exactly as before', async () => {
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  await runToolLoop({
    handlers: [bigRead] as never, ctx: ctx(), maxSteps: 4,
    step: async (_tools, turns) => {
      sent.push(turns);
      step += 1;
      return step <= 3 ? { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] } : { text: 'Done.' };
    },
  });
  expect(sent.at(-1)!.every((turn) => !isCleared(turn.output))).toBe(true);
});

const bigBrowse = {
  name: 'browse_page', description: 'fixture browser', schema: browsePageArgsSchema, autonomy_gated: false, trigger_allowlist: allowlist('browse_page'),
  handle: async (args: unknown) => ({ ok: true, data: { url: (args as { url: string }).url, text: `PAGE:${(args as { url: string }).url}:` + 'p'.repeat(TOOL_OUTPUT_LIMIT - 300) }, source_taint: 'external' as const }),
};
const pages = (count: number) => Array.from({ length: count }, (_value, index) => ({ call_id: `b${index + 1}`, name: 'browse_page', arguments: JSON.stringify({ url: `https://example.com/p${index + 1}`, instruction: 'read it' }) }));

it('a cleared browse result is read back in one call through the stored handle it names', async () => {
  const store = inMemoryToolOutputStore();
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0, handle = '';
  await runToolLoop({
    handlers: [bigBrowse, readToolOutputHandler(store)] as never, ctx: { ...ctx(), egressAllowlist: ['example.com'] }, maxSteps: 30, offload: store,
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      if (step <= 24) return { text: '', tool_calls: [pages(24)[step - 1]!] };
      if (step === 25) {
        handle = turns[0]!.output.match(/stored as (to-\d+)/)?.[1] ?? '';
        return { text: '', tool_calls: [{ call_id: 'r1', name: 'read_tool_output', arguments: JSON.stringify({ id: handle, offset: 0, length: 200 }) }] };
      }
      return { text: 'Done.' };
    },
  });
  const note = sent[24]![0]!.output;
  expect(isCleared(note)).toBe(true);
  expect(note).toContain('browse page result from earlier in this turn (it succeeded)');
  expect(note).toContain('call read_tool_output with this id to read it again');
  expect(handle).toMatch(/^to-\d+$/);
  // the read returned the first page, not a refusal
  expect(sent.at(-1)!.at(-1)!.output).toContain('PAGE:https://example.com/p1:');
});

it('a cleared write keeps its outcome and receipt link in the note, and is not offered as something to repeat', async () => {
  const url = 'https://staging.invalid/console/artifacts/art%3Aone?revision=1';
  const artifact = {
    name: 'create_artifact', description: 'fixture artifact', schema: createArtifactArgsSchema, autonomy_gated: false, mutates_state: true, trigger_allowlist: allowlist('create_artifact'),
    handle: async () => ({ ok: true, data: { id: 'art:one', revision: 1, delivery: { status: 'owner_link', audience: 'owner_authenticated', url } }, source_taint: null }),
  };
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  await runToolLoop({
    handlers: [artifact, bigRead] as never, ctx: ctx(), maxSteps: 30,
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      if (step === 1) return { text: '', tool_calls: [{ call_id: 'w1', name: 'create_artifact', arguments: JSON.stringify({ name: 'Plan', kind: 'document', body_markdown: 'x' }) }] };
      if (step <= 25) return { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] };
      return { text: 'Done.' };
    },
  });
  const first = sent.at(-1)![0]!;
  expect(first.call.name).toBe('create_artifact');
  expect(isCleared(first.output)).toBe(true);
  expect(first.output).toContain('(it succeeded)');
  expect(first.output).toContain(`Its link: ${url}.`);
  expect(first.output).toContain('Do not repeat the call');
});

it('a cleared read that can repeat dispatches again when called again', async () => {
  const runs = new Map<string, number>();
  const counted = { ...bigRead, handle: async (args: unknown) => { const query = (args as { query: string }).query; runs.set(query, (runs.get(query) ?? 0) + 1); return bigRead.handle(args); } };
  const sent: (readonly LLMToolTurn[])[] = [];
  let step = 0;
  await runToolLoop({
    handlers: [counted] as never, ctx: ctx(), maxSteps: 30,
    step: async (_tools, turns) => {
      sent.push(turns.map((turn) => ({ ...turn })));
      step += 1;
      if (step <= 24) return { text: '', tool_calls: [{ call_id: `c${step}`, name: 'read_memory', arguments: JSON.stringify({ query: `topic ${step}` }) }] };
      if (step === 25) return { text: '', tool_calls: [{ call_id: 'again', name: 'read_memory', arguments: JSON.stringify({ query: 'topic 1' }) }] };
      return { text: 'Done.' };
    },
  });
  expect(isCleared(sent[24]![0]!.output)).toBe(true);
  expect(runs.get('topic 1')).toBe(2);
  expect(JSON.parse(sent.at(-1)!.at(-1)!.output.split('\n[')[0]!)).toMatchObject({ ok: true, data: { query: 'topic 1' } });
});
