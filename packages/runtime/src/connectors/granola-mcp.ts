// Granola's hosted MCP server, reviewed for Waldo. Waldo reads the owner's meeting notes through it and
// never changes anything there: switch_workspace moves the owner's own Granola app to another workspace,
// sign_out ends Waldo's access, and folder edits change their notes. Any MCP server on a Granola host is
// governed by this list, whichever way it was connected: other tools are never offered, and a call to one
// is refused before the network.
export const GRANOLA_MCP_URL = 'https://mcp.granola.ai/mcp';
// Where Granola's sign-in happens; the connect page names it before the owner continues.
export const GRANOLA_AUTH_ORIGIN = 'https://mcp-auth.granola.ai';

// Screenshots (get_meeting_attachment) stay out until image results have their own review.
export const GRANOLA_READ_TOOLS: readonly string[] = ['get_account_info', 'list_meetings', 'list_meeting_folders', 'get_meetings', 'get_meeting_transcript', 'query_granola_meetings'];

export const isGranolaHost = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (parsed.hostname === 'granola.ai' || parsed.hostname.endsWith('.granola.ai'));
  } catch {
    return false;
  }
};

export const isGranolaRead = (tool: string): boolean => GRANOLA_READ_TOOLS.includes(tool);
