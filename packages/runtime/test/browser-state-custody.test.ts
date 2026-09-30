import { describe, it, expect } from "vitest";
import {
  browserStateCustody,
  type BrowserStateBinding,
  type BrowserStateBlobStore,
} from "../src/channels/browser-state-custody";
const binding: BrowserStateBinding = {
  ownerId: "00000000-0000-4000-8000-000000000001",
  environment: "staging",
  siteOrigin: "https://example.org",
  accountId: "account-a",
  generation: 1,
};
const secret = new TextEncoder().encode('{"cookies":[{"value":"SECRET"}]}');
const key = async () =>
  (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
const memory = () => {
  const data = new Map<string, Uint8Array>();
  const store: BrowserStateBlobStore = {
    get: async (k) => data.get(k)?.slice() ?? null,
    put: async (k, v) => {
      data.set(k, v.slice());
    },
    remove: async (k) => {
      data.delete(k);
    },
  };
  return { data, store };
};
describe("private browser storage-state custody (not a live driver)", () => {
  it("survives reconstruction without plaintext bytes or owner/site in storage keys", async () => {
    const { data, store } = memory(),
      k = await key();
    const a = await browserStateCustody(binding, k, store, async () => true);
    await a.save(secret);
    const b = await browserStateCustody(binding, k, store, async () => true);
    expect(await b.load()).toEqual(secret);
    expect([...data.keys()][0]).not.toMatch(/example|account|staging/);
    expect(new TextDecoder().decode([...data.values()][0])).not.toContain(
      "SECRET",
    );
  });
  it("uses randomized encryption", async () => {
    const { data, store } = memory(),
      k = await key(),
      a = await browserStateCustody(binding, k, store, async () => true);
    await a.save(secret);
    const first = [...data.values()][0];
    await a.save(secret);
    expect([...data.values()][0]).not.toEqual(first);
  });
  for (const [field, value] of Object.entries({
    ownerId: "00000000-0000-4000-8000-000000000002",
    environment: "production",
    siteOrigin: "https://other.org",
    accountId: "account-b",
    generation: 2,
  }))
    it(`isolates ${field} and rejects copied ciphertext`, async () => {
      const { data, store } = memory(),
        k = await key(),
        a = await browserStateCustody(binding, k, store, async () => true);
      await a.save(secret);
      const b = await browserStateCustody(
        { ...binding, [field]: value },
        k,
        store,
        async () => true,
      );
      expect(await b.load()).toBeNull();
      const ciphertext = [...data.values()][0]!;
      await b.save(secret);
      const other = [...data.keys()][1]!;
      data.set(other, ciphertext);
      await expect(b.load()).rejects.toThrow("browser_state_corrupt");
    });
  it("rejects tampered packet", async () => {
    const { data, store } = memory(),
      a = await browserStateCustody(
        binding,
        await key(),
        store,
        async () => true,
      );
    await a.save(secret);
    const packet = [...data.values()][0]!;
    packet[15] = packet[15]! ^ 1;
    await expect(a.load()).rejects.toThrow("browser_state_corrupt");
  });
  it("rejects wrong decryption key without revealing underlying error", async () => {
    const { store } = memory(),
      a = await browserStateCustody(
        binding,
        await key(),
        store,
        async () => true,
      );
    await a.save(secret);
    const b = await browserStateCustody(
      binding,
      await key(),
      store,
      async () => true,
    );
    await expect(b.load()).rejects.toThrow("browser_state_corrupt");
  });
  it("denies construction without host admission", async () => {
    await expect(
      browserStateCustody(
        binding,
        await key(),
        memory().store,
        async () => false,
      ),
    ).rejects.toThrow("browser_state_rejected");
  });
  it("revocation blocks previously constructed capability", async () => {
    const { store } = memory();
    let active = true;
    const a = await browserStateCustody(
      binding,
      await key(),
      store,
      async () => active,
    );
    await a.save(secret);
    active = false;
    for (const work of [() => a.load(), () => a.save(secret), () => a.remove()])
      await expect(work()).rejects.toThrow("browser_state_rejected");
  });
  it("rechecks admission after remote read", async () => {
    const { store } = memory();
    let active = true;
    const a = await browserStateCustody(
      binding,
      await key(),
      {
        ...store,
        get: async (k) => {
          const v = await store.get(k);
          active = false;
          return v;
        },
      },
      async () => active,
    );
    await a.save(secret);
    await expect(a.load()).rejects.toThrow("browser_state_rejected");
  });
  it("sanitizes storage/admission failures", async () => {
    const k = await key();
    await expect(
      browserStateCustody(binding, k, memory().store, async () => {
        throw Error("SECRET injected provider error");
      }),
    ).rejects.toThrow("browser_state_unavailable");
    const broken = async (): Promise<never> => {
      throw Error("SECRET");
    };
    const a = await browserStateCustody(
      binding,
      k,
      { get: broken, put: broken, remove: broken },
      async () => true,
    );
    for (const work of [() => a.load(), () => a.save(secret), () => a.remove()])
      await expect(work()).rejects.toThrow("browser_state_unavailable");
  });
  it("removes encrypted state", async () => {
    const { store } = memory(),
      a = await browserStateCustody(
        binding,
        await key(),
        store,
        async () => true,
      );
    await a.save(secret);
    await a.remove();
    expect(await a.load()).toBeNull();
  });
  for (const siteOrigin of [
    "http://example.org",
    "https://example.org/path",
    "https://user:pass@example.org",
    "https://example.org/",
  ])
    it(`rejects noncanonical origin ${siteOrigin}`, async () => {
      await expect(
        browserStateCustody(
          { ...binding, siteOrigin },
          await key(),
          memory().store,
          async () => true,
        ),
      ).rejects.toThrow("browser_state_invalid");
    });
  it("bounds packet size", async () => {
    const a = await browserStateCustody(
      binding,
      await key(),
      memory().store,
      async () => true,
    );
    await expect(a.save(new Uint8Array(1024 * 1024 + 1))).rejects.toThrow(
      "browser_state_invalid",
    );
  });
  it("rejects exportable key", async () => {
    const k = (await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKey;
    await expect(
      browserStateCustody(binding, k, memory().store, async () => true),
    ).rejects.toThrow("browser_state_invalid");
  });
  it("rejects malformed truthy admission", async () => {
    await expect(
      browserStateCustody(
        binding,
        await key(),
        memory().store,
        async () => ({ status: "ok" }) as unknown as boolean,
      ),
    ).rejects.toThrow("browser_state_rejected");
  });
  it("snapshots caller bytes before asynchronous admission", async () => {
    const { store } = memory();
    let input: Uint8Array | undefined;
    const a = await browserStateCustody(
      binding,
      await key(),
      store,
      async () => {
        input?.fill(9);
        return true;
      },
    );
    input = new Uint8Array([1, 2, 3]);
    await a.save(input);
    expect(await a.load()).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("snapshots resizable caller buffer before asynchronous admission", async () => {
    const { store } = memory();
    let buffer: ArrayBuffer | undefined;
    const a = await browserStateCustody(
      binding,
      await key(),
      store,
      async () => {
        if (buffer)
          (buffer as ArrayBuffer & { resize(size: number): void }).resize(
            1024 * 1024 + 1,
          );
        return true;
      },
    );
    const Resizable = ArrayBuffer as unknown as new (
      length: number,
      options: { maxByteLength: number },
    ) => ArrayBuffer;
    buffer = new Resizable(1, { maxByteLength: 1024 * 1024 + 1 });
    const bytes = new Uint8Array(buffer);
    bytes[0] = 7;
    await a.save(bytes);
    expect(await a.load()).toEqual(new Uint8Array([7]));
  });
});
