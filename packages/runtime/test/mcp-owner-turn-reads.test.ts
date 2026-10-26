import { describe, expect, it } from 'vitest';
import { readMcpToolHandler, searchMcpToolsHandler, type McpOwnerServers } from '../src/tools/live/mcp';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// What the MCP handlers tell the owner's servers about the turn: whether it is the owner's own, untainted turn, the only
// turn in which reads allowed on connect run without a card.
const recorder = () => {
  const seen: unknown[] = [];
  const owner: McpOwnerServers = {
    list: () => [{ name: 'notion', runs_without_asking: 1 } as ReturnType<McpOwnerServers['list']>[number]],
    search: async (input) => { seen.push(input.ownerTurn); return { tools: [], servers: [], failures: [] }; },
    invoke: async (input) => { seen.push('ownerTurn' in input ? input.ownerTurn : 'approved'); return { server: 'notion', result: {} }; },
    describe: async () => { throw new Error('not used'); },
    checkAnswers: async () => [],
  };
  return { owner, seen };
};
const ctx = (over: Partial<ToolDispatcherContext>): ToolDispatcherContext => ({ authenticatedUserId: 'owner-a', trigger: 'user_message', sourceTaint: null, toolArgSourceTaint: null, ownerInitiated: true, session: {} as ToolDispatcherContext['session'], ...over });
const args = { server: 'notion', tool: 'notion-search', args: { query: 'q' } };

describe('MCP reads and the owner\'s turn', () => {
  it('marks only an untainted turn the owner started as the owner\'s turn', async () => {
    const { owner, seen } = recorder();
    const read = readMcpToolHandler(undefined, undefined, false, owner), search = searchMcpToolsHandler(owner);
    const cases: Partial<ToolDispatcherContext>[] = [
      {},
      { toolArgSourceTaint: 'external' },
      { sourceTaint: 'external' },
      { ownerInitiated: false },
      { ownerInitiated: undefined },
      { trigger: 'reminder' as ToolDispatcherContext['trigger'] },
    ];
    for (const over of cases) { await read.handle(args, ctx(over)); await search.handle({ query: 'pages' }, ctx(over)); }
    expect(seen).toEqual([true, true, false, false, false, false, false, false, false, false, false, false]);
  });
});
