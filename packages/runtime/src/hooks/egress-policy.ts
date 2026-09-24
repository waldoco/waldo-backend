import type { ToolName } from '@waldo/contracts';

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

export const EGRESS_TARGET_PATHS: Readonly<
  Partial<Record<ToolName, readonly DeclaredEgressPath[]>>
> = Object.freeze({
  execute_code: [{ kind: 'host', path: ['allow_hosts', '*'] }],
  // Browser tools fetch owner-named URLs; declaring the path puts them under the non-global
  // address blocks below (the conformance test pins the declaration to the arg schema).
  browse_page: [{ kind: 'url', path: ['url'] }],
  browse_act: [{ kind: 'url', path: ['url'] }],
});

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const IPV4 = (first: number, second: number, third: number, fourth: number): number =>
  ((first * 0x100 + second) * 0x100 + third) * 0x100 + fourth;

// These blocks are not globally reachable. URL parsing remains local: this policy never resolves
// hostnames or follows redirects.
const IPV4_NON_GLOBAL_CIDRS = [
  [IPV4(0, 0, 0, 0), 8],
  [IPV4(10, 0, 0, 0), 8],
  [IPV4(100, 64, 0, 0), 10],
  [IPV4(127, 0, 0, 0), 8],
  [IPV4(169, 254, 0, 0), 16],
  [IPV4(172, 16, 0, 0), 12],
  [IPV4(192, 0, 2, 0), 24],
  [IPV4(192, 88, 99, 0), 24],
  [IPV4(192, 168, 0, 0), 16],
  [IPV4(198, 18, 0, 0), 15],
  [IPV4(198, 51, 100, 0), 24],
  [IPV4(203, 0, 113, 0), 24],
  [IPV4(224, 0, 0, 0), 4],
  [IPV4(240, 0, 0, 0), 4],
] as const;
const IANA_PROTOCOL_ASSIGNMENTS = [IPV4(192, 0, 0, 0), 24] as const;
const GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENTS = new Set([IPV4(192, 0, 0, 9), IPV4(192, 0, 0, 10)]);
// IANA's IPv6 special-purpose and global-unicast registries identify these ranges as
// non-public. This is a conservative static denylist, so keep literal destinations
// fail-closed rather than treating the whole 2000::/3 allocation as publicly reachable.
const IPV6_NON_PUBLIC_GLOBAL_UNICAST_PREFIXES = [
  [[0x2001, 0x0000], 23],
  [[0x2001, 0x0db8], 32],
  [[0x2002], 16],
  [[0x2d00], 8],
  [[0x2e00], 7],
  [[0x3000], 4],
] as const;

export function evaluateDeclaredEgress(
  args: unknown,
  paths: readonly DeclaredEgressPath[],
  allowlist: readonly string[] | undefined,
): EgressPolicyResult {
  const allowedHosts = parseAllowlist(allowlist);

  for (const path of paths) {
    const declaredValues = valuesAtPath(args, path.path);
    if (!declaredValues.ok) return { ok: false, reason: 'malformed_target' };

    for (const value of declaredValues.values) {
      const host = path.kind === 'url' ? hostFromUrl(value) : hostFromBareHost(value);
      if (host === null) return { ok: false, reason: 'malformed_target' };
      if (isBlockedHost(host)) return { ok: false, reason: 'blocked_host' };

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

function normaliseHost(host: string): string | null {
  const normalised = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return normalised.length > 0 ? normalised : null;
}

function isBlockedHost(host: string): boolean {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipv6 = canonicalIpv6(host);
  if (ipv6 !== null) {
    const words = ipv6Words(ipv6);
    return words === null || isBlockedIpv6(words);
  }

  return isBlockedIpv4(host);
}

function canonicalIpv6(host: string): string | null {
  const candidate = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!candidate.includes(':')) return null;

  try {
    const parsed = new URL(`http://[${candidate}]/`);
    return normaliseHost(parsed.hostname);
  } catch {
    return null;
  }
}

function ipv6Words(host: string): number[] | null {
  const [left = '', right = ''] = host.split('::', 2);
  const leftGroups = left.length === 0 ? [] : left.split(':');
  const rightGroups = right.length === 0 ? [] : right.split(':');
  const compressed = host.includes('::');
  const missingGroups = 8 - leftGroups.length - rightGroups.length;
  if (missingGroups < 0 || (!compressed && missingGroups !== 0) || (compressed && missingGroups < 1)) {
    return null;
  }

  const groups = compressed
    ? [...leftGroups, ...Array.from({ length: missingGroups }, () => '0'), ...rightGroups]
    : leftGroups;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }

  return groups.map((group) => Number.parseInt(group, 16));
}

function isBlockedIpv6(words: readonly number[]): boolean {
  const first = words[0] ?? 0;
  if (first < 0x2000 || first > 0x3fff) return true;

  return IPV6_NON_PUBLIC_GLOBAL_UNICAST_PREFIXES.some(([prefix, bits]) =>
    ipv6MatchesPrefix(words, prefix, bits),
  );
}

function ipv6MatchesPrefix(
  address: readonly number[],
  prefix: readonly number[],
  bits: number,
): boolean {
  const fullWords = Math.floor(bits / 16);
  for (let index = 0; index < fullWords; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }

  const remainder = bits % 16;
  if (remainder === 0) return true;

  const mask = (0xffff << (16 - remainder)) & 0xffff;
  return ((address[fullWords] ?? 0) & mask) === ((prefix[fullWords] ?? 0) & mask);
}

function isBlockedIpv4(host: string): boolean {
  const address = ipv4Address(host);
  if (address === null) return false;

  if (inCidr(address, ...IANA_PROTOCOL_ASSIGNMENTS)) {
    return !GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENTS.has(address);
  }

  return IPV4_NON_GLOBAL_CIDRS.some(([base, prefix]) => inCidr(address, base, prefix));
}

function ipv4Address(host: string): number | null {
  const octets = host.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return IPV4(octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0);
}

function inCidr(address: number, base: number, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(base / size);
}

function matchesAllowedHost(host: string, allowed: string): boolean {
  if (isIpLiteral(host) || isIpLiteral(allowed)) return host === allowed;
  return host === allowed || host.endsWith(`.${allowed}`);
}

function isIpLiteral(host: string): boolean {
  return canonicalIpv6(host) !== null || ipv4Address(host) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
