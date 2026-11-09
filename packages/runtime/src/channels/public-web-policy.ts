import { evaluateDeclaredEgress, EGRESS_TARGET_PATHS, OPEN_PUBLIC } from '../hooks/egress-policy';

export const PUBLIC_WEB_ORIGIN = OPEN_PUBLIC;
// Reuse the serving-path boundary for every initial URL and browser request.
// This is a static URL check; it does not claim DNS-rebinding protection.
export const isPublicWebUrl = (url: string, allowlist: readonly string[] = [OPEN_PUBLIC]): boolean =>
  evaluateDeclaredEgress({ url }, EGRESS_TARGET_PATHS.browse_page!, allowlist, { openPublic: allowlist.includes(OPEN_PUBLIC) }).ok;

// Endpoints that record a submission on a plain GET, so a read-only browser must never request them. Google Forms stores a
// response when its formResponse address is opened with answers in the query; submitting a form goes through an approval.
export const writesOnGet = (url: string): boolean => {
  try {
    const target = new URL(url), segments = target.pathname.split('/').filter(Boolean);
    return target.hostname.toLowerCase() === 'docs.google.com' && segments[0] === 'forms' && segments.at(-1) === 'formResponse';
  } catch { return false; }
};
