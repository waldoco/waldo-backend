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
  signal?: AbortSignal;
  cleanupTimeoutMs?: number;
}): Promise<PrivateSessionOutcome<T>> {
  const step = async <V>(work: () => Promise<V>, late?: (value: V) => Promise<void>): Promise<V> => {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (!signal) return work();
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(Error('browser_private_interrupted')); });
    signal.addEventListener('abort', abort, { once: true });
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return work(); });
    void pending.then(value => { if (signal.aborted && late) void late(value).catch(() => {}); }, () => {});
    try { return await Promise.race([pending, interrupted]); }
    finally { signal.removeEventListener('abort', abort); }
  };
  let phase: Exclude<PrivateSessionOutcome<T>, { status: "ok" }>["phase"] =
    "load";
  let browser: PrivateBrowser<C> | undefined,
    context: PrivateBrowserContext<C> | undefined;
  let outcome: PrivateSessionOutcome<T>;
  try {
    const bytes = await step(async () => options.custody?.load());
    const state = bytes
      ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
      : undefined;
    phase = "launch";
    browser = await step(options.launch, late => late.close());
    phase = "context";
    context = await step(() => browser!.newContext(
      state === undefined ? {} : { storageState: state },
    ), late => late.close());
    phase = "policy";
    await step(() => options.installPolicy(context!.value));
    phase = "work";
    const value = await step(() => options.work(context!.value));
    if (options.custody) {
      phase = "persist";
      const state = await step(() => context!.storageState({ indexedDB: true }));
      await step(() => options.custody!.save(
        new TextEncoder().encode(JSON.stringify(state)),
      ));
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
  const cleanup = Promise.allSettled([...(context ? [Promise.resolve().then(() => context!.close())] : []), ...(browser ? [Promise.resolve().then(() => browser!.close())] : [])]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = options.cleanupTimeoutMs;
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10000)) throw Error('browser cleanup timeout invalid');
    const results = await (timeout === undefined ? cleanup : Promise.race([cleanup, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('browser cleanup timeout')), timeout); })]));
    cleanupFailed = results.some(result => result.status === 'rejected');
  } catch { cleanupFailed = true; }
  finally { if (timer !== undefined) clearTimeout(timer); }
  // Preserve original failure phase. A successful work callback is not repeated
  // automatically if persistence or cleanup failed; it may have performed an effect.
  if (cleanupFailed && outcome.status === "ok")
    return { status: "failed", phase: "cleanup" };
  return outcome;
}
