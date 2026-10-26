import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSessionState, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolCall, type ToolName } from '@waldo/contracts';
import { APP_CHAT_ACTIVITY_KINDS } from '../../contracts/src/app/core';
import { runToolLoop } from '../src/conversation/tool-loop';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';
import { TOOL_RECORDS, toolActivity } from '../src/tools/records';

// While a turn's tools run, the app shows what kind of work it is on. The kind comes from the tool's name alone.

describe('the kind of work a tool is', () => {
  it('names the work the owner would recognise, including the core tools a placement would call generic', () => {
    expect(['search_communication', 'read_thread', 'get_communication', 'send_email'].map(toolActivity)).toEqual(['mail', 'mail', 'mail', 'mail']);
    expect(['query_calendar', 'query_availability', 'propose_calendar_change'].map(toolActivity)).toEqual(['calendar', 'calendar', 'calendar']);
    expect(['get_tasks', 'propose_google_task_change'].map(toolActivity)).toEqual(['tasks', 'tasks']);
    expect(['web_search', 'browse_page', 'browse_act'].map(toolActivity)).toEqual(['web', 'web', 'web']);
    // A connected MCP server may be the owner's mail or calendar, so its tools never claim to be the web.
    expect(['read_mcp_tool', 'search_mcp_tools', 'call_mcp_tool', 'search_connector'].map(toolActivity)).toEqual(['working', 'working', 'working', 'working']);
    expect(['read_drive', 'read_document', 'workspace_read'].map(toolActivity)).toEqual(['files', 'files', 'files']);
    expect(['get_health', 'log_meal'].map(toolActivity)).toEqual(['health', 'health']);
    expect(['read_memory', 'remember', 'search_episodes'].map(toolActivity)).toEqual(['memory', 'memory', 'memory']);
    expect(['set_reminder', 'open_loop', 'list_reminders'].map(toolActivity)).toEqual(['reminders', 'reminders', 'reminders']);
  });

  it('maps every recorded tool into the contract vocabulary, and a name outside the record to generic work', () => {
    for (const name of Object.keys(TOOL_RECORDS)) expect([name, APP_CHAT_ACTIVITY_KINDS.includes(toolActivity(name))]).toEqual([name, true]);
    expect(toolActivity('fixture_unrecorded_tool')).toBe('working');
  });
});

describe('the tool loop says which tool starts', () => {
  const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
  const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
  const ctx = () => ({
    authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null as 'external' | null,
    sanitise: adapters.safety.sanitise, hasApproval: async () => true, session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
  });
  const allowlist = (name: string) => triggerTypeSchema.options.filter((trigger) => (TOOL_PERMISSIONS[trigger] as readonly ToolName[]).includes(name as ToolName));
  const read = (name: string, timeline: unknown[]) => ({
    name, description: `fixture ${name}`, schema: z.object({ query: z.string().optional(), thread_id: z.string().optional() }), autonomy_gated: false, trigger_allowlist: allowlist(name),
    handle: async () => { timeline.push(`run:${name}`); return { ok: true, data: { found: 1 }, source_taint: null }; },
  });
  const ask: LLMToolCall = { call_id: 'mail-1', name: 'search_communication', arguments: JSON.stringify({ query: 'from:alice@example.com invoice' }) };

  it('announces each call by name before it runs, never its arguments, and not a refused repeat', async () => {
    const timeline: unknown[] = [];
    let steps = 0;
    await runToolLoop({
      handlers: [read('search_communication', timeline), read('read_thread', timeline)] as never, ctx: ctx(), maxSteps: 4,
      onToolStart: (...args: unknown[]) => { timeline.push(args); },
      step: async () => {
        steps += 1;
        if (steps === 1) return { text: '', tool_calls: [ask, { call_id: 'thread-1', name: 'read_thread', arguments: JSON.stringify({ thread_id: 't-1' }) }] };
        if (steps === 2) return { text: '', tool_calls: [{ ...ask, call_id: 'mail-2' }] };
        return { text: 'Done.' };
      },
    });
    // The two mail reads run as one batch: both are announced, then both run.
    expect(timeline).toEqual([['search_communication'], ['read_thread'], 'run:search_communication', 'run:read_thread']);
    expect(JSON.stringify(timeline)).not.toContain('alice@example.com');
  });

  it('announces each read of a concurrent batch before it runs', async () => {
    const timeline: unknown[] = [];
    let steps = 0;
    await runToolLoop({
      handlers: [read('read_memory', timeline), read('search_episodes', timeline)] as never, ctx: ctx(), maxSteps: 4,
      onToolStart: (tool) => { timeline.push(`start:${tool}`); },
      step: async () => (steps += 1) === 1
        ? { text: '', tool_calls: [{ call_id: 'm-1', name: 'read_memory', arguments: '{"query":"a"}' }, { call_id: 'e-1', name: 'search_episodes', arguments: '{"query":"b"}' }] }
        : { text: 'Done.' },
    });
    expect(timeline).toEqual(['start:read_memory', 'start:search_episodes', 'run:read_memory', 'run:search_episodes']);
  });
});
