import { z } from 'zod';
import type { AdminOverview, ConsoleAuth } from '../identity/console-auth';

export const ADMIN_SPEND_DAYS = 30;
export const ADMIN_COST_ROW_CAP = 5000;

const tally = z.number().int().nonnegative();
// What waldo.admin_cost_summary answers an admin: per owner per UTC day, model USD and counts only, never text.
export const adminCostSummarySchema = z.strictObject({
  rows: z.array(z.strictObject({ owner_id: z.uuid(), day: z.iso.date(), usd: z.number().nonnegative(), calls: tally, input_tokens: tally, cached_tokens: tally })).max(ADMIN_COST_ROW_CAP),
  truncated: z.boolean(),
});
export type AdminCostSummary = z.infer<typeof adminCostSummarySchema>;

type Totals = { usd: number; calls: number; input_tokens: number; cached_tokens: number };
export type AdminSpend = Readonly<{ days: number; owners: readonly Readonly<Totals & { owner_id: string; email: string | null }>[]; total: Readonly<Totals>; truncated: boolean }>;
export type AdminSpendSection = AdminSpend | Readonly<{ error: 'unavailable' }>;

// The ledger keeps USD at 8 decimal places; summing floats must not invent digits past that.
const usd = (value: number) => Math.round(value * 1e8) / 1e8;
const add = (into: Totals, row: Totals) => {
  into.usd = usd(into.usd + row.usd); into.calls += row.calls; into.input_tokens += row.input_tokens; into.cached_tokens += row.cached_tokens;
};
const zero = (): Totals => ({ usd: 0, calls: 0, input_tokens: 0, cached_tokens: 0 });

// One line per owner over the window, every owner the overview lists included, then any owner the ledger names that the
// overview does not (email unknown); highest spend first, and a deployment total.
export const adminSpend = (overview: AdminOverview, summary: AdminCostSummary): AdminSpend => {
  const owners = new Map<string, Totals & { owner_id: string; email: string | null }>();
  for (const owner of overview.owners) if (owner.id) owners.set(owner.id, { owner_id: owner.id, email: owner.email, ...zero() });
  const total = zero();
  for (const row of summary.rows) {
    const owner = owners.get(row.owner_id) ?? { owner_id: row.owner_id, email: null, ...zero() };
    add(owner, row); add(total, row);
    owners.set(row.owner_id, owner);
  }
  return { days: ADMIN_SPEND_DAYS, owners: [...owners.values()].sort((a, b) => b.usd - a.usd), total, truncated: summary.truncated };
};

// Read after the overview admitted the caller as admin. A failed read is reported as unavailable, without its cause.
export const adminSpendFor = async (auth: ConsoleAuth, doName: string, overview: AdminOverview): Promise<AdminSpendSection> => {
  try {
    const summary = await auth.adminCostSummary(doName);
    return summary ? adminSpend(overview, summary) : { error: 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  }
};
