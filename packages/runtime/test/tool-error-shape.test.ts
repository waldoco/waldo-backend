import {
  TOOL_ERRORS,
  TOOL_PERMISSIONS,
  buildSessionState,
  callMcpToolArgsSchema,
  draftDocumentArgsSchema,
  getCrsArgsSchema,
  sendMessageArgsSchema,
  toolErrorCodeSchema,
  writeTaskArgsSchema,
  type ToolHandler,
  type ToolName,
  type TriggerType,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { dispatchTool, type DispatchToolResult, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { HookHaltError, TAINT_NEEDS_APPROVAL_REASON, type HookRegistry } from '../src/hooks/registry';
import { runToolLoop } from '../src/conversation/tool-loop';
import { sanitise } from '../src/scribe/sanitiser';
import { getContextHandler } from '../src/tools/live/get-context';

// The strings the model used to be handed instead of a reason it could act on.
const LEGACY = ['hook halted', 'tool handler failed', 'tool hook failed'];
const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'];
const allowlist = (tool: ToolName): TriggerType[] => (Object.keys(TOOL_PERMISSIONS) as TriggerType[]).filter((trigger) => TOOL_PERMISSIONS[trigger].includes(tool));
const context = (trigger: TriggerType, over: Partial<ToolDispatcherContext> = {}): ToolDispatcherContext => ({
  authenticatedUserId: 'user-1', trigger,
  session: buildSessionState({ trigger, canary_tokens: canaryTokens, started_at: 1_700_000_000_000 }),
  hasApproval: () => true, sourceTaint: null, toolArgSourceTaint: null, sanitise, egressAllowlist: ['example.com'],
  ...over,
});
const crs = (handle: ToolHandler<{ range_days: number }, unknown, ToolDispatcherContext>['handle'], over: Partial<ToolHandler<{ range_days: number }, unknown, ToolDispatcherContext>> = {}): ToolHandler<{ range_days: number }, unknown, ToolDispatcherContext> => ({
  name: 'get_crs', description: 'Return a derived summary.', schema: getCrsArgsSchema, trigger_allowlist: allowlist('get_crs'), autonomy_gated: false, handle, ...over,
});
const okCrs = crs(async () => ({ ok: true, data: { summary: 'steady' }, source_taint: null }));
const writeTask: ToolHandler<{ title: string; reasoning: string }, unknown, ToolDispatcherContext> = {
  name: 'write_task', description: 'Create a task.', schema: writeTaskArgsSchema, trigger_allowlist: allowlist('write_task'), autonomy_gated: true,
  handle: async () => ({ ok: true, data: { task_id: 't1' }, source_taint: null }),
};
const sendMessage: ToolHandler<unknown, unknown, ToolDispatcherContext> = {
  name: 'send_message', description: 'Queue a message.', schema: sendMessageArgsSchema, trigger_allowlist: allowlist('send_message'), autonomy_gated: false,
  handle: async () => ({ ok: true, data: { queued: true }, source_taint: null }),
};
const draftDocument: ToolHandler<unknown, unknown, ToolDispatcherContext> = {
  name: 'draft_document', description: 'Draft.', schema: draftDocumentArgsSchema, trigger_allowlist: allowlist('draft_document'), autonomy_gated: true,
  handle: async () => ({ ok: true, data: { drafted: true }, source_taint: null }),
};
const mcp: ToolHandler<unknown, unknown, ToolDispatcherContext> = {
  name: 'call_mcp_tool', description: 'MCP.', schema: callMcpToolArgsSchema, trigger_allowlist: allowlist('call_mcp_tool'), autonomy_gated: true,
  handle: async () => ({ ok: true, data: {}, source_taint: 'external' }),
};
const taskArgs = { title: 'follow up', reasoning: 'requested by user' };
const retargetResult: HookRegistry<ToolDispatcherContext> = [{
  name: 'retarget', event: 'PostToolUse', priority: 1,
  async handle(payload) { return payload.event === 'PostToolUse' ? { ok: true, payload: { ...payload, tool: 'get_health' } } : { ok: true }; },
}];

type Case = Readonly<{ reason: string; error_code: string; retryable: boolean; run: () => Promise<DispatchToolResult> }>;
// One row per ToolDispatchErrorReason, plus the stage variants that share a reason.
const CASES: readonly Case[] = [
  { reason: 'unknown_tool', error_code: 'unknown_tool', retryable: false, run: () => dispatchTool({ id: 'c', name: 'launch_rocket' as ToolName, args: {} }, context('brief'), { handlers: [okCrs] }) },
  { reason: 'hook_halt', error_code: 'unauthenticated', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief', { authenticatedUserId: ' ' }), { handlers: [okCrs] }) },
  { reason: 'acl_denied', error_code: 'acl_denied', retryable: false, run: () => dispatchTool({ id: 'c', name: 'write_task', args: taskArgs }, context('brief'), { handlers: [writeTask] }) },
  { reason: 'handler_unavailable', error_code: 'handler_unavailable', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [] }) },
  { reason: 'handler_acl_drift', error_code: 'handler_acl_drift', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(okCrs.handle, { trigger_allowlist: ['user_message'] })] }) },
  { reason: 'invalid_args', error_code: 'invalid_args', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 'soon' } }, context('brief'), { handlers: [okCrs] }) },
  { reason: 'invalid_args', error_code: 'invalid_args', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(okCrs.handle, { schema: writeTaskArgsSchema as never })] }) },
  { reason: 'approval_denied', error_code: 'approval_denied', retryable: false, run: () => dispatchTool({ id: 'c', name: 'write_task', args: taskArgs }, context('user_message', { hasApproval: () => false }), { handlers: [writeTask] }) },
  { reason: 'approval_denied', error_code: 'approval_check_unavailable', retryable: false, run: () => dispatchTool({ id: 'c', name: 'write_task', args: taskArgs }, context('user_message', { hasApproval: undefined }), { handlers: [writeTask] }) },
  { reason: 'approval_denied', error_code: 'taint_needs_approval', retryable: false, run: () => dispatchTool({ id: 'c', name: 'draft_document', args: { title: 'Notes', body_markdown: 'from the page', destination: 'drive' } }, context('user_message', { toolArgSourceTaint: 'external' }), { handlers: [draftDocument] }) },
  { reason: 'approval_denied', error_code: 'taint_needs_approval', retryable: false, run: () => dispatchTool({ id: 'c', name: 'call_mcp_tool', args: { server: 's', tool: 't', args: {} } }, context('user_message', { toolArgSourceTaint: 'external' }), { handlers: [mcp] }) },
  { reason: 'sanitise_denied', error_code: 'sanitise_denied', retryable: false, run: () => dispatchTool({ id: 'c', name: 'send_message', args: { channel: 'telegram', content: '{"summary":{"hrv":41}}', idempotency_key: 'a'.repeat(64) } }, context('user_message'), { handlers: [sendMessage] }) },
  { reason: 'handler_failed', error_code: 'handler_failed', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(async () => { throw new Error('boom'); })] }) },
  { reason: 'invalid_handler_result', error_code: 'invalid_handler_result', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(async () => 'nope' as never)] }) },
  { reason: 'tool_result_error', error_code: 'transient', retryable: true, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(async () => ({ ok: false, error: 'provider timed out', code: 'transient' }))] }) },
  { reason: 'tool_result_error', error_code: 'rejected', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(async () => ({ ok: false, error: 'no such range', code: 'rejected' }))] }) },
  { reason: 'tool_result_error', error_code: 'auth_failed', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(async () => ({ ok: false, error: 'not connected', code: 'auth_failed' }))] }) },
  { reason: 'invalid_tool_result', error_code: 'invalid_tool_result', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [okCrs], extraHooks: retargetResult }) },
  { reason: 'result_oversize', error_code: 'result_oversize', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [okCrs], maxResultJsonChars: 8 }) },
  { reason: 'effect_receipt_unavailable', error_code: 'effect_receipt_unavailable', retryable: false, run: () => dispatchTool({ id: 'c', name: 'get_crs', args: { range_days: 1 } }, context('brief'), { handlers: [crs(okCrs.handle, { idempotentOnKey: true })], trustedEffect: { async prepare() { return { idempotency_key: 'idk_11111111111111111111111111111111', request_digest: '1'.repeat(64), operation: 'issue' }; } } }) },
];

