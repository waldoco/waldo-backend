import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionState, getContextArgsSchema, readDriveArgsSchema, sendMessageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ToolHandler, type ToolName } from '@waldo/contracts';
import { runToolLoop } from '../src/conversation/tool-loop';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { READ_TOOL_TIMEOUT_MS } from '../src/llm/time-budget';
import { resolveRunLoopAdapters } from '../src/llm/run-loop-adapters';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = (): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null, hasApproval: () => true,
  sanitise: adapters.safety.sanitise,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }),
});
const allowed = (tool: ToolName) => triggerTypeSchema.options.filter((t) => TOOL_PERMISSIONS[t].includes(tool));
const never = <T>() => new Promise<T>(() => undefined);
const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const DRIVE_ARGS = { action: 'get', file_id: 'synthetic-file-1' };
const answer = { ok: true as const, data: { answer: 'synthetic' }, source_taint: null };

let contextCalls = 0;
const contextRead = (hangFirst: boolean): ToolHandler<never, never, ToolDispatcherContext> => ({
  name: 'get_context', description: 'Read context.', schema: getContextArgsSchema as never, trigger_allowlist: allowed('get_context'), autonomy_gated: false,
  handle: async () => { contextCalls += 1; return hangFirst && contextCalls === 1 ? never() : answer; },
}) as never;
const slowSend = (ms: number): ToolHandler<never, never, ToolDispatcherContext> => ({
  name: 'send_message', description: 'Queue a message.', schema: sendMessageArgsSchema as never, trigger_allowlist: allowed('send_message'), autonomy_gated: true,
  handle: () => later(ms, { ok: true as const, data: { queued: true }, source_taint: null }),
}) as never;
const slowDrive = (ms: number): ToolHandler<never, never, ToolDispatcherContext> => ({
  name: 'read_drive', description: 'Read a Drive file.', schema: readDriveArgsSchema as never, trigger_allowlist: allowed('read_drive'), autonomy_gated: false,
  handle: () => later(ms, { ...answer, source_taint: 'external' as const }),
}) as never;

beforeEach(() => { vi.useFakeTimers(); contextCalls = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('a read that does not answer', () => {
  it('is given up at the read timeout with a recoverable error that names another route', async () => {
    const pending = dispatchTool({ id: 'c1', name: 'get_context', args: {} }, ctx(), { handlers: [contextRead(true)] });
    await vi.advanceTimersByTimeAsync(READ_TOOL_TIMEOUT_MS);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: 'timed_out', code: 'transient', retryable: true });
    expect((result as { error: string }).error).toContain('did not answer');
    expect((result as { fix: string }).fix).toContain('another way');
  });

  it('leaves the turn running: the model hears the timeout, the same read runs again uncached, and the turn answers', async () => {
    const outputs: string[] = [];
    let round = 0;
    const done = runToolLoop({
      handlers: [contextRead(true)] as never, ctx: ctx(), maxSteps: 10, onTool: (event) => outputs.push(event.output),
      step: async (tools) => {
        round += 1;
        return tools && round <= 2 ? { text: '', tool_calls: [{ call_id: `c${round}`, name: 'get_context', arguments: '{}' }] } : { text: 'answered.' };
      },
    });
    await vi.advanceTimersByTimeAsync(READ_TOOL_TIMEOUT_MS + 1_000);
    expect(await done).toBe('answered.');
    expect(contextCalls).toBe(2);
    expect(outputs[0]).toContain('timed_out');
    expect(outputs[1]).not.toContain('no new tool execution');
    expect(outputs[1]).toContain('synthetic');
  });

  it('never cuts a write: a slow send runs to its own end', async () => {
    const args = { channel: 'telegram', content: 'hi', idempotency_key: 'c'.repeat(64) };
    const pending = dispatchTool({ id: 'w1', name: 'send_message', args }, ctx(), { handlers: [slowSend(READ_TOOL_TIMEOUT_MS * 2)] });
    await vi.advanceTimersByTimeAsync(READ_TOOL_TIMEOUT_MS * 2);
    expect(await pending).toMatchObject({ ok: true });
  });

  it('gives a long read the time the turn has, not the short limit, and cuts it at the turn\'s tool deadline', async () => {
    const roomy = dispatchTool({ id: 'l1', name: 'read_drive', args: DRIVE_ARGS }, ctx(), { handlers: [slowDrive(READ_TOOL_TIMEOUT_MS * 2)], toolDeadline: Date.now() + READ_TOOL_TIMEOUT_MS * 3 });
    await vi.advanceTimersByTimeAsync(READ_TOOL_TIMEOUT_MS * 2);
    expect(await roomy).toMatchObject({ ok: true });

    const tight = dispatchTool({ id: 'l2', name: 'read_drive', args: DRIVE_ARGS }, ctx(), { handlers: [slowDrive(READ_TOOL_TIMEOUT_MS * 2)], toolDeadline: Date.now() + READ_TOOL_TIMEOUT_MS + 5_000 });
    await vi.advanceTimersByTimeAsync(READ_TOOL_TIMEOUT_MS + 5_000);
    expect(await tight).toMatchObject({ ok: false, reason: 'timed_out', retryable: true });
  });

  it('cuts a short read at the turn\'s tool deadline when that comes first', async () => {
    const pending = dispatchTool({ id: 'c2', name: 'get_context', args: {} }, ctx(), { handlers: [contextRead(true)], toolDeadline: Date.now() + 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, reason: 'timed_out' });
  });

  it('a read that throws after it was given up does not surface as an unhandled rejection', async () => {
    const rejecting = { ...contextRead(false), handle: () => later(READ_TOOL_TIMEOUT_MS * 2, null).then(() => { throw new Error('late'); }) } as never;
    const pending = dispatchTool({ id: 'c3', name: 'get_context', args: {} }, ctx(), { handlers: [rejecting] });
    await vi.advanceTimersByTimeAsync(READ_TOOL_TIMEOUT_MS * 2);
    expect(await pending).toMatchObject({ ok: false, reason: 'timed_out' });
  });
});
