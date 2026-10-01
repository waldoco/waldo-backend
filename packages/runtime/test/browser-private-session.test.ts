import { it, expect } from "vitest";
import {
  privateBrowserSession,
  type PrivateStateCustody,
} from "../src/channels/browser-private-session";
const fixture = (fail = "") => {
  const log: string[] = [];
  let stored: Uint8Array | null = new TextEncoder().encode('{"cookies":[]}');
  const action = async (label: string) => {
    log.push(label);
    if (label === fail) throw Error("SECRET provider instruction");
  };
  const custody: PrivateStateCustody = {
    load: async () => {
      await action("load");
      return stored;
    },
    save: async (value) => {
      await action("persist");
      stored = value;
    },
  };
  const options = {
    custody,
    launch: async () => {
      await action("launch");
      return {
        newContext: async (input: { storageState?: unknown }) => {
          await action("context");
          expect(input.storageState).toEqual({ cookies: [] });
          return {
            value: "private",
            storageState: async (input: { indexedDB: true }) => {
              expect(input.indexedDB).toBe(true);
              await action("extract");
              return { cookies: [{ value: "SECRET" }] };
            },
            close: () => action("close-context"),
          };
        },
        close: () => action("close-browser"),
      };
    },
    installPolicy: () => action("policy"),
    work: async () => {
      await action("work");
      return "public receipt";
    },
  };
  return {
    log,
    options,
    get stored() {
      return stored;
    },
  };
};
it("restores private state, policy before work, saves on success and closes all", async () => {
  const f = fixture();
  expect(await privateBrowserSession(f.options)).toEqual({
    status: "ok",
    value: "public receipt",
    persistence: "saved",
  });
  expect(f.log).toEqual([
    "load",
    "launch",
    "context",
    "policy",
    "work",
    "extract",
    "persist",
    "close-context",
    "close-browser",
  ]);
  expect(new TextDecoder().decode(f.stored!)).toContain("SECRET");
});
for (const phase of ["load", "launch", "context", "policy", "work", "persist"])
  it(`sanitizes ${phase} failure and always closes created resources`, async () => {
    const f = fixture(phase);
    expect(await privateBrowserSession(f.options)).toEqual({
      status: "failed",
      phase,
    });
    if (["policy", "work", "persist"].includes(phase))
      expect(f.log.slice(-2)).toEqual(["close-context", "close-browser"]);
    if (phase === "context") expect(f.log.at(-1)).toEqual("close-browser");
  });
it("snapshot failure skips save and closes", async () => {
  const f = fixture("extract");
  expect(await privateBrowserSession(f.options)).toEqual({
    status: "failed",
    phase: "persist",
  });
  expect(f.log).not.toContain("persist");
  expect(f.log.slice(-2)).toEqual(["close-context", "close-browser"]);
});
for (const fail of ["close-context", "close-browser"])
  it(`reports cleanup failure without retrying work: ${fail}`, async () => {
    const f = fixture(fail);
    expect(await privateBrowserSession(f.options)).toEqual({
      status: "failed",
      phase: "cleanup",
    });
    expect(f.log.filter((x) => x === "work")).toHaveLength(1);
    expect(f.log).toContain("close-browser");
  });
it("persistence-disabled session neither loads nor writes secret state", async () => {
  const f = fixture();
  f.options.launch = async () => ({
    newContext: async (input) => {
      expect(input).toEqual({});
      return {
        value: "private",
        storageState: async () => {
          throw Error("must not snapshot");
        },
        close: async () => {},
      };
    },
    close: async () => {},
  });
  expect(await privateBrowserSession({ ...f.options, custody: null })).toEqual({
    status: "ok",
    value: "public receipt",
    persistence: "disabled",
  });
  expect(f.log).toEqual(["policy", "work"]);
});
it("malformed decrypted JSON fails before launch", async () => {
  const f = fixture();
  expect(
    await privateBrowserSession({
      ...f.options,
      custody: {
        ...f.options.custody,
        load: async () => new Uint8Array([255]),
      },
    }),
  ).toEqual({ status: "failed", phase: "load" });
  expect(f.log).toEqual([]);
});
