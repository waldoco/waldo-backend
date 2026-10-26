// Connecting a catalogue app from chat. The owner asks in their own words; the connect_app tool has the host start that app's
// sign-in at once (discovery and registration run now, never when a link unfurler or the owner's browser first loads the
// link) and send a first-party /c/<ticket> link to the chat the turn came from. The link's hop shows whose Waldo the account
// joins, what connecting allows and where Continue goes, and spends the ticket on Continue; the provider's callback is
// accepted only in the browser that pressed it. When the attempt settles, a fixed line goes back to the same conversation.
//
// A forwarded link is a bearer link until the owner uses it: whoever presses Continue first connects their account to the
// owner's Waldo, which the hop warns about by naming the owner. Once Continue ran, or 15 minutes after the link was sent, the
// link starts nothing anywhere. No owner id, code or secret travels in the link.
//
// Where the app's sign-in service advertises a device code (RFC 8628) and Waldo signs in there as a public client, the owner
// can ask for a code instead: the chat gets the user code and where to enter it, the owner object polls the provider through
// the edge on its scheduler, and the same line goes back when it settles. A code someone else enters connects their account,
// as a forwarded link would; it lives only as long as the provider allows (at most 30 minutes) and is sent only to the owner's
// own turn. Where no device code is advertised, none is offered.
//
// The app's Connections tile starts the same sign-in with a link that carries the app's one-time handoff code. That sign-in
// tells no chat when it settles: its callback sends the app's sign-in sheet back to the app, which reads the tile again.
import type { ConnectAppResult } from '@waldo/contracts';
import { catalogueTiles, MCP_CATALOGUE, type McpCatalogueEntry } from '../connectors/mcp-catalogue';
import { MCP_ATTEMPT_TTL_MS, MCP_START_PATH, type BeginResult, type ConnectOutcome, type DevicePollResult, type McpStatus } from '../connectors/mcp-connections';
import type { ConnectAppSend, ConnectAppTurn } from '../tools/live/connect-app';
import type { AppLinkBook, ConsoleLinkRoute } from './console-link';
import type { TurnLogEntry } from './owner-turn-types';

// A ticket's provider names the catalogue app it connects, so issuing a link for one app revokes only that app's earlier link.
const APP_PROVIDER = /^mcp:([a-z][a-z0-9-]{1,31})$/;
export const appConnectProvider = (entry: McpCatalogueEntry): string => `mcp:${entry.id}`;
export const appConnectEntry = (provider: string | undefined): McpCatalogueEntry | undefined => {
  const id = provider?.match(APP_PROVIDER)?.[1];
  return id === undefined ? undefined : MCP_CATALOGUE.find((entry) => entry.id === id);
};

export const CONNECT_APP_LINKS: AppLinkBook = { key: 'app_connect_links_v1', ttlMs: MCP_ATTEMPT_TTL_MS, gone: 'Connect link: expired or used. Ask me for a new one.' };
export const connectAppLinkText = (label: string, link: string): string => `Connect ${label} (the link works once, for 15 minutes): ${link}`;
export const connectAppCodeText = (label: string, where: string, code: string, minutes: number): string =>
  `Connect ${label}: open ${where} and enter the code ${code}. It works for ${minutes} minutes.`;

export type ConnectAppChannel = 'telegram' | 'app' | 'imessage' | 'whatsapp';
// tile: started from the app's Connections tile, so it returns to the app instead of telling a chat.
type Pending = Readonly<{ nonce: string; connector: string; channel: ConnectAppChannel; thread?: string; tile?: true; at: number }>;
const RECORD = 'connect_app:';
// The key the MCP callback reads to close a ticket once its sign-in settles (owner-do completeConnectTicket).
const BY_NONCE = 'connect_mcp_ticket:';
// A device-code attempt, by its nonce: no ticket exists for it. polls counts the scheduled polls, so each has its own id.
const DEVICE = 'connect_app_device:';
type DeviceRecord = Readonly<{ connector: string; channel: ConnectAppChannel; thread?: string; at: number; polls: number }>;
const KEEP_MS = 24 * 60 * 60_000;

export type Issued = Readonly<{ kind: 'link'; url: string } | { kind: 'code'; userCode: string; verificationUri: string; minutes: number } | { kind: 'already' } | { kind: 'refused'; reason: 'unavailable' | 'sign_in_failed' | 'code_unavailable' }>;
// Failures that mean this Waldo cannot start a sign-in at all, as opposed to the app's sign-in service failing.
const UNAVAILABLE: ReadonlySet<string> = new Set(['oauth_unavailable', 'origin_unknown']);

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown; list<T>(options: Readonly<{ prefix: string }>): Iterable<[string, T]> }>;

