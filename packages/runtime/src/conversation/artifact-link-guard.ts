// Hard safety line (deterministic, no model judgment): a final reply may show an artifact delivery
// URL only if a successful tool call in the same turn returned that exact URL in its typed result
// (data.delivery.url). A URL a model composed from an internal artifact id, copied from history,
// or quoted from other tool/external text is removed. Scope is URLs that carry an internal
// artifact id ("art:" prefix, optionally percent-encoded); other URL classes are not covered.
export const ARTIFACT_LINK_REMOVED_NOTICE = '[I removed a file link here: no delivery link was issued for it this turn.]';

const URL_TOKEN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const TRAILING = /[.,;:!?]+$/;

const carriesArtifactId = (url: string): boolean => {
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* keep the raw token */ }
  return /(^|[^a-z0-9])art:/i.test(decoded);
};

// The only receipt shape: a successful result whose data.delivery.url is a string.
export const receiptUrl = (result: unknown): string | null => {
  const data = (result as { ok?: unknown; data?: { delivery?: { url?: unknown } } } | null);
  if (data === null || typeof data !== 'object' || data.ok !== true) return null;
  const url = data.data?.delivery?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
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
