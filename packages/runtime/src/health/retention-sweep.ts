import { md5Hex } from '../channels/md5';

// The scheduled caller of waldo.health_retention_sweep. Each round ages out one bounded page of owners who hold expired
// health rows, whatever state they are in; the database reports whether more remain. The rounds are capped so one run
// cannot loop forever, and the next scheduled run picks up where this one stopped.
export type SweepRpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
export type SweepOutcome = Readonly<{ state: 'complete' | 'incomplete' | 'failed' | 'unconfigured'; owners: number; rounds: number }>;

const PAGE = 50;
const MAX_ROUNDS = 20;

export const sweepHealthRetention = async (rpc: SweepRpc | null): Promise<SweepOutcome> => {
  if (!rpc) return { state: 'unconfigured', owners: 0, rounds: 0 };
  const payload = JSON.stringify({ limit: PAGE });
  let owners = 0;
  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    let answer: unknown;
    try { answer = await rpc('health_retention_sweep', `health.retention_sweep.${md5Hex(payload)}`, { p_payload: payload }); } catch { return { state: 'failed', owners, rounds }; }
    const page = answer && typeof answer === 'object' ? answer as Record<string, unknown> : null;
    if (!page || !Number.isSafeInteger(page.owners) || (page.owners as number) < 0 || typeof page.more !== 'boolean') return { state: 'failed', owners, rounds };
    owners += page.owners as number;
    rounds += 1;
    if (!page.more) return { state: 'complete', owners, rounds };
  }
  return { state: 'incomplete', owners, rounds };
};
