import { describe, expect, it } from 'vitest';
import { buildSessionState, getCrsArgsSchema, triggerTypeSchema, type LLMTool } from '@waldo/contracts';
import { runToolLoop, type LoopExit } from '../src/conversation/tool-loop';
import { CHILD_TOOL_NAMES, delegateTaskHandler, SUBAGENT_MAX_ROUNDS, SUBAGENT_MAX_SPAWNS_PER_TURN, SUBAGENT_SYSTEM_PROMPT } from '../src/conversation/subagent';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = {
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null,
  sanitise: adapters.safety.sanitise, medicalGate: adapters.safety.medicalGate,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
};

const stubRead = (name: string) => ({
  name: name as never,
  description: `${name} read`,
  schema: getCrsArgsSchema,
  trigger_allowlist: triggerTypeSchema.options,
  autonomy_gated: false,
  handle: async () => ({ ok: true as const, data: { echo: name }, source_taint: null }),
});

describe('delegate_task (subagent orchestration v1)', () => {
  it('runs a child loop on the read-only subset and hands back the summary with exit completed', async () => {
    const childToolSets: (readonly string[] | undefined)[] = [];
    const delegate = delegateTaskHandler(async (task) => {
      // The real spawner runs a nested runToolLoop; mirror that here with the same wiring the
      // turn uses: narrowed handlers, own slice, own settle classification.
      let exit: LoopExit = 'completed';
      const text = await runToolLoop({
        handlers: [stubRead('web_search'), stubRead('read_memory')],
        ctx, maxSteps: SUBAGENT_MAX_ROUNDS,
        onSettle: (settled) => { exit = settled; },
        step: async (tools, turns) => {
          childToolSets.push(tools?.map((tool: LLMTool) => tool.name));
          if (turns.length === 0) return { text: '', tool_calls: [{ call_id: 'c1', name: 'web_search', arguments: `{"q":${JSON.stringify(task)}}` }] };
          return { text: `found stuff about: ${task}` };
        },
      });
      return { exit, text };
    });
    expect(CHILD_TOOL_NAMES).not.toContain('delegate_task');
    expect(CHILD_TOOL_NAMES).not.toContain('send_message');
    expect(SUBAGENT_SYSTEM_PROMPT).toContain('cannot message anyone');

    const outputs: string[] = [];
    let n = 0;
    const text = await runToolLoop({
      handlers: [stubRead('web_search'), delegate], ctx, maxSteps: 10,
      onTool: (event) => outputs.push(event.output),
      step: async (tools, turns) => {
        n += 1;
        expect(tools?.map((tool) => tool.name)).toContain('delegate_task');
        if (n === 1) return { text: '', tool_calls: [{ call_id: 'd1', name: 'delegate_task', arguments: '{"task":"research cursor pagination"}' }] };
        return { text: turns.length ? 'parent closes with the summary.' : '' };
      },
    });
    expect(text).toBe('parent closes with the summary.');
    expect(childToolSets[0]).toEqual(['web_search', 'read_memory']);
    const handback = JSON.parse(outputs[0]!);
    expect(handback).toMatchObject({ ok: true, data: { status: 'completed', summary: 'found stuff about: research cursor pagination' } });
  });

  it('refuses a fourth spawn in one turn (owner-delegated max 3) as a normal failed round', async () => {
    const delegate = delegateTaskHandler(async () => ({ exit: 'completed' as const, text: 'done' }));
    const outputs: string[] = [];
    let n = 0;
    await runToolLoop({
      handlers: [delegate], ctx, maxSteps: 10,
      onTool: (event) => outputs.push(event.output),
      step: async (tools) => {
        n += 1;
        if (!tools) return { text: 'closed.' };
        return { text: '', tool_calls: [{ call_id: `d${n}`, name: 'delegate_task', arguments: `{"task":"task ${n}"}` }] };
      },
    });
    // Parse only the rounds under assertion: later rounds fall inside the warn-first window
    // (WARN_WINDOW_ROUNDS) and their outputs carry the budget notice appended after the JSON.
    const results = outputs.slice(0, SUBAGENT_MAX_SPAWNS_PER_TURN + 1).map((output) => JSON.parse(output));
    expect(results.slice(0, SUBAGENT_MAX_SPAWNS_PER_TURN).every((result) => result.ok)).toBe(true);
    expect(results[SUBAGENT_MAX_SPAWNS_PER_TURN]).toMatchObject({ ok: false, code: 'rejected' });
    expect(results[SUBAGENT_MAX_SPAWNS_PER_TURN].error).toContain('Subagent limit');
  });

  it('a child that exhausts its slice hands back a failed round with the truthful reason', async () => {
    const delegate = delegateTaskHandler(async () => ({ exit: 'budget_exhausted' as const, text: 'partial findings' }));
    const outputs: string[] = [];
    let n = 0;
    await runToolLoop({
      handlers: [delegate], ctx, maxSteps: 5,
      onTool: (event) => outputs.push(event.output),
      step: async (tools) => {
        n += 1;
        return tools && n === 1 ? { text: '', tool_calls: [{ call_id: 'd1', name: 'delegate_task', arguments: '{"task":"long task"}' }] } : { text: 'closed.' };
      },
    });
    const result = JSON.parse(outputs[0]!);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ran out of its round budget');
    expect(result.error).toContain('partial findings');
  });
});

describe('runToolLoop exit classification', () => {
  it('settles completed when the model closes with tools still offered', async () => {
    let exit: LoopExit | undefined;
    await runToolLoop({
      handlers: [stubRead('web_search')], ctx, maxSteps: 5,
      onSettle: (settled) => { exit = settled; },
      step: async () => ({ text: 'done.' }),
    });
    expect(exit).toBe('completed');
  });

  it('settles budget_exhausted when maxSteps withdraws the tools', async () => {
    let exit: LoopExit | undefined;
    await runToolLoop({
      handlers: [stubRead('web_search')], ctx, maxSteps: 2,
      onSettle: (settled) => { exit = settled; },
      step: async (tools) => (tools ? { text: '', tool_calls: [{ call_id: `c${Math.random()}`, name: 'web_search', arguments: `{"q":"${Math.random()}"}` }] } : { text: 'out of rounds.' }),
    });
    expect(exit).toBe('budget_exhausted');
  });

  it('settles withdrawn when the failure streak withdraws the tools', async () => {
    let exit: LoopExit | undefined;
    await runToolLoop({
      handlers: [stubRead('web_search')], ctx, maxSteps: 25,
      onSettle: (settled) => { exit = settled; },
      step: async (tools) => (tools ? { text: '', tool_calls: [{ call_id: `x${Math.random()}`, name: 'launch_rocket', arguments: `{"n":${Math.random()}}` }] } : { text: 'gave up.' }),
    });
    expect(exit).toBe('withdrawn');
  });
});
