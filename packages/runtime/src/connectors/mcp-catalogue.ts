// Official remote MCP servers the console offers to connect in one click. Each entry is the vendor's own server address
// and the authorization server that address names in its protected-resource metadata. Both are pinned: a server is the
// catalogue's only when the owner connected that exact address and signed in at that exact issuer, so a look-alike host
// or a server that moved its sign-in elsewhere is an ordinary owner-added server.
//
// On the first link of a catalogue server, the tools the vendor labels read-only are allowed to run without asking, each
// at the definition digest it had then; a changed definition asks first again. Every other tool asks first until the
// owner allows it in Connections. Tool names and descriptions stay the server's own words, never Waldo's.
//
// Only servers that sign Waldo in without a registered client (a client metadata document or open dynamic registration)
// belong here, because the oauth-proxy edge holds no pre-registered clients for MCP servers.
import { GRANOLA_AUTH_ORIGIN, GRANOLA_MCP_URL, isReviewedGranola } from './granola-mcp';

export type McpCatalogueEntry = Readonly<{
  id: string;
  label: string;
  // What Waldo can reach there, in the console's words. The tile adds what runs without asking.
  about: string;
  url: string;
  issuer: string;
}>;

export const MCP_CATALOGUE: readonly McpCatalogueEntry[] = [
  { id: 'notion', label: 'Notion', about: 'Search and read your pages and databases.', url: 'https://mcp.notion.com/mcp', issuer: 'https://mcp.notion.com' },
  { id: 'linear', label: 'Linear', about: 'Find and read issues, projects and comments.', url: 'https://mcp.linear.app/mcp', issuer: 'https://mcp.linear.app' },
  { id: 'todoist', label: 'Todoist', about: 'Find and read your tasks and projects.', url: 'https://ai.todoist.net/mcp', issuer: 'https://todoist.com' },
  { id: 'granola', label: 'Granola', about: 'Read your meeting notes and transcripts. Waldo never changes anything in Granola.', url: GRANOLA_MCP_URL, issuer: GRANOLA_AUTH_ORIGIN },
  { id: 'sentry', label: 'Sentry', about: 'Search errors, issues and traces in your projects.', url: 'https://mcp.sentry.dev/mcp', issuer: 'https://mcp.sentry.dev' },
];

const same = (a: string, b: string) => {
  try { return new URL(a).toString() === new URL(b).toString(); } catch { return false; }
};

export const catalogueEntry = (serverUrl: string, issuer: string | null): McpCatalogueEntry | undefined =>
  issuer === null ? undefined : MCP_CATALOGUE.find((entry) => same(entry.url, serverUrl) && entry.issuer === issuer);

// The catalogue as the console shows it, before the owner connects: the tile says what will run without asking, since
// connecting is the owner's consent to it. connected means the owner has a server at that address, whatever its sign-in.
export type McpCatalogueTile = Readonly<{ id: string; label: string; about: string; url: string; connected: boolean }>;
const tileAbout = (entry: McpCatalogueEntry) => isReviewedGranola(entry.url, entry.issuer) ? entry.about
  : `${entry.about} Tools ${entry.label} labels read-only will run without asking; anything else asks you first. You can change this after connecting.`;
export const catalogueTiles = (connected: readonly Readonly<{ server_url: string }>[]): readonly McpCatalogueTile[] =>
  MCP_CATALOGUE.map((entry) => ({ id: entry.id, label: entry.label, about: tileAbout(entry), url: entry.url, connected: connected.some((server) => same(server.server_url, entry.url)) }));