export const appConnects = (deps: Readonly<{
  kv: Kv;
  begin(entry: McpCatalogueEntry, how: 'browser' | 'device'): Promise<BeginResult>;
  pollDevice(nonce: string): Promise<DevicePollResult>;
  // Arms one poll of a device-code attempt, under its own schedule id.
  schedulePoll(id: string, nonce: string, at: number): Promise<void>;
  attemptTarget(nonce: string): Readonly<{ origin: string; expires: number }> | null;
  start(nonce: string): Promise<string | null>;
  issueTicket(provider: string, channel: ConnectAppChannel, handoff: boolean): Promise<Readonly<{ url: string; hash: string }> | null>;
  now(): number;
}>) => {
  const { kv } = deps;
  const pending = (hash: string) => kv.get<Pending>(`${RECORD}${hash}`);
  const sweep = () => {
    for (const [key, entry] of kv.list<Pending>({ prefix: RECORD })) if (deps.now() - entry.at > KEEP_MS) { kv.delete(key); kv.delete(`${BY_NONCE}${entry.nonce}`); }
    for (const [key, entry] of kv.list<DeviceRecord>({ prefix: DEVICE })) if (deps.now() - entry.at > KEEP_MS) kv.delete(key);
  };
  const arm = async (nonce: string, record: DeviceRecord, at: number) => {
    kv.put(`${DEVICE}${nonce}`, { ...record, polls: record.polls + 1 } satisfies DeviceRecord);
    await deps.schedulePoll(`connect-poll:${nonce}:${record.polls + 1}`, nonce, at);
  };
  return {
    // Starts the app's sign-in and issues its link, or with code its device code. Nothing is kept for a sign-in that could not
    // start.
    async issue(entry: McpCatalogueEntry, channel: ConnectAppChannel, thread?: string, method: 'link' | 'code' = 'link', from: 'chat' | 'tile' = 'chat'): Promise<Issued> {
      const begun = await deps.begin(entry, method === 'code' ? 'device' : 'browser');
      if (begun.kind === 'already' || begun.kind === 'connected') return { kind: 'already' };
      if (begun.kind === 'failed') return { kind: 'refused', reason: begun.reason === 'device_unsupported' ? 'code_unavailable' : UNAVAILABLE.has(begun.reason) ? 'unavailable' : 'sign_in_failed' };
      if (begun.kind === 'device') {
        sweep();
        const at = deps.now();
        await arm(begun.nonce, { connector: entry.id, channel, ...(thread ? { thread } : {}), at, polls: 0 }, at + 5_000);
        // Rounded: the expiry was fixed when the sign-in began, a few milliseconds before this clock read.
        return { kind: 'code', userCode: begun.user_code, verificationUri: begun.verification_uri, minutes: Math.max(1, Math.round((begun.expires - at) / 60_000)) };
      }
      const nonce = begun.path.slice(MCP_START_PATH.length);
      const ticket = await deps.issueTicket(appConnectProvider(entry), channel, from === 'tile');
      if (!ticket) return { kind: 'refused', reason: 'unavailable' };
      sweep();
      const at = deps.now();
      kv.put(`${RECORD}${ticket.hash}`, { nonce, connector: entry.id, channel, ...(thread ? { thread } : {}), ...(from === 'tile' ? { tile: true as const } : {}), at } satisfies Pending);
      kv.put(`${BY_NONCE}${nonce}`, { ticket: ticket.hash, at });
      return { kind: 'link', url: ticket.url };
    },
    // What the hop shows before Continue: the app, what connecting allows, and the one origin Continue may send the browser
    // to. Null once the attempt started, settled or ran out, so the page reads as used or expired.
    describe(hash: string): Readonly<{ entry: McpCatalogueEntry; consent: string; origin: string }> | null {
      const record = pending(hash), entry = MCP_CATALOGUE.find((candidate) => candidate.id === record?.connector);
      const target = record && entry ? deps.attemptTarget(record.nonce) : null;
      if (!record || !entry || !target) return null;
      return { entry, consent: catalogueTiles([]).find((tile) => tile.id === entry.id)!.about, origin: target.origin };
    },
    // Continue: the provider's authorize address for this ticket's attempt, once.
    async start(hash: string): Promise<Readonly<{ url: string; nonce: string }> | null> {
      const record = pending(hash);
      const url = record ? await deps.start(record.nonce) : null;
      return record && url ? { url, nonce: record.nonce } : null;
    },
    // One due poll of a device code: armed again while the provider says wait, else the line for the conversation that asked.
    async poll(nonce: string): Promise<Readonly<{ channel: ConnectAppChannel; thread?: string; text: string }> | null> {
      const record = kv.get<DeviceRecord>(`${DEVICE}${nonce}`), entry = MCP_CATALOGUE.find((candidate) => candidate.id === record?.connector);
      if (!record || !entry) return null;
      const out = await deps.pollDevice(nonce);
      if (out.kind === 'wait') { await arm(nonce, record, out.at); return null; }
      kv.delete(`${DEVICE}${nonce}`);
      return { channel: record.channel, ...(record.thread ? { thread: record.thread } : {}), text: settledText(entry.label, out.outcome) };
    },
    // The line the conversation that asked gets once the sign-in settles, and where it goes; for a tile, only that the
    // callback returns to the app. Taken once.
    settled(hash: string, outcome: ConnectOutcome): Readonly<{ channel: ConnectAppChannel; thread?: string; text: string }> | Readonly<{ tile: true }> | null {
      const record = pending(hash), entry = MCP_CATALOGUE.find((candidate) => candidate.id === record?.connector);
      if (!record || !entry) return null;
      kv.delete(`${RECORD}${hash}`);
      if (record.tile) return { tile: true };
      return { channel: record.channel, ...(record.thread ? { thread: record.thread } : {}), text: settledText(entry.label, outcome) };
    },
  };
};
export type AppConnects = ReturnType<typeof appConnects>;

