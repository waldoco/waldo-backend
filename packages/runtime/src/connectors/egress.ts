// The one egress rail for owner-connected MCP servers and their authorization servers, shared with the
// mcp-proxy Edge Function. Every URL is https on the default port, carries no credentials, and names a
// globally reachable host. A connection's calls are also pinned to the origins recorded when the owner
// connected it, so a server or authorization server cannot point Waldo, or a token, somewhere new later.
// Nothing here resolves DNS; the private-address list is literal (security/public-host).
import { isBlockedHost, normaliseHost } from '../security/public-host.ts';

export type EgressCode = 'egress_malformed' | 'egress_scheme' | 'egress_credentials' | 'egress_port' | 'egress_host' | 'egress_unpinned' | 'egress_redirect' | 'egress_oversize' | 'egress_network' | 'egress_timeout';

export class EgressError extends Error {
  constructor(public readonly code: EgressCode, public readonly host?: string) { super(code); this.name = 'EgressError'; }
}

// A URL Waldo may send a request to. Fragments are dropped: they never reach a server.
export const egressTarget = (raw: string | URL): URL => {
  let url: URL;
  try { url = new URL(raw); } catch { throw new EgressError('egress_malformed'); }
  if (url.protocol !== 'https:') throw new EgressError('egress_scheme');
  if (url.username || url.password) throw new EgressError('egress_credentials');
  if (url.port !== '') throw new EgressError('egress_port');
  const host = normaliseHost(url.hostname);
  if (host === null || isBlockedHost(host)) throw new EgressError('egress_host', url.hostname);
  url.hash = '';
  return url;
};

export type GuardedResponse = Readonly<{ status: number; headers: Headers; text: string; url: string }>;
export type GuardedFetchOptions = Readonly<{
  // Origins this request may reach. Unset only during discovery, before any origin is recorded.
  pinned?: readonly string[];
  // GETs only: redirects followed, each hop checked again. POSTs never follow one.
  redirects?: number;
  maxBytes: number;
  timeoutMs: number;
}>;

// A response body larger than maxBytes is cut off while reading and refused, so a hostile server cannot
// fill the isolate's memory. The cap is a resource bound sized by the caller, not a content rule.
export const guardedFetch = async (fetcher: typeof fetch, raw: string | URL, init: RequestInit, options: GuardedFetchOptions): Promise<GuardedResponse> => {
  let url = egressTarget(raw);
  const method = (init.method ?? 'GET').toUpperCase();
  for (let hop = 0; ; hop += 1) {
    if (options.pinned && !options.pinned.includes(url.origin)) throw new EgressError('egress_unpinned', url.hostname);
    let response: Response;
    try {
      response = await fetcher(url.toString(), { ...init, redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (error) {
      throw new EgressError((error as { name?: string }).name === 'TimeoutError' ? 'egress_timeout' : 'egress_network', url.hostname);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (method !== 'GET' || location === null || hop >= (options.redirects ?? 0)) throw new EgressError('egress_redirect', url.hostname);
      url = egressTarget(new URL(location, url));
      continue;
    }
    return { status: response.status, headers: response.headers, text: await readCapped(response, options.maxBytes, url.hostname), url: url.toString() };
  }
};

const readCapped = async (response: Response, maxBytes: number, host: string): Promise<string> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new EgressError('egress_oversize', host);
  }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new EgressError('egress_oversize', host); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
};
