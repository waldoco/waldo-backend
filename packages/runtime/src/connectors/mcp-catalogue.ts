// Official remote MCP servers the console offers to connect in one click. Each entry is the vendor's own server address
// and the authorization server that address names in its protected-resource metadata. Both are pinned: a server is the
// catalogue's only when the owner connected that exact address and signed in at that exact issuer, so a look-alike host
// or a server that moved its sign-in elsewhere is an ordinary owner-added server.
//
// When the owner connects a catalogue server from its console tile, the tools the vendor labels read-only are allowed to
// run without asking on that first link (typing the same address into the connect form allows nothing), each
// at the definition digest it had then, and only in the owner's own turns that read nothing from outside; a changed
// definition asks first again. Every other tool asks first until the
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
  { id: 'granola', label: 'Granola', about: 'Read your meeting notes and transcripts. Waldo never changes anything in Granola.', url: GRANOLA_MCP_URL, issuer: GRANOLA_AUTH_ORIGIN },
  { id: 'notion', label: 'Notion', about: 'Search and read your pages and databases.', url: 'https://mcp.notion.com/mcp', issuer: 'https://mcp.notion.com' },
  { id: 'todoist', label: 'Todoist', about: 'Find and read your tasks and projects.', url: 'https://ai.todoist.net/mcp', issuer: 'https://todoist.com' },
  { id: 'linear', label: 'Linear', about: 'Find and read issues, projects and comments.', url: 'https://mcp.linear.app/mcp', issuer: 'https://mcp.linear.app' },
];

const same = (a: string, b: string) => {
  try { return new URL(a).toString() === new URL(b).toString(); } catch { return false; }
};

// An issuer differs from the pinned one by at most a trailing slash; anything else is another sign-in service.
const sameIssuer = (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, '');

export const catalogueEntry = (serverUrl: string, issuer: string | null): McpCatalogueEntry | undefined =>
  issuer === null ? undefined : MCP_CATALOGUE.find((entry) => same(entry.url, serverUrl) && sameIssuer(entry.issuer, issuer));

// The entry a tile's connect click names, when it is the server being connected.
export const tileTarget = (id: string, serverUrl: string): McpCatalogueEntry | undefined =>
  MCP_CATALOGUE.find((entry) => entry.id === id && same(entry.url, serverUrl));

// The catalogue as the console shows it, before the owner connects: the tile says what will run without asking, since
// connecting is the owner's consent to it. connected means the owner has a server at that address, whatever its sign-in.
// about is the whole tile text and ends with consent; consent is also sent on its own (null when connecting grants
// nothing) so the console keeps it in view beside the Connect button.
export type McpCatalogueTile = Readonly<{ id: string; label: string; about: string; consent: string | null; url: string; connected: boolean }>;
const tileConsent = (entry: McpCatalogueEntry): string | null => isReviewedGranola(entry.url, entry.issuer) ? null
  : `Connecting here lets the tools ${entry.label} labels read-only run without asking when you ask Waldo yourself; anything else, or anything a message or page from outside prompts, asks you first. You can change this after connecting, and disconnecting then connecting here again allows them again.`;
export const catalogueTiles = (connected: readonly Readonly<{ server_url: string }>[]): readonly McpCatalogueTile[] =>
  MCP_CATALOGUE.map((entry) => {
    const consent = tileConsent(entry);
    return { id: entry.id, label: entry.label, about: consent === null ? entry.about : `${entry.about} ${consent}`, consent, url: entry.url, connected: connected.some((server) => same(server.server_url, entry.url)) };
  });
