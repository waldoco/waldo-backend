// A 20-character code from a 32-symbol alphabet has 100 bits of entropy. Store only its SHA-256 hash.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newInviteCode = (): string => [...crypto.getRandomValues(new Uint8Array(20))]
  .map((byte) => ALPHABET[byte & 31]!).join('');

// The browser fragment is never sent in HTTP requests or Referer headers.
export const inviteLink = (requestUrl: string, email: string, code: string): string => {
  const url = new URL('/console/signup', requestUrl);
  url.hash = new URLSearchParams({ email: email.trim().toLowerCase(), invite: code }).toString();
  return url.toString();
};