const shaped = (value: unknown) => {
  expect(value).toMatchObject({ ok: false, error: expect.any(String), error_code: expect.any(String), fix: expect.any(String), retryable: expect.any(Boolean) });
  const result = value as { error: string; error_code: string; fix: string };
  expect(result.error.length).toBeGreaterThan(0);
  expect(result.fix.length).toBeGreaterThan(0);
  expect(toolErrorCodeSchema.safeParse(result.error_code).success).toBe(true);
  for (const legacy of LEGACY) expect(JSON.stringify(value)).not.toContain(legacy);
};

describe('one error shape across every refusal path', () => {
  it.each(CASES.map((c) => [`${c.reason} -> ${c.error_code}`, c] as const))('%s carries code, cause, fix and retryable', async (_label, c) => {
    const result = await c.run();
    shaped(result);
    expect(result).toMatchObject({ reason: c.reason, error_code: c.error_code, retryable: c.retryable });
  });

  it('the catalogue names every code once, with a cause and a fix the model can act on, and never the legacy text', () => {
    expect(Object.keys(TOOL_ERRORS).sort()).toEqual([...toolErrorCodeSchema.options].sort());
    for (const [code, entry] of Object.entries(TOOL_ERRORS)) {
      expect(entry.cause.length, code).toBeGreaterThan(0);
      expect(entry.fix.length, code).toBeGreaterThan(0);
      for (const legacy of LEGACY) expect(`${entry.cause} ${entry.fix}`).not.toContain(legacy);
    }
    // Only a typed adapter failure explicitly classified transient permits a repeat of the same call.
    expect(Object.entries(TOOL_ERRORS).filter(([, e]) => e.retryable).map(([code]) => code)).toEqual(['transient']);
  });

  it('every hook halt reason resolves to a specific code and keeps security reasons out of the client text', () => {
    const halts: readonly [hook: string, reason: string, code: 'forbidden' | 'transient' | 'invalid_args' | 'auth_failed' | 'rate_limited', expected: string][] = [
      ['acl_check', 'tool outside trigger ACL', 'forbidden', 'acl_denied'],
      ['tool_arg_zod_validate', 'invalid tool arguments: range_days: expected number', 'invalid_args', 'invalid_args'],
      ['tool_arg_sanitise', 'scribe:health_value_leak', 'forbidden', 'sanitise_denied'],
      ['scribe_sanitise', 'scribe:secret_leak', 'forbidden', 'sanitise_denied'],
      ['autonomy_gate_check', TAINT_NEEDS_APPROVAL_REASON, 'forbidden', 'taint_needs_approval'],
      ['autonomy_gate_check', 'privileged action lacks approval', 'forbidden', 'approval_denied'],
      ['autonomy_gate_check', 'approval check unavailable', 'forbidden', 'approval_check_unavailable'],
      ['autonomy_gate_check', 'approval check failed', 'transient', 'approval_check_unavailable'],
      ['egress_allowlist_check', 'egress destination denied', 'forbidden', 'egress_denied'],
      ['jwt_validate', 'authenticated user missing', 'auth_failed', 'unauthenticated'],
      ['acl_check', 'session unavailable', 'auth_failed', 'unauthenticated'],
      ['rate_limit_check', 'rate limit denied', 'rate_limited', 'rate_limited'],
      ['canary_leak_check', 'canary token leaked', 'forbidden', 'sanitise_denied'],
      ['custom_hook', 'hook threw', 'transient', 'hook_failed'],
      ['custom_hook', 'hook timed out', 'transient', 'hook_failed'],
      ['medical_gate', 'unsafe output', 'forbidden', 'hook_denied'],
    ];
    for (const [hook, reason, code, expected] of halts) {
      const error = new HookHaltError(hook, reason, code);
      expect(error.toolError.code, `${hook}: ${reason}`).toBe(expected);
      expect(error.clientMessage).toBe(error.toolError.cause);
      expect(error.onErrorPayload).toEqual({ event: 'OnError', error: error.toolError.cause, code });
      for (const legacy of LEGACY) expect(error.clientMessage).not.toContain(legacy);
      // Only model-authored argument detail is echoed; every other halt stays opaque.
      if (code !== 'invalid_args') expect(error.clientMessage).not.toContain(reason);
    }
    expect(new HookHaltError('tool_arg_zod_validate', 'invalid tool arguments: range_days: expected number', 'invalid_args').clientMessage).toContain('range_days');
  });

  it('the loop refusals carry the same shape', async () => {
    const outputs: Record<string, unknown>[] = [];
    const ctx = context('user_message');
    const handlers = [getContextHandler({ timezone: 'Asia/Kolkata', now: () => new Date('2026-09-23T08:20:00Z') })];
    let round = 0;
    await runToolLoop({
      handlers, ctx, maxSteps: 2,
      onTool: (event) => outputs.push(JSON.parse(event.output.split('\n[')[0]!)),
      step: async (tools) => {
        round += 1;
        if (!tools) return { text: 'done' };
        if (round === 1) return { text: '', tool_calls: [{ call_id: 'u', name: 'launch_rocket', arguments: '{}' }, { call_id: 'j', name: 'get_context', arguments: '{not json' }, { call_id: 'g1', name: 'get_context', arguments: '{}' }] };
        return { text: '', tool_calls: [{ call_id: 'g2', name: 'get_context', arguments: '{}' }] };
      },
    });
    expect(outputs).toHaveLength(4);
    shaped(outputs[0]);
    expect(outputs[0]).toMatchObject({ error_code: 'unknown_tool', retryable: false });
    shaped(outputs[1]);
    expect(outputs[1]).toMatchObject({ error_code: 'invalid_json_args', retryable: false });
    expect(outputs[2]).toMatchObject({ ok: true });
    shaped(outputs[3]);
    expect(outputs[3]).toMatchObject({ error_code: 'repeat_refusal', retryable: false, error: expect.stringContaining('Same call already made this turn') });
  });

  it('the loop retries from retryable alone: a transient adapter failure may run again, a handler throw may not', async () => {
    let transientRuns = 0;
    let throwRuns = 0;
    const transient = crs(async () => { transientRuns += 1; return { ok: false, error: 'provider timed out', code: 'transient' }; });
    const throwing = crs(async () => { throwRuns += 1; throw new Error('boom'); });
    const loop = (handler: typeof transient) => runToolLoop({
      handlers: [handler], ctx: context('brief'), maxSteps: 3,
      step: async (tools) => (tools ? { text: '', tool_calls: [{ call_id: `r${Math.random()}`, name: 'get_crs', arguments: '{"range_days":1}' }] } : { text: 'done' }),
    });
    await loop(transient);
    await loop(throwing);
    expect(transientRuns).toBe(3);
    expect(throwRuns).toBe(1);
  });
});
