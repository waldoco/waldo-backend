import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';

// The owner's confirmed sign-in email, from the directory: the Auth address that still matches the owner's row and is
// confirmed. Null when the directory holds none, cannot be reached, or answers anything but an address; the account view
// then leaves the line out and the owner is not made to wait on it.
export const ownerAccountEmail = async (env: OwnerDirectoryEnv, doName: string, fetcher: typeof fetch = fetch): Promise<string | null> => {
  const call = signedRpc(env, fetcher);
  if (!call || !doName) return null;
  try {
    const answer = await call('owner_account_email', `accountemail.${doName}`, { p_do_name: doName });
    return typeof answer === 'string' && answer.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer) ? answer.toLowerCase() : null;
  } catch { return null; }
};
