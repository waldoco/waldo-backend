// Each owner's monthly spend ceiling in USD. Past it an owner turn degrades to the auxiliary model and paid tools are held.
// It is inert while WALDO_COST_LEDGER_SYNC is off, since nothing counts the month.
// The month's spend is counted by observability/cost-rollup.ts (DO KV, synced to Supabase's waldo.cost_ledger_daily).
// An invited owner's ceiling is OWNER_SPEND_CEILING_USD; an open sign-up owner's is identity/open-signup.ts's.
export const MONTHLY_SPEND_CEILING_USD = 25;

// A configured ceiling: a plain positive decimal amount, or undefined so the caller keeps its fallback.
export const positiveUsd = (raw: string | undefined): number | undefined => {
  const value = Number(raw);
  return /^[0-9]+(\.[0-9]+)?$/.test(raw ?? '') && value > 0 ? value : undefined;
};

// An invited owner's monthly ceiling, or MONTHLY_SPEND_CEILING_USD when the setting is unset or not a positive amount.
export const ownerCeilingUsd = (env: Readonly<{ OWNER_SPEND_CEILING_USD?: string }>): number =>
  positiveUsd(env.OWNER_SPEND_CEILING_USD) ?? MONTHLY_SPEND_CEILING_USD;
