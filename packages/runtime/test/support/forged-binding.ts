// The browser binding anyone holding the link can build: the provider and the attempt's nonce are in the authorize or
// start address, so a binding made from them alone, with no server secret, is what a forger sends.
const b64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const sha256 = async (text: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const forgedBinding = async (provider: string, nonce: string, expires = Date.now() + 10 * 60_000): Promise<string> => {
  const key = await sha256(`waldo-oauth-browser.v1|${provider}|${nonce}`);
  return `__Secure-waldo-oauth-${key.slice(0, 16)}=${expires}.${await sha256(`${key}|${expires}`)}`;
};
