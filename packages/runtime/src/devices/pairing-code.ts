import { base64url, sha256Hex } from './signing';
import { KEY_BYTES } from './contract';
export const mintPairingCode = (): string => base64url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
export const devicePairingCodeHash = (code: string): Promise<string> => sha256Hex(new TextEncoder().encode(code));
