import type { CoreFiles } from '../memory/core-files';
import type { ConstellationEdge, ConstellationNode, Spot } from '../memory/spots';

export const CONSOLE_PATH = '/console';
export const CONSOLE_COOKIE = 'waldo_console';
const LINK_MS = 10 * 60_000;
const SESSION_MS = 12 * 60 * 60_000;

type Store = Readonly<{ get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> }>;
type Grant = Readonly<{ token: string; expires: number }>;

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// One-time link from Telegram -> short session cookie. Only the owner's DM can mint a link.
export const consoleAccess = (store: Store, now: () => number = Date.now) => ({
  async mintLink(origin: string): Promise<string> {
    const token = randomToken();
    await store.put('console:link', { token, expires: now() + LINK_MS } satisfies Grant);
    return `${origin}${CONSOLE_PATH}?t=${token}`;
  },
  async redeem(token: string): Promise<string | null> {
    const link = await store.get<Grant>('console:link');
    if (!link || link.token !== token || link.expires < now()) return null;
    await store.delete('console:link');
    const session = randomToken();
    await store.put('console:session', { token: session, expires: now() + SESSION_MS } satisfies Grant);
    return session;
  },
  async valid(session: string | null): Promise<boolean> {
    const grant = await store.get<Grant>('console:session');
    return !!session && !!grant && grant.token === session && grant.expires >= now();
  },
});

export const sessionCookie = (request: Request): string | null =>
  (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')).find(([name]) => name === CONSOLE_COOKIE)?.[1] ?? null;

export type ConsoleView = Readonly<{
  release: string;
  timezone: string;
  google: Readonly<{ connected: boolean; email: string | null }>;
  memory: CoreFiles;
  spots: readonly Spot[];
  retiredSpots: readonly Spot[];
  nodes: readonly ConstellationNode[];
  edges: readonly ConstellationEdge[];
  cards: readonly Readonly<{ card: string; time: string | null; reason: string; sent: boolean }>[];
  ledger: string;
  checklist: string;
  trace: string;
}>;

const esc = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const pre = (text: string) => `<pre>${esc(text || '(empty)')}</pre>`;
const section = (title: string, body: string) => `<section><h2>${esc(title)}</h2>${body}</section>`;
const table = (head: readonly string[], rows: readonly (readonly string[])[]) => rows.length === 0 ? '<p>None yet.</p>'
  : `<table><tr>${head.map((cell) => `<th>${esc(cell)}</th>`).join('')}</tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;

export const renderConsole = (view: ConsoleView): string => {
  const label = new Map(view.nodes.map((node) => [node.id, node.label]));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waldo console</title>
<style>body{font:15px/1.45 system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1d1d1f}h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;background:#f6f6f7;padding:8px;border-radius:6px}.muted{color:#777}</style></head><body>
<h1>Waldo console</h1><p class="muted">Staging ${esc(view.release)} - times in ${esc(view.timezone)} - read-only v0</p>
${section('Connectors', table(['Connector', 'Status'], [['Google (Calendar, Gmail)', view.google.connected ? `connected${view.google.email ? ` as ${view.google.email}` : ''}` : 'not connected'], ['Telegram', 'connected (owner DM)'], ['WhatsApp', 'not built yet']]))}
${section('Spots', table(['#', 'Kind', 'Source', 'Seen', 'Last seen', 'Spot', 'Evidence'], view.spots.map((spot) => [String(spot.id), spot.kind, spot.source, String(spot.seen_count), spot.last_seen_at.slice(0, 10), spot.text, spot.evidence])))}
${section('Constellation', table(['#', 'Domain', 'Node', 'Strength', 'Status', 'Last confirmed'], view.nodes.map((node) => [String(node.id), node.domain, `${node.label}: ${node.summary}`, node.strength.toFixed(2), node.status, node.last_confirmed.slice(0, 10)]))
    + table(['From', 'Relation', 'To', 'Strength', 'Evidence'], view.edges.map((edge) => [label.get(edge.from_id) ?? `#${edge.from_id}`, edge.relation, label.get(edge.to_id) ?? `#${edge.to_id}`, edge.strength.toFixed(2), String(edge.evidence_count)])))}
${section('Retired spots', table(['#', 'Status', 'Spot'], view.retiredSpots.map((spot) => [String(spot.id), spot.status, spot.text])))}
${section("Today's cards", table(['Card', 'Time', 'Sent', 'Why this time'], view.cards.map((card) => [card.card, card.time ?? 'default', card.sent ? 'yes' : 'no', card.reason])))}
${section('Memory', Object.entries(view.memory).map(([file, text]) => `<h3>${esc(file)}</h3>${pre(text)}`).join(''))}
${section('Ledger and reminders', pre(view.ledger))}
${section('E2E checklist', pre(view.checklist))}
${section('Recent trace', pre(view.trace))}
</body></html>`;
};
