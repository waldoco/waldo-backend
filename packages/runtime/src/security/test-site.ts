// A test or staging copy of a public site (a bank's uat. host) can carry dummy phone numbers, old prices or unreleased
// policy, so nothing read from one reaches the owner as fact. Only labels left of the registrable name count, so dev.to,
// developer.apple.com and test.com stay public sites. Returns the host, or null.
const TEST_LABEL = /^(?:uat|staging|stage|stg|test|qa|dev|sandbox|preprod|pre-prod)(?:\d+|-[a-z0-9-]*)?$/;

export const testSiteHost = (url: string): string | null => {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return host.split('.').slice(0, -2).some((label) => TEST_LABEL.test(label)) ? host : null;
};
