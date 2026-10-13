import { buildSessionState } from '@waldo/contracts';
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
it.each(actions)('admits owner $action through production hooks without chat approval', async args => {
  const request = vi.fn(async () => ({ accepted: true as const, command_id: 'command_fixture', state: 'queued', duplicate: false }));
  const result = await dispatchTool({ id: args.action, name: 'use_mac', args }, context(), { handlers: [useMacHandler({ request })] });
  expect(result).toMatchObject({ ok: true, data: { request_id: expect.any(String), status: 'sent to your Mac for approval' } });
  expect(request).toHaveBeenCalledTimes(1);
});
it('rejects external content before any Mac request', async () => {
  const request = vi.fn();
  const result = await dispatchTool({ id: 'taint_fixture', name: 'use_mac', args: actions[0] }, { ...context(), toolArgSourceTaint: 'external' }, { handlers: [useMacHandler({ request })] });
  expect(result.ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it('ends the owner turn after the first request and skips later calls in the batch', async () => {
  const request = vi.fn(async () => ({ accepted: true as const, command_id: 'command_fixture', state: 'queued', duplicate: false }));
  const step = vi.fn(async () => ({ text: '', tool_calls: [{ call_id: 'first', name: 'use_mac', arguments: JSON.stringify(actions[0]) }, { call_id: 'second', name: 'use_mac', arguments: JSON.stringify(actions[1]) }] }));
  const text = await runToolLoop({ handlers: [useMacHandler({ request })], ctx: context(), step, maxSteps: 2 });
  expect(text).toContain('Sent to your Mac for approval. Request:');
  expect(step).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
});
