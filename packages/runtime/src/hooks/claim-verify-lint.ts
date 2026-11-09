import type { TrustedToolExecutionResult } from '@waldo/contracts';

// Advisory check: a structured "done" claim must be backed by an accepted tool receipt of the
// same effect (and the same ref when the claim names one) earlier in the same turn. It reads
// structured data only: no text is parsed, so it makes no judgment about wording. Advisory and
// unwired; where claims come from (a typed field on the reply) is a separate, reviewed step.
//
// A receipt's state comes only from the tool result types that already exist: ok:true is
// 'accepted' (the tool accepted the effect; this is NOT proof the source system holds it, and
// there is no read-back source yet, so nothing here says 'verified'), ok:false is 'failed', and the
// existing receipt_status:'unavailable' result is 'unresolved' (the effect may or may not have
// happened and cannot be recovered). A finding says which of those explains the gap.
export type ReceiptState = 'accepted' | 'failed' | 'unresolved';
export type ToolReceipt = { readonly seq: number; readonly tool: string; readonly effect: string; readonly ok: boolean; readonly ref?: string; readonly state?: ReceiptState; readonly delegated?: boolean };
export type DoneClaim = { readonly seq: number; readonly effect: string; readonly ref?: string };
export type ClaimFinding = { readonly claim_seq: number; readonly effect: string; readonly reason: 'no_matching_receipt' | 'receipt_failed' | 'receipt_unresolved' };

const stateOf = (receipt: ToolReceipt): ReceiptState => receipt.state ?? (receipt.ok ? 'accepted' : 'failed');

export const receiptFromToolResult = (base: Pick<ToolReceipt, 'seq' | 'tool' | 'effect' | 'ref'>, result: TrustedToolExecutionResult<unknown>): ToolReceipt => {
  const state: ReceiptState = result.ok ? 'accepted' : 'receipt_status' in result && result.receipt_status === 'unavailable' ? 'unresolved' : 'failed';
  return { ...base, ok: result.ok, state };
};

export const checkClaimsAgainstReceipts = (claims: readonly DoneClaim[], receipts: readonly ToolReceipt[]): readonly ClaimFinding[] => {
  const used = new Set<number>();
  const findings: ClaimFinding[] = [];
  for (const claim of [...claims].sort((a, b) => a.seq - b.seq)) {
    const candidates = receipts.flatMap((r, i) => r.seq < claim.seq && r.effect === claim.effect && (claim.ref === undefined || r.ref === claim.ref) ? [{ r, i }] : []);
    const accepted = candidates.find(({ r, i }) => !used.has(i) && stateOf(r) === 'accepted');
    if (accepted) { used.add(accepted.i); continue; }
    const reason = candidates.some(({ r }) => stateOf(r) === 'unresolved') ? 'receipt_unresolved' : candidates.some(({ r }) => stateOf(r) === 'failed') ? 'receipt_failed' : 'no_matching_receipt';
    findings.push({ claim_seq: claim.seq, effect: claim.effect, reason });
  }
  return findings;
};
