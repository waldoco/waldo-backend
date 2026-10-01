// Advisory check: a structured "done" claim must be backed by a successful tool receipt of the
// same effect (and the same ref when the claim names one) earlier in the same turn. It reads
// structured data only: no text is parsed, so it makes no judgment about wording. Advisory and
// unwired; where claims come from (a typed field on the reply) is a separate, reviewed step.
export type ToolReceipt = { readonly seq: number; readonly tool: string; readonly effect: string; readonly ok: boolean; readonly ref?: string };
export type DoneClaim = { readonly seq: number; readonly effect: string; readonly ref?: string };
export type ClaimFinding = { readonly claim_seq: number; readonly effect: string; readonly reason: 'no_matching_receipt' };

export const checkClaimsAgainstReceipts = (claims: readonly DoneClaim[], receipts: readonly ToolReceipt[]): readonly ClaimFinding[] => {
  const used = new Set<number>();
  const findings: ClaimFinding[] = [];
  for (const claim of [...claims].sort((a, b) => a.seq - b.seq)) {
    const index = receipts.findIndex((r, i) => !used.has(i) && r.ok && r.seq < claim.seq && r.effect === claim.effect && (claim.ref === undefined || r.ref === claim.ref));
    if (index === -1) findings.push({ claim_seq: claim.seq, effect: claim.effect, reason: 'no_matching_receipt' });
    else used.add(index);
  }
  return findings;
};
