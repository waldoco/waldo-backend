// Host-only driver orchestration. The host owns authenticated opt-in, effect
// approvals and URL/egress policy. Never export the context/state as a tool result.
export type PrivateBrowserContext<T> = Readonly<{
  storageState(options: { indexedDB: true }): Promise<unknown>;
  close(): Promise<void>;
  value: T;
}>;
export type PrivateBrowser<T> = Readonly<{
  newContext(options: {
    storageState?: unknown;
  }): Promise<PrivateBrowserContext<T>>;
  close(): Promise<void>;
}>;
export type PrivateStateCustody = Readonly<{
  load(): Promise<Uint8Array | null>;
  save(state: Uint8Array): Promise<void>;
}>;
export type PrivateSessionOutcome<T> =
  | Readonly<{ status: "ok"; value: T; persistence: "saved" | "disabled" }>
  | Readonly<{
      status: "failed";
      phase:
        | "load"
        | "launch"
        | "context"
        | "policy"
        | "work"
        | "persist"
        | "cleanup";
    }>;
// The generic callback is trusted host code, not LLM-provided code. A later
// adapter binds this interface to CF Playwright; fake-driver tests prove lifecycle only.
export async function privateBrowserSession<C, T>(options: {
  custody: PrivateStateCustody | null;
  launch(): Promise<PrivateBrowser<C>>;
  installPolicy(context: C): Promise<void>;
  work(context: C): Promise<T>;
}): Promise<PrivateSessionOutcome<T>> {
  let phase: Exclude<PrivateSessionOutcome<T>, { status: "ok" }>["phase"] =
    "load";
  let browser: PrivateBrowser<C> | undefined,
    context: PrivateBrowserContext<C> | undefined;
  let outcome: PrivateSessionOutcome<T>;
  try {
    const bytes = await options.custody?.load();
    const state = bytes
      ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
      : undefined;
    phase = "launch";
    browser = await options.launch();
    phase = "context";
    context = await browser.newContext(
      state === undefined ? {} : { storageState: state },
    );
    phase = "policy";
    await options.installPolicy(context.value);
    phase = "work";
    const value = await options.work(context.value);
    if (options.custody) {
      phase = "persist";
      const state = await context.storageState({ indexedDB: true });
      await options.custody.save(
        new TextEncoder().encode(JSON.stringify(state)),
      );
    }
    outcome = {
      status: "ok",
      value,
      persistence: options.custody ? "saved" : "disabled",
    };
  } catch {
    outcome = { status: "failed", phase };
  }
  let cleanupFailed = false;
  if (context)
    try {
      await context.close();
    } catch {
      cleanupFailed = true;
    }
  if (browser)
    try {
      await browser.close();
    } catch {
      cleanupFailed = true;
    }
  // Preserve original failure phase. A successful work callback is not repeated
  // automatically if persistence or cleanup failed; it may have performed an effect.
  if (cleanupFailed && outcome.status === "ok")
    return { status: "failed", phase: "cleanup" };
  return outcome;
}
