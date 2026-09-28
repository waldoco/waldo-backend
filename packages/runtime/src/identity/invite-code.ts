// A 20-character code from a 32-symbol alphabet has 100 bits of entropy. Store only its SHA-256 hash.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newInviteCode = (): string => [...crypto.getRandomValues(new Uint8Array(20))]
  .map((byte) => ALPHABET[byte & 31]!).join('');
