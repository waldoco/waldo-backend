import {
  TOOL_PERMISSIONS,
  buildSessionState,
  executeActionArgsSchema,
  executeCodeArgsSchema,
  getCrsArgsSchema,
  writeTaskArgsSchema,
  type ExecuteActionArgs,
  type ExecuteCodeArgs,
  type GetCrsArgs,
  type ToolHandler,
  type ToolName,
  type TriggerType,
  type WriteTaskArgs,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  dispatchTool,
  formatToolDefinitions,
  parseToolCalls,
  type ToolDispatcherContext,
  type RuntimeToolCall,
} from '../src/tools/dispatcher';

const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'];

function triggerAllowlistFor(tool: ToolName): TriggerType[] {
  return (Object.keys(TOOL_PERMISSIONS) as TriggerType[]).filter((trigger) =>
    TOOL_PERMISSIONS[trigger].includes(tool),
  );
}

function dispatcherContext(trigger: TriggerType): ToolDispatcherContext {
  return {
    trigger,
    session: buildSessionState({
      trigger,
      canary_tokens: canaryTokens,
      started_at: 1_700_000_000_000,
    }),
    hasApproval: () => true,
    sanitise: ({ text }) => ({ ok: true, output: text, redactions: [] }),
  };
}

describe('ToolDispatcher', () => {
  it('parses provider-shaped tool calls and dispatches only after ACL and schema gates pass', async () => {
    const expectedCall: RuntimeToolCall = {
      id: 'call-1',
      name: 'get_crs',
      args: { range_days: 2 },
    };
    const anthropicResponse = {
      content: [{ type: 'tool_use', id: 'call-1', name: 'get_crs', input: { range_days: 2 } }],
    };
    const gemmaResponse = {
      text: JSON.stringify({
        tool_calls: [{ id: 'call-1', name: 'get_crs', arguments: { range_days: 2 } }],
      }),
    };

    await expect(parseToolCalls(anthropicResponse)).resolves.toEqual({
      ok: true,
      repaired: false,
      calls: [expectedCall],
    });
    await expect(parseToolCalls(gemmaResponse)).resolves.toEqual({
      ok: true,
      repaired: false,
      calls: [expectedCall],
    });

    const handledArgs: unknown[] = [];
    const handler: ToolHandler<
      GetCrsArgs,
      { summary: string },
      ToolDispatcherContext
    > = {
      name: 'get_crs',
      description: 'Return a derived CRS summary.',
      schema: getCrsArgsSchema,
      trigger_allowlist: triggerAllowlistFor('get_crs'),
      autonomy_gated: false,
      async handle(args) {
        handledArgs.push(args);
        return { ok: true, data: { summary: 'form steady' } };
      },
    };

    await expect(
      dispatchTool(expectedCall, dispatcherContext('brief'), { handlers: [handler] }),
    ).resolves.toEqual({
      ok: true,
      call_id: 'call-1',
      tool: 'get_crs',
      data: { summary: 'form steady' },
    });
    expect(handledArgs).toEqual([{ range_days: 2 }]);
  });

  it('formats lazy-discovery tool definitions without widening the trigger ACL', () => {
    const handlers = (
      ['read_memory', 'send_message', 'propose_action', 'search_tools', 'web_search'] as const
    ).map(
      (name): ToolHandler<unknown, unknown, ToolDispatcherContext> => ({
        name,
        description: `${name} description`,
        schema: getCrsArgsSchema,
        trigger_allowlist: triggerAllowlistFor(name),
        autonomy_gated: name === 'send_message',
        async handle() {
          return { ok: true, data: null };
        },
      }),
    );

    expect(formatToolDefinitions('user_message', handlers).map((tool) => tool.name)).toEqual([
      'read_memory',
      'send_message',
      'propose_action',
      'search_tools',
    ]);
    expect(formatToolDefinitions('handoff_explore', handlers).map((tool) => tool.name)).toEqual([
      'read_memory',
      'search_tools',
    ]);
    expect(formatToolDefinitions('brief', handlers).map((tool) => tool.name)).toEqual([
      'read_memory',
      'send_message',
      'propose_action',
    ]);
  });

  it('rejects tools outside the session trigger ACL before handler execution', async () => {
    let handled = false;
    const handler: ToolHandler<
      ExecuteActionArgs,
      { executed: true },
      ToolDispatcherContext
    > = {
      name: 'execute_action',
      description: 'Execute a confirmed action.',
      schema: executeActionArgsSchema,
      trigger_allowlist: triggerAllowlistFor('execute_action'),
      autonomy_gated: true,
      async handle() {
        handled = true;
        return { ok: true, data: { executed: true } };
      },
    };

    await expect(
      dispatchTool(
        {
          id: 'call-denied',
          name: 'execute_action',
          args: { action_id: 'action-1', confirmation_token: 'confirm-1', user_id: 'user-1' },
        },
        dispatcherContext('brief'),
        { handlers: [handler] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-denied',
      tool: 'execute_action',
      error: 'tool outside trigger ACL',
      code: 'forbidden',
      reason: 'acl_denied',
    });
    expect(handled).toBe(false);
  });

  it('enforces the session ACL even when callers inject a custom hook registry', async () => {
    let handled = false;
    const handler: ToolHandler<
      ExecuteActionArgs,
      { executed: true },
      ToolDispatcherContext
    > = {
      name: 'execute_action',
      description: 'Execute a confirmed action.',
      schema: executeActionArgsSchema,
      trigger_allowlist: triggerAllowlistFor('execute_action'),
      autonomy_gated: true,
      async handle() {
        handled = true;
        return { ok: true, data: { executed: true } };
      },
    };

    await expect(
      dispatchTool(
        {
          id: 'call-direct-acl-denied',
          name: 'execute_action',
          args: { action_id: 'action-1', confirmation_token: 'confirm-1', user_id: 'user-1' },
        },
        dispatcherContext('brief'),
        { handlers: [handler], extraHooks: [] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-direct-acl-denied',
      tool: 'execute_action',
      error: 'tool outside trigger ACL',
      code: 'forbidden',
      reason: 'acl_denied',
    });
    expect(handled).toBe(false);
  });

  it('rejects handler ACL drift before handler execution', async () => {
    let handled = false;
    const handler: ToolHandler<
      GetCrsArgs,
      { summary: string },
      ToolDispatcherContext
    > = {
      name: 'get_crs',
      description: 'Return a derived CRS summary.',
      schema: getCrsArgsSchema,
      trigger_allowlist: [],
      autonomy_gated: false,
      async handle() {
        handled = true;
        return { ok: true, data: { summary: 'should not run' } };
      },
    };

    await expect(
      dispatchTool(
        { id: 'call-drift', name: 'get_crs', args: { range_days: 1 } },
        dispatcherContext('brief'),
        { handlers: [handler] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-drift',
      tool: 'get_crs',
      error: 'tool handler ACL drift',
      code: 'transient',
      reason: 'handler_acl_drift',
    });
    expect(handled).toBe(false);
  });

  it('keeps default autonomy hooks when callers add extra hooks', async () => {
    let handled = false;
    const handler: ToolHandler<
      WriteTaskArgs,
      { task_id: string },
      ToolDispatcherContext
    > = {
      name: 'write_task',
      description: 'Create a task.',
      schema: writeTaskArgsSchema,
      trigger_allowlist: triggerAllowlistFor('write_task'),
      autonomy_gated: true,
      async handle() {
        handled = true;
        return { ok: true, data: { task_id: 'task-1' } };
      },
    };

    await expect(
      dispatchTool(
        {
          id: 'call-no-approval',
          name: 'write_task',
          args: { title: 'follow up', reasoning: 'requested by user' },
        },
        {
          ...dispatcherContext('user_message'),
          hasApproval: () => false,
        },
        { handlers: [handler], extraHooks: [] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-no-approval',
      tool: 'write_task',
      error: 'hook halted',
      code: 'forbidden',
      reason: 'approval_denied',
    });
    expect(handled).toBe(false);
  });

  it('rejects oversized sanitized tool results before they re-enter model context', async () => {
    const handler: ToolHandler<
      GetCrsArgs,
      { summary: string },
      ToolDispatcherContext
    > = {
      name: 'get_crs',
      description: 'Return a derived CRS summary.',
      schema: getCrsArgsSchema,
      trigger_allowlist: triggerAllowlistFor('get_crs'),
      autonomy_gated: false,
      async handle() {
        return { ok: true, data: { summary: 'x'.repeat(20_000) } };
      },
    };

    await expect(
      dispatchTool(
        { id: 'call-large', name: 'get_crs', args: { range_days: 1 } },
        dispatcherContext('brief'),
        { handlers: [handler] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-large',
      tool: 'get_crs',
      error: 'tool result exceeded bound',
      code: 'oversize',
      reason: 'result_oversize',
    });
  });

  it('runs one repair attempt for malformed provider tool-call output', async () => {
    let repairCalls = 0;

    await expect(
      parseToolCalls('call get_crs with range_days=2', {
        repair: () => {
          repairCalls += 1;
          return {
            tool_calls: [{ id: 'call-repaired', name: 'get_crs', arguments: { range_days: 2 } }],
          };
        },
      }),
    ).resolves.toEqual({
      ok: true,
      repaired: true,
      calls: [{ id: 'call-repaired', name: 'get_crs', args: { range_days: 2 } }],
    });
    expect(repairCalls).toBe(1);

    await expect(
      parseToolCalls('still malformed', {
        repair: () => {
          repairCalls += 1;
          return 'still not json';
        },
      }),
    ).resolves.toEqual({
      ok: false,
      repaired: true,
      error: 'tool-call text is not valid JSON',
      code: 'invalid_args',
    });
    expect(repairCalls).toBe(2);
  });

  it('rejects unknown and malformed provider tool calls deterministically', async () => {
    await expect(
      parseToolCalls({
        tool_calls: [{ id: 'call-unknown', name: 'get_schedule', arguments: {} }],
      }),
    ).resolves.toEqual({
      ok: false,
      repaired: false,
      error: 'unknown tool',
      code: 'invalid_args',
    });

    await expect(
      parseToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-malformed',
                  function: { name: 'get_crs', arguments: '{not-json}' },
                },
              ],
            },
          },
        ],
      }),
    ).resolves.toEqual({
      ok: false,
      repaired: false,
      error: 'tool call args missing or malformed',
      code: 'invalid_args',
    });

    await expect(
      parseToolCalls({
        tool_calls: [
          { id: 'call-duplicate', name: 'get_crs', arguments: { range_days: 1 } },
          { id: 'call-duplicate', name: 'get_health', arguments: {} },
        ],
      }),
    ).resolves.toEqual({
      ok: false,
      repaired: false,
      error: 'duplicate tool call id',
      code: 'invalid_args',
    });
  });

  it('validates tool args before handler execution', async () => {
    let handled = false;
    const handler: ToolHandler<
      GetCrsArgs,
      { summary: string },
      ToolDispatcherContext
    > = {
      name: 'get_crs',
      description: 'Return a derived CRS summary.',
      schema: getCrsArgsSchema,
      trigger_allowlist: triggerAllowlistFor('get_crs'),
      autonomy_gated: false,
      async handle() {
        handled = true;
        return { ok: true, data: { summary: 'form steady' } };
      },
    };

    await expect(
      dispatchTool(
        { id: 'call-invalid-args', name: 'get_crs', args: { range_days: 91 } },
        dispatcherContext('brief'),
        { handlers: [handler], extraHooks: [] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-invalid-args',
      tool: 'get_crs',
      error: 'hook halted',
      code: 'invalid_args',
      reason: 'invalid_args',
    });
    expect(handled).toBe(false);
  });

  it('returns optional tool result cards after PostToolUse validation', async () => {
    const handler: ToolHandler<
      GetCrsArgs,
      { summary: string },
      ToolDispatcherContext
    > = {
      name: 'get_crs',
      description: 'Return a derived CRS summary.',
      schema: getCrsArgsSchema,
      trigger_allowlist: triggerAllowlistFor('get_crs'),
      autonomy_gated: false,
      async handle() {
        return {
          ok: true,
          data: { summary: 'form steady' },
          card: {
            kind: 'brief_card',
            card_id: 'card-crs',
            data: {
              source_refs: ['crs-summary'],
              form_zone: 'steady',
              variant: 'morning',
            },
          },
        };
      },
    };

    await expect(
      dispatchTool(
        { id: 'call-card', name: 'get_crs', args: { range_days: 1 } },
        dispatcherContext('brief'),
        { handlers: [handler] },
      ),
    ).resolves.toEqual({
      ok: true,
      call_id: 'call-card',
      tool: 'get_crs',
      data: { summary: 'form steady' },
      card: {
        kind: 'brief_card',
        card_id: 'card-crs',
        data: {
          source_refs: ['crs-summary'],
          form_zone: 'steady',
          variant: 'morning',
        },
      },
    });
  });

  it('keeps execute_code typed but dispatchable nowhere in V1', async () => {
    let handled = false;
    const handler: ToolHandler<
      ExecuteCodeArgs,
      { stdout: string },
      ToolDispatcherContext
    > = {
      name: 'execute_code',
      description: 'Run sandboxed code.',
      schema: executeCodeArgsSchema,
      trigger_allowlist: triggerAllowlistFor('execute_code'),
      autonomy_gated: true,
      async handle() {
        handled = true;
        return { ok: true, data: { stdout: 'never' } };
      },
    };

    await expect(
      dispatchTool(
        { id: 'call-code', name: 'execute_code', args: { language: 'js', code: '1 + 1' } },
        dispatcherContext('user_message'),
        { handlers: [handler] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-code',
      tool: 'execute_code',
      error: 'tool outside trigger ACL',
      code: 'forbidden',
      reason: 'acl_denied',
    });
    expect(handled).toBe(false);
  });

  it('returns the PostToolUse-sanitised handler result', async () => {
    const handler: ToolHandler<
      GetCrsArgs,
      { summary: string },
      ToolDispatcherContext
    > = {
      name: 'get_crs',
      description: 'Return a derived CRS summary.',
      schema: getCrsArgsSchema,
      trigger_allowlist: triggerAllowlistFor('get_crs'),
      autonomy_gated: false,
      async handle() {
        return { ok: true, data: { summary: 'email user@example.com' } };
      },
    };

    await expect(
      dispatchTool(
        { id: 'call-sanitise', name: 'get_crs', args: { range_days: 1 } },
        {
          ...dispatcherContext('brief'),
          sanitise: ({ text }) => ({
            ok: true,
            output: text.replace('user@example.com', '[redacted]'),
            redactions: text.includes('user@example.com') ? [{ kind: 'email', count: 1 }] : [],
          }),
        },
        { handlers: [handler] },
      ),
    ).resolves.toEqual({
      ok: true,
      call_id: 'call-sanitise',
      tool: 'get_crs',
      data: { summary: 'email [redacted]' },
    });
  });

  it('bounds handler failure errors before returning them', async () => {
    const handler: ToolHandler<
      GetCrsArgs,
      { summary: string },
      ToolDispatcherContext
    > = {
      name: 'get_crs',
      description: 'Return a derived CRS summary.',
      schema: getCrsArgsSchema,
      trigger_allowlist: triggerAllowlistFor('get_crs'),
      autonomy_gated: false,
      async handle() {
        return { ok: false, error: 'x'.repeat(20_000), code: 'transient' };
      },
    };

    await expect(
      dispatchTool(
        { id: 'call-error', name: 'get_crs', args: { range_days: 1 } },
        dispatcherContext('brief'),
        { handlers: [handler] },
      ),
    ).resolves.toEqual({
      ok: false,
      call_id: 'call-error',
      tool: 'get_crs',
      error: 'tool returned oversized error',
      code: 'transient',
      reason: 'tool_result_error',
    });
  });
});
