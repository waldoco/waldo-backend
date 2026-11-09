import { buildSessionState } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool } from '../src/tools/dispatcher';
import { callMcpToolHandler, type McpDesk } from '../src/tools/live/mcp';

const SERVERS = JSON.stringify([{ name: 'drive', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google', requires: 'drive', allow_tools: ['search_files'] }]);
const context = () => ({
  authenticatedUserId: 'owner',
  trigger: 'user_message' as const,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
  hasApproval: () => true,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise,
});

// Live staging showed call_mcp_tool ending in transient:invalid_handler_result (trace id relayed by
// Codex, not seen by me). Root cause reproduced here: handler failures lacked the external source_taint
// the dispatcher requires for call_mcp_tool, so every failure was masked. These run the REAL dispatcher.
describe('call_mcp_tool through the real dispatcher', () => {
  it('desk path: a proposal result is a valid dispatched result', async () => {
    const desk: McpDesk = { proposeMcpCall: async () => 'p1' };
    const out = await dispatchTool({ id: 'mcp-desk', name: 'call_mcp_tool', args: { server: 'drive', tool: 'search_files', args: {} } }, context(), { handlers: [callMcpToolHandler(SERVERS, desk)] });
    expect(out).toMatchObject({ ok: true, source_taint: 'external' });
  });

  it('provider/transport failure keeps its real code instead of invalid_handler_result', async () => {
    const auth = { resolve: async () => ({ mode: 'proxy' as const, connection: 'c1' }), proxy: async () => { throw new Error('upstream boom'); } };
    const out = await dispatchTool({ id: 'mcp-boom', name: 'call_mcp_tool', args: { server: 'drive', tool: 'search_files', args: {} } }, context(), { handlers: [callMcpToolHandler(SERVERS, undefined, auth)] });
    expect(out).toMatchObject({ ok: false, code: 'transient', error: 'upstream boom' });
  });

  it('unknown server: a typed not_found failure, not invalid_handler_result', async () => {
    const out = await dispatchTool({ id: 'mcp-miss', name: 'call_mcp_tool', args: { server: 'nope', tool: 't', args: {} } }, context(), { handlers: [callMcpToolHandler(SERVERS)] });
    expect(out).toMatchObject({ ok: false, code: 'not_found' });
  });
});
