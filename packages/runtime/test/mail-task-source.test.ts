import { expect, it, vi } from 'vitest';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';
import { taskSourceAllowed, taskSourceMissing, taskSourceRequired, type TaskSourceSnapshot } from '../src/channels/task-source-scope';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-07T00:00:00Z') };
const snapshot = (sources: TaskSourceSnapshot['sources'], ready = true, defaults?: TaskSourceSnapshot['defaults']): TaskSourceSnapshot => ({ taskId: 'synthetic-mail-task', revision: 1, sources, ready, startRef: null, defaults });

it('admits real mail read/draft/propose handlers under a settled mail-only task without adding other families', async () => {
  const features: unknown[] = [];
  const draft = vi.fn(async () => ({ draft_id: 'synthetic-draft', message_id: 'synthetic-message', thread_id: 'synthetic-thread' }));
  const proposeSendEmail = vi.fn(async () => 'synthetic-proposal');
  const google: GoogleAccess = { client: async feature => { features.push(feature); return { draft } as never; } };
  const handlers = googleHandlers(google, { propose: async () => 'unused', proposeSendEmail, record() {} }, clock);
  const task = snapshot(['mail']);
  for (const name of ['get_communication', 'search_communication', 'read_thread', 'draft_email', 'send_email']) {
    const handler = handlers.find(tool => tool.name === name)!;
    expect(taskSourceRequired(handler), name).toBe(true);
    expect(taskSourceAllowed(task, handler), name).toBe(true);
    expect(taskSourceMissing(task, handler), name).toEqual([]);
  }
  const args = { to: ['synthetic@example.test'], subject: 'Synthetic scope test', body_markdown: 'Synthetic body' };
  const ctx = { authenticatedUserId: 'synthetic-owner', turnId: 'synthetic-turn', toolCallId: 'synthetic-draft-call' } as ToolDispatcherContext;
  const draftHandler = handlers.find(tool => tool.name === 'draft_email')!;
  const sendHandler = handlers.find(tool => tool.name === 'send_email')!;
  expect(await draftHandler.handle(args as never, ctx)).toMatchObject({ ok: true, data: { sent: false } });
  expect(await sendHandler.handle(args as never, ctx)).toMatchObject({ ok: true, data: { proposal_id: 'synthetic-proposal', sent: false } });
  expect(features).toEqual(['mail', 'mail']);
  expect(draft).toHaveBeenCalledTimes(1);
  expect(proposeSendEmail).toHaveBeenCalledTimes(1);
  expect(task.sources).toEqual(['mail']);
});

it('does not admit mail writes under unresolved/default-only or non-mail tasks', () => {
  const handlers = googleHandlers({ client: async () => null }, { propose: async () => '', proposeSendEmail: async () => '', record() {} }, clock);
  for (const name of ['draft_email', 'send_email']) {
    const handler = handlers.find(tool => tool.name === name)!;
    for (const task of [snapshot([]), snapshot(['web']), snapshot(['mail'], false), snapshot([], false, ['mail'])]) {
      expect(taskSourceAllowed(task, handler), name).toBe(false);
      expect(taskSourceMissing(task, handler), name).toEqual(['mail']);
    }
  }
  expect(taskSourceAllowed(snapshot(['mail']), { name: 'query_calendar', requires_connector: true })).toBe(false);
  expect(taskSourceAllowed(snapshot(['mail']), { name: 'skills_load', requires_connector: true })).toBe(false);
});
