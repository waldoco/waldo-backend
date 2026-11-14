import type { GoogleClient } from '../connectors/google';

// Whether the owner already knows a party, from their own Google account, for the recipient guard: someone they have mailed
// (Gmail's sent folder) or someone saved in their Google Contacts. Google's automatic "other contacts" do not count, since
// mail from a stranger can put one there. Each read is bounded, and a grant without the scope, a failed read or a slow one
// answers unknown, which leaves the effect on a card.
export const KNOWN_PARTY_TIMEOUT_MS = 3_000;
// Only a plain address is looked up: it goes into a Gmail query, so nothing that could add a clause reaches it.
const PLAIN_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export type KnownPartySources = Readonly<{
  // The owner's Google client for the account the effect goes out from (the default one when none is named), or null where
  // that account has no grant for the feature.
  mail(account?: string): Promise<Pick<GoogleClient, 'searchMail'> | null>;
  contacts(account?: string): Promise<Pick<GoogleClient, 'searchContacts'> | null>;
  timeoutMs?: number;
}>;

const within = async <T,>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('known party lookup timed out')), ms); })]); }
  finally { clearTimeout(timer); }
};

export const knownPartyLookup = (sources: KnownPartySources) => async (address: string, account?: string): Promise<boolean> => {
  if (!PLAIN_ADDRESS.test(address)) return false;
  const ms = sources.timeoutMs ?? KNOWN_PARTY_TIMEOUT_MS;
  const sent = async () => {
    const client = await sources.mail(account);
    return !!client && (await client.searchMail(`in:sent {to:${address} cc:${address} bcc:${address}}`, 1)).length > 0;
  };
  const saved = async () => {
    const client = await sources.contacts(account);
    if (!client?.searchContacts) return false;
    return (await client.searchContacts(address, 3)).some(match => match.source === 'contacts' && match.emails.some(email => email.toLowerCase() === address));
  };
  const [mailed, contact] = await Promise.all([within(sent(), ms).catch(() => false), within(saved(), ms).catch(() => false)]);
  return mailed || contact;
};
