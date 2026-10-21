export type MemoryListView = 'spots' | 'constellation';
export type MemoryListDestination = { view: MemoryListView; cursor?: string };
export type MemoryDestination =
  | ({ kind: 'list' } & MemoryListDestination)
  | { kind: 'detail'; view: MemoryListView; id: string; returnTo?: MemoryListDestination }
  | { kind: 'explore'; id: string; cursor?: string; returnTo?: MemoryListDestination }
  | { kind: 'profile' };
export type MemoryDestinationResult =
  | { kind: 'valid-memory'; destination: MemoryDestination }
  | { kind: 'invalid-memory' }
  | { kind: 'non-memory' };

// UI selector bounds, not authorization or a new server cursor format. Returned
// cursors remain server-owned list positions; decoding them here grants nothing.
const ID_LENGTH = 256;
const CURSOR_LENGTH = 512;
// A UTF-16 unit can expand to nine characters in query encoding. This covers
// one maximum ID, two cursors and the fixed path/keys without rejecting valid
// selectors during link rendering after they passed response validation.
const FRAGMENT_LENGTH = (ID_LENGTH + 2 * CURSOR_LENGTH) * 9 + 128;
const invalid = (): MemoryDestinationResult => ({ kind: 'invalid-memory' });
const listView = (value: unknown): value is MemoryListView => value === 'spots' || value === 'constellation';
const selector = (value: unknown, maximum: number): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
};
export const isMemoryItemId = (value: unknown): value is string => selector(value, ID_LENGTH);
export const isMemoryCursor = (value: unknown): value is string => selector(value, CURSOR_LENGTH);

/** Accept only a dashboard fragment/route, never a URL, credential or action. */
export function parseMemoryDestination(raw: string): MemoryDestinationResult {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return invalid();
  const route = raw.replace(/^#/, '').replace(/^\//, '');
  const question = route.indexOf('?');
  const path = question < 0 ? route : route.slice(0, question);
  if (path !== 'memory' && !path.startsWith('memory/')) return { kind: 'non-memory' };
  if (!['memory', 'memory/spots', 'memory/constellation', 'memory/profile'].includes(path) || route.includes('#') || route.length > FRAGMENT_LENGTH) return invalid();
  const query = question < 0 ? '' : route.slice(question + 1);
  // URLSearchParams tolerates malformed escapes. Reject them before it can
  // replace invalid UTF-8 or leave a broken percent escape in a selector.
  try { encodeURIComponent(query); decodeURIComponent(query); } catch { return invalid(); }
  const params = new URLSearchParams(query);
  const allowed = ['id', 'cursor', 'explore', 'returnView', 'returnCursor'];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) return invalid();
  }
  if (path === 'memory/profile') return params.size === 0 ? { kind: 'valid-memory', destination: { kind: 'profile' } } : invalid();
  const view: MemoryListView = path === 'memory/constellation' ? 'constellation' : 'spots';
  const id = params.get('id');
  const cursor = params.get('cursor');
  const explore = params.get('explore');
  const returnView = params.get('returnView');
  const returnCursor = params.get('returnCursor');
  if (id !== null && !isMemoryItemId(id) || cursor !== null && !isMemoryCursor(cursor) || returnCursor !== null && !isMemoryCursor(returnCursor)) return invalid();
  if (returnView !== null && !listView(returnView) || returnCursor !== null && returnView === null) return invalid();
  const returnTo: MemoryListDestination | undefined = returnView === null ? undefined : { view: returnView as MemoryListView, ...(returnCursor === null ? {} : { cursor: returnCursor }) };
  if (id === null) {
    if (explore !== null || returnTo !== undefined) return invalid();
    return { kind: 'valid-memory', destination: { kind: 'list', view, ...(cursor === null ? {} : { cursor }) } };
  }
  if (explore !== null) {
    if (view !== 'constellation' || explore !== '1') return invalid();
    return { kind: 'valid-memory', destination: { kind: 'explore', id, ...(cursor === null ? {} : { cursor }), ...(returnTo ? { returnTo } : {}) } };
  }
  if (cursor !== null) return invalid();
  return { kind: 'valid-memory', destination: { kind: 'detail', view, id, ...(returnTo ? { returnTo } : {}) } };
}

/** Build only selectors from the typed destination. Never accept a return URL. */
export function buildMemoryDestination(destination: MemoryDestination): string {
  const allowed = destination.kind === 'list' ? ['kind', 'view', 'cursor']
    : destination.kind === 'detail' ? ['kind', 'view', 'id', 'returnTo']
      : destination.kind === 'explore' ? ['kind', 'id', 'cursor', 'returnTo'] : ['kind'];
  if (Object.keys(destination).some(key => !allowed.includes(key))) throw new TypeError('Invalid Memory destination.');
  if ((destination.kind === 'list' || destination.kind === 'explore') && destination.cursor !== undefined && !isMemoryCursor(destination.cursor)) throw new TypeError('Invalid Memory destination.');
  const params = new URLSearchParams();
  let view: string;
  if (destination.kind === 'profile') view = 'profile';
  else if (destination.kind === 'list') {
    if (!listView(destination.view)) throw new TypeError('Invalid Memory destination.');
    view = destination.view;
    if (destination.cursor !== undefined) params.set('cursor', destination.cursor);
  } else if (destination.kind === 'detail' || destination.kind === 'explore') {
    if (!isMemoryItemId(destination.id) || destination.kind === 'detail' && !listView(destination.view)) throw new TypeError('Invalid Memory destination.');
    view = destination.kind === 'explore' ? 'constellation' : destination.view;
    params.set('id', destination.id);
    if (destination.kind === 'explore') {
      params.set('explore', '1');
      if (destination.cursor !== undefined) params.set('cursor', destination.cursor);
    }
    if (destination.returnTo !== undefined) {
      if (Object.keys(destination.returnTo).some(key => key !== 'view' && key !== 'cursor')) throw new TypeError('Invalid Memory destination.');
      if (!listView(destination.returnTo.view) || destination.returnTo.cursor !== undefined && !isMemoryCursor(destination.returnTo.cursor)) throw new TypeError('Invalid Memory destination.');
      params.set('returnView', destination.returnTo.view);
      if (destination.returnTo.cursor !== undefined) params.set('returnCursor', destination.returnTo.cursor);
    }
  } else throw new TypeError('Invalid Memory destination.');
  const query = params.toString();
  const result = `#/memory/${view}${query ? `?${query}` : ''}`;
  if (parseMemoryDestination(result).kind !== 'valid-memory') throw new TypeError('Invalid Memory destination.');
  return result;
}
