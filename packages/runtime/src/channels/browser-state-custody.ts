// Private browser-state boundary. Authenticated host supplies binding/admission/key;
// Host must serialize state writes/revocation, enforce opt-in/expiry and generation
// admission, and garbage-collect old generations. This seam alone is not a live driver.
// No model tool accepts a provider session ID, storage state or encryption key.
export type BrowserStateBinding = Readonly<{
  ownerId: string;
  environment: string;
  siteOrigin: string;
  accountId: string;
  generation: number;
}>;
export type BrowserStateBlobStore = Readonly<{
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}>;
export class BrowserStateError extends Error {
  constructor(code: "rejected" | "unavailable" | "invalid" | "corrupt") {
    super(`browser_state_${code}`);
  }
}
const encode = new TextEncoder();
const scope = (binding: BrowserStateBinding) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      binding.ownerId,
    ) ||
    ![binding.environment, binding.accountId].every(
      (s) =>
        typeof s === "string" &&
        s.length > 0 &&
        s.length <= 200 &&
        s.trim() === s &&
        !/[\x00-\x1f\x7f]/.test(s),
    ) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1
  )
    throw new BrowserStateError("invalid");
  let origin: URL;
  try {
    origin = new URL(binding.siteOrigin);
  } catch {
    throw new BrowserStateError("invalid");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== binding.siteOrigin ||
    origin.username ||
    origin.password
  )
    throw new BrowserStateError("invalid");
  return JSON.stringify([
    binding.ownerId,
    binding.environment,
    binding.siteOrigin,
    binding.accountId,
    binding.generation,
  ]);
};
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export async function browserStateCustody(
  binding: BrowserStateBinding,
  key: CryptoKey,
  blobs: BrowserStateBlobStore,
  admit: (binding: BrowserStateBinding) => Promise<boolean>,
) {
  const fixed = Object.freeze({ ...binding }),
    aad = encode.encode(scope(fixed));
  if (
    key.algorithm.name !== "AES-GCM" ||
    key.extractable ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  )
    throw new BrowserStateError("invalid");
  const path = `browser-state/v1/${hex(await crypto.subtle.digest("SHA-256", aad))}`;
  const check = async () => {
    let allowed: boolean;
    try {
      allowed = await admit(fixed);
    } catch {
      throw new BrowserStateError("unavailable");
    }
    if (allowed !== true) throw new BrowserStateError("rejected");
  };
  await check();
  return Object.freeze({
    async load(): Promise<Uint8Array | null> {
      await check();
      let value: Uint8Array | null;
      try {
        value = await blobs.get(path);
      } catch {
        throw new BrowserStateError("unavailable");
      }
      await check();
      if (value === null) return null;
      if (
        value.length < 29 ||
        value[0] !== 1 ||
        value.length > 1024 * 1024 + 29
      )
        throw new BrowserStateError("corrupt");
      let plain: Uint8Array;
      try {
        plain = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: value.slice(1, 13), additionalData: aad },
            key,
            value.slice(13),
          ),
        );
      } catch {
        throw new BrowserStateError("corrupt");
      }
      await check();
      return plain;
    },
    async save(value: Uint8Array): Promise<void> {
      const snapshot = new Uint8Array(value);
      if (snapshot.length > 1024 * 1024) throw new BrowserStateError("invalid");
      await check();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      let encrypted: Uint8Array;
      try {
        encrypted = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: aad },
            key,
            snapshot.buffer,
          ),
        );
      } catch {
        throw new BrowserStateError("unavailable");
      }
      const packet = new Uint8Array(13 + encrypted.length);
      packet[0] = 1;
      packet.set(iv, 1);
      packet.set(encrypted, 13);
      await check();
      try {
        await blobs.put(path, packet);
      } catch {
        throw new BrowserStateError("unavailable");
      }
    },
    async remove(): Promise<void> {
      await check();
      try {
        await blobs.remove(path);
      } catch {
        throw new BrowserStateError("unavailable");
      }
    },
  });
}
