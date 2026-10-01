// Narrow read projection for the dashboard memory page: held spots, retired spots, removals that
// need a retry, gate holds and the profile. Pure function over memory state, never ConsoleView.
// CSRF is never in this JSON; writes stay on the existing console actions (spot.confirm, spot.dismiss,
// spot.forget), which carry the session CSRF the console page already issues. `allowed_actions`
// mirrors exactly what the console renders for each row. Spot text, evidence and profile lines are
// owner-visible memory content and may hold untrusted-derived text: render as inert text.
import type { Claim } from '../memory/claims';

export const DASHBOARD_MEMORY_PATH = '/console/dashboard/api/v1/memory';

const SOURCE_LABEL: Readonly<Record<string, string>> = { stated: 'You said this', confirmed: 'You confirmed this', inferred: "Waldo's inference" };
const day = (iso: string) => iso.slice(0, 10);
type Action = 'spot.confirm' | 'spot.dismiss' | 'spot.forget';

const spot = (claim: Claim, allowed: readonly Action[]) => ({
  id: claim.id, kind: claim.kind, text: claim.text, evidence: claim.evidence, status: claim.status,
  source: claim.source, source_label: SOURCE_LABEL[claim.source] ?? 'Source unverified',
  provisional: claim.source === 'inferred' || !SOURCE_LABEL[claim.source],
  from_shared_content: claim.origin === 'untrusted',
  provenance: claim.verification_status === 'owner-grounded' ? 'owner-grounded' as const : 'unverified' as const,
  // Same shape gate as the console: only an owner Telegram source id is ever shown.
  source_id: claim.source_ref && /^owner, tg-[\w-]+$/.test(claim.source_ref) ? claim.source_ref : null,
  valid_until: claim.valid_to ? day(claim.valid_to) : null,
  seen_count: claim.seen_count, last_seen: day(claim.last_seen_at),
  allowed_actions: allowed,
});

export const dashboardMemory = (input: Readonly<{
  now: number; spots: readonly Claim[]; retired: readonly Claim[]; forgetting: readonly Claim[];
  holds: readonly Readonly<{ id: number; kind: string; reason: string; created_at: string }>[];
  profile: readonly Readonly<{ title: string; lines: readonly string[] }>[];
}>) => ({
  version: 1 as const,
  as_of: new Date(input.now).toISOString(),
  spots: input.spots.map((claim) => spot(claim, claim.source === 'inferred' ? ['spot.confirm', 'spot.dismiss', 'spot.forget'] : ['spot.dismiss', 'spot.forget'])),
  // Console parity: dismissed/promoted rows show only the text and status; no evidence, source or provenance.
  retired: input.retired.map((claim) => ({ id: claim.id, text: claim.text, status: claim.status, allowed_actions: [] as readonly Action[] })),
  // A removal stuck mid-scrub stays visible with a retry; the console shows the text and Forget, nothing else.
  forgetting: input.forgetting.map((claim) => ({ id: claim.id, text: claim.text, status: claim.status, allowed_actions: ['spot.forget'] as readonly Action[] })),
  holds: input.holds.map((hold) => ({ id: hold.id, kind: hold.kind, reason: hold.reason, created_at: day(hold.created_at) })),
  profile: input.profile.map((section) => ({ title: section.title, lines: [...section.lines] })),
});
