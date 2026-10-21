// Google's managed Workspace MCP servers (Developer Preview). Waldo reads through them and never
// writes: writes go through Waldo's typed Google tools, which carry the approval desk, exact preview,
// readback and receipt. Any MCP server on a Google host is governed by this list, so a write or
// unknown tool there is refused before auth, network or the desk. Shared with the connector-proxy edge.
import type { GoogleFeature } from './google.ts';

export type GoogleMcpServer = Readonly<{
  url: string;
  // The grant feature that must hold before a call: its scopes are what the server reads with.
  feature: GoogleFeature;
  read_tools: readonly string[];
  // Set by the host after the model's arguments, so the model cannot override them.
  fixed_args?: Readonly<Record<string, unknown>>;
}>;

export const GOOGLE_MCP_SERVERS: readonly GoogleMcpServer[] = [
  { url: 'https://gmailmcp.googleapis.com/mcp/v1', feature: 'mail', read_tools: ['search_threads', 'get_thread', 'get_message', 'list_drafts', 'get_draft', 'list_labels'] },
  { url: 'https://calendarmcp.googleapis.com/mcp/v1', feature: 'calendar', read_tools: ['list_events', 'get_event', 'list_calendars', 'search_events', 'suggest_time'] },
  // Metadata only: Drive file text goes through the typed Drive read. Without the flag, Google's list,
  // search and metadata tools return a generated snippet of the file body.
  { url: 'https://drivemcp.googleapis.com/mcp/v1', feature: 'drive', read_tools: ['list_recent_files', 'search_files', 'get_file_metadata'], fixed_args: { excludeContentSnippets: true } },
  { url: 'https://docsmcp.googleapis.com/mcp/v1', feature: 'docs', read_tools: ['read_doc'] },
  { url: 'https://sheetsmcp.googleapis.com/mcp/v1', feature: 'sheets', read_tools: ['get_spreadsheet', 'get_values'] },
  { url: 'https://slidesmcp.googleapis.com/mcp/v1', feature: 'slides', read_tools: ['read_presentation', 'read_slide_page'] },
];

// The fixed text the model reads when a Google MCP tool is refused or unavailable.
export const GOOGLE_MCP_READ_ONLY = 'google_mcp_read_only';
export const GOOGLE_MCP_UNAVAILABLE = 'google_mcp_unavailable';

export const isGoogleHost = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'googleapis.com' || parsed.hostname.endsWith('.googleapis.com'));
  } catch {
    return false;
  }
};

export const googleMcpServer = (url: string | undefined): GoogleMcpServer | undefined => GOOGLE_MCP_SERVERS.find((server) => server.url === url);

export const isGoogleMcpRead = (url: string | undefined, tool: string | undefined): boolean =>
  googleMcpServer(url)?.read_tools.includes(tool ?? '') ?? false;
