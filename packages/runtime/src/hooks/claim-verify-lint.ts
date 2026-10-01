// Advisory lint: a reply that claims a completed effect ("saved", "sent", "booked") should follow
// a successful verification call in the same turn. Heuristic and advisory only: it never blocks
// a reply and never decides truth. The caller supplies the verifier tool names; an empty list
// fails closed (every claim is flagged) rather than guessing which tools verify.
export type TurnStep =
  | { readonly kind: 'tool_call'; readonly name: string; readonly ok: boolean }
  | { readonly kind: 'reply'; readonly text: string };

export type ClaimFinding = { readonly step: number; readonly claim: string; readonly reason: 'no_verification_before_claim' };

const CLAIM = /\b(saved|sent|booked|scheduled|created|deleted|forgotten|updated|added|removed|cancell?ed|moved)\b/i;
const NEGATION = /\b(couldn'?t|could not|can'?t|cannot|didn'?t|did not|wasn'?t|was not|not|never|nothing was|failed|unable)\b/i;

export const lintClaimsAgainstVerification = (steps: readonly TurnStep[], verifiers: readonly string[]): readonly ClaimFinding[] => {
  const known = new Set(verifiers);
  const findings: ClaimFinding[] = [];
  let verified = false;
  steps.forEach((step, index) => {
    if (step.kind === 'tool_call') {
      if (step.ok && known.has(step.name)) verified = true;
      return;
    }
    // Sentence-level so "I saved it" is checked even next to a question or a negated sentence.
    for (const sentence of step.text.split(/(?<=[.!?])\s+/)) {
      if (sentence.trim().endsWith('?') || NEGATION.test(sentence)) continue;
      const match = CLAIM.exec(sentence);
      if (match && !verified) { findings.push({ step: index, claim: match[1]!.toLowerCase(), reason: 'no_verification_before_claim' }); break; }
    }
  });
  return findings;
};
