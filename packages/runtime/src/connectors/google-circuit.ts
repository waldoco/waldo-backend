// Circuit breaker for dead Google grants: a failing account (invalid_grant recorded in google:health) is not
// retried on every sweep. It is skipped until a probe window elapses, then tried once; success clears health.
export const GOOGLE_PROBE_MS = 6 * 60 * 60 * 1000;
export const googleCircuit = (input: Readonly<{ failing: Readonly<Record<string, string>>; probes: Readonly<Record<string, number>>; now: number; ids: readonly string[] }>) => {
  const usable: string[] = [], probe: string[] = [], skipped: string[] = [];
  for (const id of input.ids) {
    if (!input.failing[id]) { usable.push(id); continue; }
    const last = input.probes[id];
    if (last === undefined || input.now - last >= GOOGLE_PROBE_MS) { usable.push(id); probe.push(id); } else skipped.push(id);
  }
  return { usable, probe, skipped };
};
