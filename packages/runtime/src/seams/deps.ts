// The sole home for the tracer's non-deterministic primitives: clock, id generation, and
// hashing. Trace modules take Deps by injection and never reach for Date.now /
// crypto.randomUUID / crypto.subtle directly, so a crash/resume run is replayable under a
// test Deps with a fixed clock and fixed ids.
export interface Deps {
  now(): number;
  newRunId(): string;
  newOutboxId(): string;
  sha256Hex(input: string): Promise<string>;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function productionDeps(): Deps {
  return {
    now: () => Date.now(),
    newRunId: () => crypto.randomUUID(),
    newOutboxId: () => crypto.randomUUID(),
    sha256Hex,
  };
}
