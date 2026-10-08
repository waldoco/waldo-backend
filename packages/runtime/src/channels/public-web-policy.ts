import { evaluateDeclaredEgress, EGRESS_TARGET_PATHS, OPEN_PUBLIC } from '../hooks/egress-policy';

export const PUBLIC_WEB_ORIGIN = OPEN_PUBLIC;
// Reuse the serving-path boundary for every initial URL and browser request.
// This is a static URL check; it does not claim DNS-rebinding protection.
export const isPublicWebUrl = (url: string, allowlist: readonly string[] = [OPEN_PUBLIC]): boolean =>
  evaluateDeclaredEgress({ url }, EGRESS_TARGET_PATHS.browse_page!, allowlist, { openPublic: allowlist.includes(OPEN_PUBLIC) }).ok;
