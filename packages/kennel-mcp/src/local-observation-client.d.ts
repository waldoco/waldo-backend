import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

declare module '@modelcontextprotocol/sdk/client/index.js' {
  interface Client {
    // This local server exposes no task-capable tools, so the console's calls resolve directly.
    callTool(params: unknown): Promise<CallToolResult>;
  }
}
