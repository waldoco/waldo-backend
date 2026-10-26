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
// A server that signs Waldo in without a registered client (a client metadata document or open dynamic registration)
// needs nothing else. One that accepts only clients registered with the vendor by hand is pre_registered: the operator
// registers Waldo there once per environment and seeds the client into the oauth-proxy edge, which holds its secret.
import { GRANOLA_AUTH_ORIGIN, GRANOLA_MCP_URL, isReviewedGranola } from './granola-mcp';
import type { ClientPins } from './mcp-oauth';

export type McpCatalogueEntry = Readonly<{
  id: string;
  label: string;
  // What Waldo can reach there, in the console's words. The tile adds what sends as the owner and what runs without asking.
  about: string;
  url: string;
  issuer: string;
  // Signs in only with the client seeded into the edge for this issuer (docs/ops/PRE_REGISTERED_OAUTH_CLIENTS.md).
  pre_registered?: true;
  // The scopes Waldo asks for, in place of whatever the server's challenge or metadata offers (offline_access is added
  // only when the authorization server lists it). A pre-registered app lists the same scopes, and the vendor refuses a
  // request for any it does not.
  scopes?: readonly string[];
  // How the vendor's token endpoint answers, pinned with the connection for the edge.
  token_dialect?: ClientPins['token_dialect'];
  // Its writes speak as the owner to other people. Only the tools named in reads are reads, whatever the server labels
  // them; every other tool is a send. A send the owner allowed runs without a card only in their own untainted turns, and
  // every send that runs is kept for Patrol's access log with where it went (the argument named in send_target), never
  // what it said.
  sends_as_owner?: true;
  reads?: readonly string[];
  send_target?: readonly string[];
}>;

export const MCP_CATALOGUE: readonly McpCatalogueEntry[] = [
  { id: 'granola', label: 'Granola', about: 'Read your meeting notes and transcripts. Waldo never changes anything in Granola.', url: GRANOLA_MCP_URL, issuer: GRANOLA_AUTH_ORIGIN },
  { id: 'notion', label: 'Notion', about: 'Search and read your pages and databases.', url: 'https://mcp.notion.com/mcp', issuer: 'https://mcp.notion.com' },
  { id: 'todoist', label: 'Todoist', about: 'Find and read your tasks and projects.', url: 'https://ai.todoist.net/mcp', issuer: 'https://todoist.com' },
  { id: 'linear', label: 'Linear', about: 'Find and read issues, projects and comments.', url: 'https://mcp.linear.app/mcp', issuer: 'https://mcp.linear.app' },
  {
    id: 'slack', label: 'Slack', url: 'https://mcp.slack.com/mcp', issuer: 'https://mcp.slack.com', pre_registered: true, token_dialect: 'ok_envelope', sends_as_owner: true,
    about: 'Search messages and read channels and threads.',
    // Slack's read tools by name. Slack's documentation describes its tools by what they do, not by name, so a name here
    // that Slack does not use only means that tool is treated as a send.
    reads: ['slack_search_public', 'slack_search_public_and_private', 'slack_search_channels', 'slack_search_users', 'slack_read_channel', 'slack_read_thread', 'slack_read_canvas', 'slack_read_user_profile'],
    send_target: ['channel_id', 'channel'],
    scopes: ['search:read.public', 'search:read.private', 'search:read.im', 'search:read.mpim', 'search:read.users', 'channels:history', 'groups:history', 'im:history', 'mpim:history', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read', 'chat:write'],
  },
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
const SENDS_AS_OWNER = 'Messages Waldo sends go out as you, so sending asks you first unless you allow it in Connections, and even then a message or page from outside never sends one without your card. Every send is listed in Patrol.';
const ALLOWED_UNTIL_CHANGED = 'run without asking when you ask Waldo yourself; anything else, or anything a message or page from outside prompts, asks you first. You can change this after connecting, and disconnecting then connecting here again allows them again.';
const tileConsent = (entry: McpCatalogueEntry): string | null => {
  if (isReviewedGranola(entry.url, entry.issuer)) return null;
  // Slack's reads are the ones Waldo names, not the ones Slack labels.
  const runs = entry.reads ? `Connecting here lets the ${entry.label} reads Waldo knows ${ALLOWED_UNTIL_CHANGED}` : `Connecting here lets the tools ${entry.label} labels read-only ${ALLOWED_UNTIL_CHANGED}`;
  return entry.sends_as_owner ? `${SENDS_AS_OWNER} ${runs}` : runs;
};
export const catalogueTiles = (connected: readonly Readonly<{ server_url: string }>[]): readonly McpCatalogueTile[] =>
  MCP_CATALOGUE.map((entry) => {
    const consent = tileConsent(entry);
    return { id: entry.id, label: entry.label, about: consent === null ? entry.about : `${entry.about} ${consent}`, consent, url: entry.url, connected: connected.some((server) => same(server.server_url, entry.url)) };
  });
