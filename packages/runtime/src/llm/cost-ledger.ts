// Each owner's monthly spend ceiling in USD; the owner can change it here. Past it an owner turn degrades to the
// auxiliary model and paid tools are held. It is inert while WALDO_COST_LEDGER_SYNC is off, since nothing counts the month.
// The month's spend is counted by observability/cost-rollup.ts (DO KV, synced to Supabase's waldo.cost_ledger_daily).
export const MONTHLY_SPEND_CEILING_USD = 25;
