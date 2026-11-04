import type { ToolName } from '@waldo/contracts';
import { canonicalIpv6, isBlockedHost, isIpLiteral, normaliseHost } from '../security/public-host';

export type DeclaredEgressPath = {
  readonly kind: 'host' | 'url';
  readonly path: readonly string[];
};

export type EgressPolicyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'allowlist_unavailable'
        | 'blocked_host'
        | 'host_not_allowlisted'
        | 'malformed_target';
    };

type DeclaredValues = { readonly ok: true; readonly values: unknown[] } | { readonly ok: false };

// Allowlist entry meaning "any public host" for page browsing (browse_page, and browse_act so a page's own
// transcript or captions can be opened). It never opens execute_code or any other tool, and the
// private/loopback/metadata blocks still apply. browse_act's submit, pay and send steps keep their own approval gates.
export const OPEN_PUBLIC = '*';
export const OPEN_PUBLIC_TOOLS: readonly ToolName[] = ['browse_page', 'browse_act'];

export const EGRESS_TARGET_PATHS: Readonly<
  Partial<Record<ToolName, readonly DeclaredEgressPath[]>>
> = Object.freeze({
  execute_code: [{ kind: 'host', path: ['allow_hosts', '*'] }],
  // Browser tools fetch owner-named URLs; declaring the path puts them under the non-global
  // address blocks below (the conformance test pins the declaration to the arg schema).
  browse_page: [{ kind: 'url', path: ['url'] }],
  browse_act: [{ kind: 'url', path: ['url'] }, { kind: 'url', path: ['command', 'url'] }],
});

// Deploy config feeds the hook: WALDO_EGRESS_ALLOWLIST is a comma-separated host list. Empty or
// unset means no allowlist - the hook then fails closed ('allowlist_unavailable'), which is the
// intended posture until an owner names hosts.
export const parseEgressAllowlistEnv = (raw: string | undefined): readonly string[] | undefined => {
  if (raw === undefined) return undefined;
  const hosts = raw.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? hosts : undefined;
};

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export function evaluateDeclaredEgress(
  args: unknown,
  paths: readonly DeclaredEgressPath[],
  allowlist: readonly string[] | undefined,
  options: Readonly<{ openPublic?: boolean }> = {},
): EgressPolicyResult {
  // "-host" entries are a blocklist (host and subdomains), same env var, so no new deploy wiring.
  // They deny for every tool, win over the open sentinel and over a listed host, and never allow.
  const blocked = (allowlist ?? []).filter((entry) => entry.startsWith('-')).map((entry) => hostFromBareHost(entry.slice(1)));
  // A blocklist entry that does not parse must not be silently dropped: the operator meant to deny something, so fail closed.
  if (blocked.some((host) => host === null || host.includes('*'))) return { ok: false, reason: 'allowlist_unavailable' };
  const blockedHosts = blocked.filter((host): host is string => host !== null);
  const allowedHosts = parseAllowlist(allowlist?.filter((entry) => entry !== OPEN_PUBLIC && !entry.startsWith('-')));

  for (const path of paths) {
    const declaredValues = valuesAtPath(args, path.path);
    if (!declaredValues.ok) return { ok: false, reason: 'malformed_target' };

    for (const value of declaredValues.values) {
      const host = path.kind === 'url' ? hostFromUrl(value) : hostFromBareHost(value);
      if (host === null) return { ok: false, reason: 'malformed_target' };
      if (isBlockedHost(host) || blockedHosts.some((entry) => matchesAllowedHost(host, entry))) return { ok: false, reason: 'blocked_host' };

      // Open public web: any host that passed the blocked-host checks above. Only the caller decides
      // which tool gets this; the allowlist sentinel alone never opens a tool.
      if (options.openPublic === true) continue;
      if (allowedHosts === null) return { ok: false, reason: 'allowlist_unavailable' };
      if (!allowedHosts.some((allowed) => matchesAllowedHost(host, allowed))) {
        return { ok: false, reason: 'host_not_allowlisted' };
      }
    }
  }

  return { ok: true };
}

function valuesAtPath(value: unknown, path: readonly string[]): DeclaredValues {
  if (value === undefined) return { ok: true, values: [] };
  if (path.length === 0) return { ok: true, values: [value] };

  const segment = path[0];
  if (segment === undefined) return { ok: true, values: [value] };
  const rest = path.slice(1);
  if (segment === '*') {
    if (!Array.isArray(value)) return { ok: false };

    const values: unknown[] = [];
    for (const item of value) {
      const nested = valuesAtPath(item, rest);
      if (!nested.ok) return nested;
      values.push(...nested.values);
    }
    return { ok: true, values };
  }

  if (!isRecord(value)) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(value, segment)) return { ok: true, values: [] };
  return valuesAtPath(value[segment], rest);
}

function parseAllowlist(allowlist: readonly string[] | undefined): string[] | null {
  if (allowlist === undefined || allowlist.length === 0) return null;

  const hosts = allowlist.map(hostFromBareHost);
  return hosts.every((host): host is string => host !== null) ? hosts : null;
}

function hostFromUrl(value: unknown): string | null {
  if (!isTrimmedString(value)) return null;

  try {
    const parsed = new URL(value);
    if (
      !HTTP_PROTOCOLS.has(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0
    ) {
      return null;
    }
    return normaliseHost(parsed.hostname);
  } catch {
    return null;
  }
}

function hostFromBareHost(value: unknown): string | null {
  if (!isTrimmedString(value)) return null;

  const ipv6 = canonicalIpv6(value);
  if (ipv6 !== null) return ipv6;

  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    return normaliseHost(parsed.hostname);
  } catch {
    return null;
  }
}

function isTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function matchesAllowedHost(host: string, allowed: string): boolean {
  if (isIpLiteral(host) || isIpLiteral(allowed)) return host === allowed;
  return host === allowed || host.endsWith(`.${allowed}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
