import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';

export type OwnerGoogleSignin = Readonly<{ subject: string; email: string }>;

// The Google identity the owner signs in with: its subject, which Google's consent page takes as login_hint, and the owner's
// own confirmed address. Null when the directory holds none, cannot be reached, or answers anything else; the owner is then
// offered Google's account chooser as before. Neither value is logged.
export const ownerGoogleSignin = async (env: OwnerDirectoryEnv, doName: string, fetcher: typeof fetch = fetch): Promise<OwnerGoogleSignin | null> => {
  const call = signedRpc(env, fetcher);
  if (!call || !doName) return null;
  try {
    const answer = await call('owner_google_signin', `googlesignin.${doName}`, { p_do_name: doName }) as { subject?: unknown; email?: unknown } | null;
    const subject = answer?.subject, email = answer?.email;
    if (typeof subject !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(subject)) return null;
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { subject, email: email.toLowerCase() };
  } catch { return null; }
};
