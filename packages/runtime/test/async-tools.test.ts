import { expect, it } from 'vitest';
import { asyncToolsEnabled, lightChatEnabled, OWNER_TURN_LONG_TOOLS } from '../src/channels/async-tools';
import { messagingSystemPrompt } from '../src/prompt/messaging-behavior';
import { TASK_PROFILE_SPECS } from '../src/tasks/profiles';

// The owner's chat turn as a router (docs/proposals/WALDO_ASYNC_TOOLS_DESIGN_2026-11-04.md): which tools leave it, what its
// prompt says instead, and that the switches are off unless they say "1".

it('the long tools are the browser, Drive reads and the research subagent, each still held by a task worker', () => {
  expect([...OWNER_TURN_LONG_TOOLS].sort()).toEqual(['browse_act', 'browse_page', 'delegate_task', 'read_drive']);
  const workerTools = new Set([...TASK_PROFILE_SPECS.reader.tools, ...TASK_PROFILE_SPECS.errand.tools]);
  // delegate_task is replaced by start_task itself; every other long tool is the worker's.
  for (const tool of OWNER_TURN_LONG_TOOLS) if (tool !== 'delegate_task') expect(workerTools.has(tool as never), tool).toBe(true);
});

it('the switches are on only for "1"', () => {
  for (const value of [undefined, '', '0', 'on', 'true']) {
    expect(asyncToolsEnabled({ WALDO_ASYNC_TOOLS: value })).toBe(false);
    expect(lightChatEnabled({ WALDO_LIGHT_CHAT: value })).toBe(false);
  }
  expect(asyncToolsEnabled({ WALDO_ASYNC_TOOLS: '1' })).toBe(true);
  expect(lightChatEnabled({ WALDO_LIGHT_CHAT: '1' })).toBe(true);
});

const ROUTER = ['get_context', 'web_search', 'search_communication', 'start_task', 'cancel_task'];
const FULL = [...ROUTER, 'browse_page', 'browse_act', 'read_drive'];

// The file snapshot was written by beta-mvp's prompt (b06146cc), before the background block existed, so switch-off is
// held to those bytes, not to itself. A deliberate prompt change rewrites it with -u.
it('off, the prompt is the bytes it was before the switch existed', async () => {
  await expect(messagingSystemPrompt(FULL, undefined, 'harness', undefined, false)).toMatchFileSnapshot('__snapshots__/async-tools-off-harness.txt');
  await expect(messagingSystemPrompt(ROUTER, undefined, false, undefined, false)).toMatchFileSnapshot('__snapshots__/async-tools-off-router.txt');
});

it('on, the ladder climbs to a background task and says what to tell the owner', () => {
  const router = messagingSystemPrompt(ROUTER, undefined, false, undefined, true);
  expect(router).toContain('mail, web_search, a background task, their Mac last.');
  expect(router).toContain('call start_task with a brief that holds everything its worker needs');
  expect(router).toContain('say in this reply what you started');
  expect(router).not.toContain('browse_page, or browse_act');
  expect(router).not.toContain('open its page with browse_page');
  expect(messagingSystemPrompt(FULL)).not.toContain('Background work');
});
