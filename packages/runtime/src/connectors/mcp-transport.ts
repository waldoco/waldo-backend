// Shared minimal MCP client over the Streamable HTTP transport (spec 2025-06-18): JSON-RPC POST
// with Accept: application/json + text/event-stream, initialize handshake, Mcp-Session-Id replay.
// No contract imports: the connector-proxy Edge Function shares this module so a Google bearer
// never leaves the edge (the runtime sends server/tool/args, the edge attaches the token).
// Compared against: the official MCP transport spec (fetched live) and @modelcontextprotocol/sdk
// (not bundled - Node-oriented surface we do not need; this client is behind an interface so the
// SDK can swap in without touching callers).
export class McpAuthError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'McpAuthError'; }
}
import { mcpErrorDiagnostic, type McpErrorDiagnostic } from './mcp-error-diagnostic.ts';
export class McpToolError extends Error {
  constructor(message: string, public readonly diagnostic?: McpErrorDiagnostic) { super(message); }
}

export type McpTransportServer = Readonly<{ url: string; token?: string }>;

type JsonRpc = { jsonrpc: '2.0'; id: number; method: string; params?: unknown };

// One tool call = initialize (capture any session id) -> initialized notification -> tools/call.
// bearer (dynamic OAuth token source) wins over the static deploy-config token when both exist.
// Results are opaque provider JSON; callers stamp them external-origin at the schema level.
export const callMcpTransport = async (server: McpTransportServer, tool: string, args: Record<string, unknown>, fetcher: typeof fetch = fetch, bearer?: () => Promise<string>): Promise<{ content: unknown; protocolVersion: string }> => {
  const headers = async (session: string | null): Promise<Record<string, string>> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(bearer ? { authorization: `Bearer ${await bearer()}` } : server.token ? { authorization: `Bearer ${server.token}` } : {}),
    ...(session ? { 'mcp-session-id': session } : {}),
  });
  let id = 0;
  const rpc = async (method: string, params: unknown, session: string | null, notify = false): Promise<{ response: Response; session: string | null }> => {
    const body: JsonRpc = { jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) };
    const response = await fetcher(server.url, {
      method: 'POST', headers: await headers(session), body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : body),
      signal: AbortSignal.timeout(30_000),
    });
    return { response, session: response.headers.get('mcp-session-id') ?? session };
  };
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'waldo', version: 'mvp' },
  }, null);
  if (init.response.status === 401 || init.response.status === 403) throw new McpAuthError(init.response.status, `mcp initialize ${init.response.status}`);
  if (!init.response.ok) throw new Error(`mcp initialize ${init.response.status}`);
  // Version negotiation (spec: server answers with the version it will use; revisions are
  // date-stamped, latest seen 2025-11-25). We speak the tools/call core unchanged across
  // revisions, so adopt whatever the server returns and carry it through for transparency.
  const initBody = JSON.parse(extractPayload(await init.response.text())) as { result?: { protocolVersion?: string } };
  const protocolVersion = initBody.result?.protocolVersion ?? '2025-06-18';
  const session = init.session;
  const notified = await rpc('notifications/initialized', undefined, session, true);
  if (!notified.response.ok && notified.response.status !== 202) throw new Error(`mcp initialized ${notified.response.status}`);
  const called = await rpc('tools/call', { name: tool, arguments: args }, session);
  if (called.response.status === 401 || called.response.status === 403) throw new McpAuthError(called.response.status, `mcp tools/call ${called.response.status}`);
  if (!called.response.ok) throw new Error(`mcp tools/call ${called.response.status}`);
  const parsed = JSON.parse(extractPayload(await called.response.text())) as { result?: { content?: unknown; isError?: boolean }; error?: { message?: string } };
  if (parsed.error) throw new Error(`mcp error: ${parsed.error.message ?? 'unknown'}`);
  const result = parsed.result ?? {};
  if (result.isError) throw new McpToolError(`mcp tool error: ${JSON.stringify(result.content).slice(0, 200)}`, mcpErrorDiagnostic(result));
  return { content: result.content ?? result, protocolVersion };
};

// Streamable HTTP may answer as SSE; take the last data: frame when so.
const extractPayload = (text: string): string =>
  text.startsWith('event:') || text.includes('\ndata:')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).pop() ?? ''
    : text;
