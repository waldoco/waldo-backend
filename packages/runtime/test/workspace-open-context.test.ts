import { expect, it } from 'vitest';
import { workspaceToolHandlers } from '../src/tools/live/workspace';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

it.each([
  ['workspace_list', {}],
  ['workspace_read', { file_id: 'abcdefab-cdef-4abc-8abc-abcdefabcdef', revision: 1 }],
  ['workspace_write', { path: 'scope.md', text: 'fixture', mime: 'text/markdown', expected_revision: 0 }],
] as const)('%s passes its exact invocation scope to the host open callback', async (name, args) => {
  const scope = { runId: 'run-a', attempt: 'attempt-a', deadline: Date.now() + 60_000, signal: new AbortController().signal,
    admit() {}, commit<T>(work: () => T) { return work(); },
  };
  const context = { authenticatedUserId: 'owner', turnId: 'turn-a', toolCallId: 'call-a', runScope: scope } as ToolDispatcherContext;
  const handlers = workspaceToolHandlers(async (received?: ToolDispatcherContext) => {
    expect(received).toBe(context);
    expect(received?.runScope).toBe(scope);
    throw new Error('fixture host stops after context capture');
  });
  const handler = handlers.find(h => h.name === name)!;
  await expect(handler.handle(args as never, context)).rejects.toThrow('fixture host stops after context capture');
});
