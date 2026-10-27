// One owner "yes" for a named errand: the run it started may send page writes (POST and the like) to one exact origin,
// for at most fifteen minutes and a fixed number of write requests. Every other write stays refused by the host.
export const BROWSER_ERRAND_GRANT_MS = 15 * 60_000;
// What the owner's card says a grant allows, in words they can check against the args shown under it.
export const siteGrantPreview = (grant: Readonly<{ origin: string; submits: number }>): string =>
  `This errand may submit forms on ${grant.origin} only: up to ${grant.submits} submission${grant.submits === 1 ? '' : 's'} within ${BROWSER_ERRAND_GRANT_MS / 60_000} minutes. Nothing goes to any other site, and it never types a password.`;
export type BrowserErrandGrant = Readonly<{ approvalId: string; runId: string; origin: string; expiresAt: number; maxSubmits: number; submits: readonly number[] }>;
const key = (runId: string) => `browser-errand-grant:${runId}`;
const originOf = (url: string) => { try { return new URL(url).origin; } catch { return undefined; } };
const live = (storage: DurableObjectStorage, runId: string, url: string, now: number) => {
  const grant = storage.kv.get<BrowserErrandGrant>(key(runId));
  return grant && grant.expiresAt > now && grant.submits.length < grant.maxSubmits && originOf(url) === grant.origin ? grant : undefined;
};

export function grantBrowserErrand(storage: DurableObjectStorage, grant: Omit<BrowserErrandGrant, 'submits'>, now: number): void {
  if (originOf(grant.origin) !== grant.origin || !grant.origin.startsWith('https://')) throw Error('errand grant origin must be one https origin');
  if (!Number.isSafeInteger(grant.maxSubmits) || grant.maxSubmits < 1) throw Error('errand grant needs a submit count');
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + BROWSER_ERRAND_GRANT_MS) throw Error('errand grant lasts at most fifteen minutes');
  storage.kv.put(key(grant.runId), { ...grant, submits: [] } satisfies BrowserErrandGrant);
}

export const browserErrandAdmits = (storage: DurableObjectStorage, runId: string, url: string, now: number): boolean => !!live(storage, runId, url, now);

// Spent before the request leaves, so a write whose outcome is unknown still counts against the grant.
export const spendBrowserErrandSubmit = (storage: DurableObjectStorage, runId: string, url: string, now: number): boolean => storage.transactionSync(() => {
  const grant = live(storage, runId, url, now);
  if (!grant) return false;
  storage.kv.put(key(runId), { ...grant, submits: [...grant.submits, now] } satisfies BrowserErrandGrant);
  return true;
});

const receiptKey = (runId: string) => `browser-errand-receipt:${runId}`;
// Ends the grant and keeps what it allowed and what was submitted under it until the owner has heard it.
export const revokeBrowserErrand = (storage: DurableObjectStorage, runId: string): BrowserErrandGrant | undefined => storage.transactionSync(() => {
  const grant = storage.kv.get<BrowserErrandGrant>(key(runId));
  storage.kv.delete(key(runId));
  if (grant) storage.kv.put(receiptKey(runId), grant);
  return grant;
});

// The owner's line for an ended grant: how many of the allowed submissions went out, where, and when. Never what they carried.
export const browserErrandReceipt = (storage: DurableObjectStorage, runId: string, timezone: string): string | null => {
  const grant = storage.kv.get<BrowserErrandGrant>(receiptKey(runId));
  if (!grant) return null;
  if (!grant.submits.length) return `Receipts: this errand submitted nothing on ${grant.origin}.`;
  const times = grant.submits.map(at => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at)).join(', ');
  return `Receipts: this errand submitted ${grant.submits.length} of ${grant.maxSubmits} allowed form${grant.maxSubmits === 1 ? '' : 's'} on ${grant.origin} (${times}).`;
};
export const clearBrowserErrandReceipt = (storage: DurableObjectStorage, runId: string): void => { storage.kv.delete(receiptKey(runId)); };
