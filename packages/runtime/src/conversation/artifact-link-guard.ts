// Hard safety line (deterministic, no model judgment): a final reply may show an artifact delivery
// URL only if a successful tool call in the same turn returned that exact URL in its typed result
// (data.delivery.url). A URL a model composed from an internal artifact id, copied from history,
// or quoted from other tool/external text is removed. Scope is URLs that carry an internal
// artifact id ("art:" prefix, however percent-encoded); other URL classes are not covered.
export const ARTIFACT_LINK_REMOVED_NOTICE = '[I removed a file link here: no delivery link was issued for it this turn.]';

const URL_TOKEN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const TRAILING = /[.,;:!?]+$/;

// Decode each %XX pair on its own (invalid pairs elsewhere in the token never block the rest) and
// repeat to a fixpoint, so single, double and deeper encodings all reach the plain form.
const fullyDecoded = (url: string): string => {
  let current = url;
  for (;;) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_pair, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) return current;
    current = next;
  }
};
const carriesArtifactId = (url: string): boolean => /(^|[^a-z0-9])art:/i.test(fullyDecoded(url));

// Trusted receipt contract (core): only a successful create_artifact / revise_artifact result whose
// typed delivery is status 'owner_link', audience 'owner_authenticated' and not stamped external.
// read_artifact, other tools and external content never grant a link.
export const RECEIPT_TOOLS: ReadonlySet<string> = new Set(['create_artifact', 'revise_artifact']);
export const receiptUrl = (tool: string, result: unknown): string | null => {
  if (!RECEIPT_TOOLS.has(tool)) return null;
  const r = result as { ok?: unknown; source_taint?: unknown; data?: { delivery?: { status?: unknown; audience?: unknown; url?: unknown } } } | null;
  if (r === null || typeof r !== 'object' || r.ok !== true || r.source_taint === 'external') return null;
  const delivery = r.data?.delivery;
  return delivery?.status === 'owner_link' && delivery.audience === 'owner_authenticated' && typeof delivery.url === 'string' && delivery.url.length > 0 ? delivery.url : null;
};

export const guardArtifactLinks = (text: string, receipts: ReadonlySet<string>): string => {
  let removed = false;
  const out = text.replace(URL_TOKEN, (token) => {
    const trail = TRAILING.exec(token)?.[0] ?? '';
    const url = trail ? token.slice(0, -trail.length) : token;
    if (!carriesArtifactId(url) || receipts.has(url)) return token;
    removed = true;
    return trail;
  });
  return removed ? `${out}\n${ARTIFACT_LINK_REMOVED_NOTICE}` : out;
};
