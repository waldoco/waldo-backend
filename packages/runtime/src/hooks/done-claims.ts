import { z } from 'zod';
import { toolParameters, type LLMTool } from '@waldo/contracts';
import { TOOL_CLAIM_EFFECT } from './claim-verify-effects';
import { evaluateTurnClaims, receiptsFromLoopEvents, REF_EFFECTS, type LoopEventLike } from './claim-hook';
import type { ClaimFinding, DoneClaim } from './claim-verify-lint';

// Where a reply's done-claims come from: the model declares each effect its reply reports as done with note_done,
// a host-built tool that changes nothing. The host reads no reply wording; it checks the declared claims against
// the turn's typed receipts before the reply reaches the owner.
export const NOTE_DONE = 'note_done';

export const CLAIMABLE_EFFECTS = [...new Set(Object.values(TOOL_CLAIM_EFFECT).filter((effect): effect is string => effect !== null))].sort() as [string, ...string[]];

export const noteDoneArgsSchema = z.strictObject({
  effect: z.enum(CLAIMABLE_EFFECTS),
  ref: z.string().min(1).max(200).optional(),
});

export const NOTE_DONE_TOOL: LLMTool = {
  name: NOTE_DONE,
  description: 'Declare an effect your reply reports as done (sent, set, saved, booked, proposed, created). Call it once per such effect, in the same response as the reply text. It changes nothing: the host checks each declaration against this turn\'s tool receipts before the owner sees the reply. Do not call it for things you only plan, offer or could not do. ref is the file path, for a written or rendered workspace file only.',
  parameters: toolParameters(noteDoneArgsSchema),
};

export const NOTE_DONE_INSTRUCTION = 'When your reply says you did something this turn (sent, set, saved, proposed, created), call note_done for each such effect in the same response as the reply. The host checks each one against this turn\'s tool receipts; an effect with no receipt is shown to the owner as not confirmed.';

const REASON_WORDS: Record<ClaimFinding['reason'], string> = { no_matching_receipt: 'nothing ran', receipt_failed: 'it failed', receipt_unresolved: 'outcome unknown' };
const label = (effect: string) => effect.split('_').join(' ');

export type DoneClaimDesk = Readonly<{
  tool: LLMTool;
  // Records one note_done call and returns what the model reads as its result, including this claim's finding.
  note: (args: string) => string;
  // Host facts for the turn's one revision, or null when every standing claim is backed (or the check cannot run).
  revision: () => string | null;
  // The revised reply replaces the old one, so its declarations replace the old claims.
  supersede: () => void;
  // The line delivered with the reply when a standing claim is still unbacked. A check that throws lists every claim.
  notice: () => string | null;
}>;

export const doneClaimDesk = (events: () => readonly LoopEventLike[], evaluate: typeof evaluateTurnClaims = evaluateTurnClaims): DoneClaimDesk => {
  let claims: DoneClaim[] = [];
  const findings = (): readonly ClaimFinding[] | null => {
    try { return evaluate(claims, events()); } catch { return null; }
  };
  return {
    tool: NOTE_DONE_TOOL,
    note: (raw) => {
      let args: unknown;
      try { args = JSON.parse(raw || '{}'); } catch { args = undefined; }
      const parsed = noteDoneArgsSchema.safeParse(args);
      if (!parsed.success) return JSON.stringify({ ok: false, error: `note_done needs effect, one of: ${CLAIMABLE_EFFECTS.join(', ')}.` });
      // A claim can be backed only by a receipt that landed before it.
      // Only a file receipt carries a ref; a ref on any other effect has nothing to match, so it is dropped.
      const ref = REF_EFFECTS.has(parsed.data.effect) ? parsed.data.ref : undefined;
      const claim: DoneClaim = { seq: events().length + 1, effect: parsed.data.effect, ...(ref ? { ref } : {}) };
      claims.push(claim);
      const all = findings();
      const own = all?.find(finding => finding.claim_seq === claim.seq && finding.effect === claim.effect);
      return JSON.stringify(all === null ? { ok: true, noted: true, backed: false, finding: 'check_unavailable' } : own ? { ok: true, noted: true, backed: false, finding: own.reason } : { ok: true, noted: true, backed: true });
    },
    revision: () => {
      if (claims.length === 0) return null;
      const open = findings();
      if (open === null || open.length === 0) return null;
      const receipts = receiptsFromLoopEvents(events()).map(receipt => `${receipt.effect}${receipt.ref ? ` ${receipt.ref}` : ''} ${receipt.state ?? (receipt.ok ? 'accepted' : 'failed')}`);
      return `[host facts: your reply reports as done effects with no accepted receipt this turn: ${open.map(finding => `${finding.effect} (${finding.reason})`).join('; ')}. Receipts this turn: ${receipts.length ? receipts.join('; ') : 'none'}. Rewrite the reply so it says only what happened. Call note_done again for each effect the rewritten reply still reports as done. No other tool runs now.]`;
    },
    supersede: () => { claims = []; },
    notice: () => {
      if (claims.length === 0) return null;
      const open = findings();
      const items = open === null ? claims.map(claim => `${label(claim.effect)} (not checked)`) : open.map(finding => `${label(finding.effect)} (${REASON_WORDS[finding.reason]})`);
      return items.length ? `Not confirmed: ${[...new Set(items)].join('; ')}` : null;
    },
  };
};
