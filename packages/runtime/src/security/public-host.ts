// Hosts that are not globally reachable, recognisable without DNS: private, loopback, link-local and
// metadata addresses, documentation and reserved ranges, and internal-only names. Dependency-free so the
// Worker hooks and the Edge Functions share one list.
const IPV4 = (first: number, second: number, third: number, fourth: number): number =>
  ((first * 0x100 + second) * 0x100 + third) * 0x100 + fourth;

// These blocks are not globally reachable. URL parsing remains local: nothing here resolves
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

export function normaliseHost(host: string): string | null {
  const normalised = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return normalised.length > 0 ? normalised : null;
}

// Names that only resolve inside a private network and are recognisable without DNS: a dotless
// hostname (not an IPv6 literal) and the reserved internal suffixes.
const INTERNAL_SUFFIXES = ['.local', '.internal', '.svc', '.localdomain'] as const;
function isInternalNetworkName(host: string): boolean {
  if (host.includes(':')) return false;
  return !host.includes('.') || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function isBlockedHost(host: string): boolean {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    isInternalNetworkName(host)
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

export function canonicalIpv6(host: string): string | null {
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

export function ipv4Address(host: string): number | null {
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

export function isIpLiteral(host: string): boolean {
  return canonicalIpv6(host) !== null || ipv4Address(host) !== null;
}
