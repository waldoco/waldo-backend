import type { ConnectIntent, ToolEligibility } from '@waldo/contracts';

type Feature = NonNullable<ConnectIntent['feature']>;
export type EligibilityReport = Readonly<{ not_connected: number; not_configured: number; check_failed: number; unconnected: readonly Feature[] }>;

// Offer trimming, not authority: a check that throws keeps its tool (counted as check_failed), and call-time auth
// still gates every call. Checks run together so the turn's tool set reflects one moment.
export async function eligibleHandlers<H extends Readonly<{ name: string; eligible?(): ToolEligibility | Promise<ToolEligibility> }>>(handlers: readonly H[]): Promise<Readonly<{ handlers: H[]; report: EligibilityReport }>> {
  const verdicts = await Promise.all(handlers.map(async handler => {
    try { return handler.eligible ? await handler.eligible() : undefined; } catch { return null; }
  }));
  const report = { not_connected: 0, not_configured: 0, check_failed: 0 };
  const unconnected = new Set<Feature>();
  const kept = handlers.filter((_handler, index) => {
    const verdict = verdicts[index];
    if (verdict === null) report.check_failed += 1;
    if (!verdict || verdict.ok) return true;
    report[verdict.reason] += 1;
    if (verdict.reason === 'not_connected' && verdict.connect.feature) unconnected.add(verdict.connect.feature);
    return false;
  });
  return { handlers: kept, report: { ...report, unconnected: [...unconnected].sort() } };
}