// The connected server at a catalogue app's address, whatever its sign-in: the tile's connection, and what its disconnect removes.
type Connected = Readonly<{ id: string; server_url: string; status: McpStatus; connected_at: number }>;
const sameAddress = (a: string, b: string) => { try { return new URL(a).toString() === new URL(b).toString(); } catch { return false; } };
export const tileServer = <Row extends Connected>(entry: McpCatalogueEntry, servers: readonly Row[]): Row | undefined =>
  servers.find((server) => sameAddress(server.server_url, entry.url));
// Every catalogue app as the app's Connections tiles show it: about is the app's own line, consent what connecting allows.
export type AppTile = Readonly<{ id: string; label: string; about: string; consent: string | null; connectAvailable: boolean; connection: Readonly<{ status: McpStatus; connected_at: number }> | null }>;
export const appTiles = (servers: readonly Connected[], connectAvailable: boolean): readonly AppTile[] => {
  const consent = new Map(catalogueTiles(servers).map((tile) => [tile.id, tile.consent]));
  return MCP_CATALOGUE.map((entry) => {
    const server = tileServer(entry, servers);
    return { id: entry.id, label: entry.label, about: entry.about, consent: consent.get(entry.id) ?? null, connectAvailable, connection: server ? { status: server.status, connected_at: server.connected_at } : null };
  });
};

const settledText = (label: string, outcome: ConnectOutcome): string => {
  switch (outcome.kind) {
    case 'linked': return `${label} is connected.`;
    case 'denied': return `${label} was not connected: access was not granted.`;
    case 'expired': return `${label} was not connected: the sign-in took longer than 15 minutes. Ask me for a new link.`;
    default: return `${label} could not be connected: its sign-in did not finish. Ask me to try again.`;
  }
};

// The tool's side: one link per turn, minted only when the host can hand it to the owner, sent on the turn's own surface.
export const connectAppSender = (deps: Readonly<{
  route: ConsoleLinkRoute;
  // False while the host cannot hand a send to the owner, as in a capture probe that returns its sends to the caller.
  available(): boolean;
  issue(entry: McpCatalogueEntry, method: 'link' | 'code', turn: ConnectAppTurn): Promise<Issued>;
  log(entry: Pick<TurnLogEntry, 'trace' | 'hop' | 'ms' | 'ok' | 'detail'>): void;
}>): ConnectAppSend => {
  const issued = new Set<string>();
  return async (turn, entry, method) => {
    const started = Date.now();
    const done = (result: ConnectAppResult): ConnectAppResult => {
      deps.log({ trace: turn.turnId, hop: 'connect_app', ms: Date.now() - started, ok: result.status !== 'not_sent', detail: `${entry.id} ${result.status === 'not_sent' ? result.reason : result.status}` });
      return result;
    };
    const { route } = deps;
    if (issued.has(turn.turnId) || route.sent(turn)) return done({ status: 'not_sent', reason: 'already_sent' });
    if (!deps.available()) return done({ status: 'not_sent', reason: 'unavailable' });
    const out = await deps.issue(entry, method, turn);
    if (out.kind === 'already') return done({ status: 'already_connected' });
    if (out.kind === 'refused') return done({ status: 'not_sent', reason: out.reason });
    issued.add(turn.turnId);
    let delivered: boolean;
    try { delivered = await route.deliver(out.kind === 'link' ? connectAppLinkText(entry.label, out.url) : connectAppCodeText(entry.label, out.verificationUri, out.userCode, out.minutes), turn); }
    catch (error) { issued.delete(turn.turnId); done({ status: 'not_sent', reason: 'send_failed' }); throw error; }
    if (!delivered) issued.delete(turn.turnId);
    return done(delivered ? { status: 'sent', method: out.kind === 'link' ? 'link' : 'code', surface: route.surface } : { status: 'not_sent', reason: 'send_failed' });
  };
};
