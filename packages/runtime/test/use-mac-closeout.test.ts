import { RUNG_BLOCKED_FIX, buildSessionState } from '@waldo/contracts';
import { expect, it, vi } from 'vitest';
import { runToolLoop } from '../src/conversation/tool-loop';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { useMacHandler } from '../src/tools/live/use-mac';

const context = (): ToolDispatcherContext => ({
  authenticatedUserId: 'owner_fixture', trigger: 'user_message', ownerInitiated: true,
  turnId: 'closeout_fixture', sourceTaint: null, toolArgSourceTaint: null,
  hasApproval: () => false, sanitise,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1'.repeat(16), '2'.repeat(16), '3'.repeat(16)], started_at: Date.now() }),
});
const common = { project: 'fixture', reason: 'Local acceptance check' };
const actions = [
  { ...common, action: 'run_command', command: 'printf acceptance' },
  { ...common, action: 'list_sessions' },
  { ...common, action: 'read_session', session_id: 'session_fixture' },
  { ...common, action: 'start_session', agent: 'codex', prompt: 'Describe this project' },
  { ...common, action: 'message_session', session_id: 'session_fixture', prompt: 'Report status' },
  { ...common, action: 'interrupt_session', session_id: 'session_fixture' },
  { ...common, action: 'stop_session', session_id: 'session_fixture' },
];
// Commands, starts, messages and stops raise a native approval dialog on the Mac; queries and interrupts do not.
const approvalActions = new Set(['run_command', 'start_session', 'message_session', 'stop_session']);
const sent = vi.fn(async () => ({ accepted: true as const, command_id: 'command_fixture', state: 'sent', duplicate: false }));
it.each(actions)('admits owner $action through production hooks without chat approval', async args => {
  sent.mockClear();
  const result = await dispatchTool({ id: args.action, name: 'use_mac', args }, context(), { handlers: [useMacHandler({ request: sent })] });
  expect(result).toMatchObject({ ok: true, data: { request_id: expect.any(String), status: approvalActions.has(args.action) ? 'Sent to your Mac for approval.' : 'Sent to your Mac.' } });
  expect(sent).toHaveBeenCalledTimes(1);
});
it.each(actions)('says $action is queued, not sent, when the Mac has not taken it yet', async args => {
  const request = vi.fn(async () => ({ accepted: true as const, command_id: 'command_fixture', state: 'queued', duplicate: false }));
  const result = await dispatchTool({ id: args.action, name: 'use_mac', args }, context(), { handlers: [useMacHandler({ request })] });
  expect(result).toMatchObject({ ok: true, data: { status: expect.stringMatching(/^Queued for your Mac\./) } });
  expect(JSON.stringify(result)).not.toMatch(/Sent to/);
});
it.each(actions)('refuses $action with a device_offline block when the Mac is not connected, claiming nothing was sent', async args => {
  const request = vi.fn(async () => ({ accepted: false as const, reason: 'offline' as const }));
  const result = await dispatchTool({ id: args.action, name: 'use_mac', args }, context(), { handlers: [useMacHandler({ request })] });
  expect(result).toMatchObject({ ok: false, error_code: 'rejected', blocked: 'device_offline', retryable: false, fix: RUNG_BLOCKED_FIX.device_offline });
  expect(JSON.stringify(result)).not.toMatch(/sent to your Mac/i);
});
it('an offline Mac does not end the turn with a sent notice: the model answers from the block', async () => {
  const request = vi.fn(async () => ({ accepted: false as const, reason: 'offline' as const }));
  const replies = [{ text: '', tool_calls: [{ call_id: 'first', name: 'use_mac', arguments: JSON.stringify(actions[0]) }] }, { text: 'Your Mac looks asleep, so I sent nothing. Wake it and tell me.' }];
  const step = vi.fn(async () => replies.shift()!);
  const text = await runToolLoop({ handlers: [useMacHandler({ request })], ctx: context(), step, maxSteps: 3 });
  expect(text).toBe('Your Mac looks asleep, so I sent nothing. Wake it and tell me.');
  expect(step).toHaveBeenCalledTimes(2);
});
it.each([
  ['an approval request the Mac took', actions[0], 'sent', 'Sent to your Mac for approval. Request:'],
  ['a query the Mac took', actions[1], 'sent', 'Sent to your Mac. Request:'],
  ['a request still waiting for the Mac', actions[0], 'queued', 'Queued for your Mac.'],
] as const)('ends the owner turn with the honest notice for %s', async (_label, args, state, notice) => {
  const request = vi.fn(async () => ({ accepted: true as const, command_id: 'command_fixture', state, duplicate: false }));
  const step = vi.fn(async () => ({ text: '', tool_calls: [{ call_id: 'first', name: 'use_mac', arguments: JSON.stringify(args) }] }));
  const text = await runToolLoop({ handlers: [useMacHandler({ request })], ctx: context(), step, maxSteps: 2 });
  expect(text.startsWith(notice)).toBe(true);
  expect(text).toMatch(/Request: [0-9a-f]{64}$/);
});
it('rejects external content before any Mac request', async () => {
  const request = vi.fn();
  const result = await dispatchTool({ id: 'taint_fixture', name: 'use_mac', args: actions[0] }, { ...context(), toolArgSourceTaint: 'external' }, { handlers: [useMacHandler({ request })] });
  expect(result.ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it('ends the owner turn after the first request and skips later calls in the batch', async () => {
  const request = vi.fn(async () => ({ accepted: true as const, command_id: 'command_fixture', state: 'sent', duplicate: false }));
  const step = vi.fn(async () => ({ text: '', tool_calls: [{ call_id: 'first', name: 'use_mac', arguments: JSON.stringify(actions[0]) }, { call_id: 'second', name: 'use_mac', arguments: JSON.stringify(actions[1]) }] }));
  const text = await runToolLoop({ handlers: [useMacHandler({ request })], ctx: context(), step, maxSteps: 2 });
  expect(text).toContain('Sent to your Mac for approval. Request:');
  expect(step).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
});
