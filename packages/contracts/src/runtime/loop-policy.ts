import { z } from 'zod';

// ADR-0074 Loop Governor — the deterministic cross-loop governance seam. This contract pins the
// LoopPolicy manifest (the single per-loop record the Governor reads), the acute-health-first
// arbiter precedence, the fail-closed admission verdict, and the terminal loop disposition. The
// arbiter comparator, per-run budget/kill enforcement, within-run dedup, and cross-run no-progress
// guard are runtime concerns behind this vocabulary (they read a DO SQLite loop_progress table) and
// land with the runtime, not the contract. Delivery admission (send/hold/degrade/drop) is ADR-0068's
// separate DeliveryGate seam: the Governor decides which loop runs, the gate decides the send.

// The governor admits or denies a loop into a window. Deterministic, outside the LLM — an LLM cannot
// be trusted to stop itself (ADR-0074). This is loop ADMISSION, deliberately distinct from the
// ADR-0068 delivery verdict; conflating the two seams is the rejected option.
export const admissionVerdictSchema = z.enum(['admit', 'deny']);
export type GovernorVerdict = z.infer<typeof admissionVerdictSchema>;

// The seven loops Waldo runs (ADR-0074 §Context). Distinct from TriggerType: a loop is not a
// trigger — handoff_*, pre_brief_sweep, and user_message are trigger types, not top-level loops —
// so this deliberately does not reuse triggerTypeSchema. Ordered by arbiter precedence, then the
// two routine loops, then interactive chat.
export const loopTypeSchema = z.enum([
  'fetch',
  'intervention',
  'pre_activity_spot',
  'brief',
  'patrol',
  'dreaming',
  'chat',
]);
export type LoopType = z.infer<typeof loopTypeSchema>;

// Arbiter precedence classes — acute-health-first (ADR-0074 §Move1.1). Governs WHICH loop executes
// when loops contend a window; composes with (does not duplicate) ADR-0068, which governs the send.
// The two routine loops (patrol, dreaming) collapse into 'routine'; interactive chat is not a
// window-contended tier and has no class here.
export const priorityTierSchema = z.enum([
  'fetch',
  'intervention',
  'pre_activity_spot',
  'brief',
  'routine',
]);
export type PriorityTier = z.infer<typeof priorityTierSchema>;

// Total order, lower rank preempts (ADR-0074 §Move1.1, verbatim). This is the declarative arbiter
// contract; the comparator that applies it (with occurrence-time tie-break, ADR-0074 §concurrent)
// lands with the runtime arbiter that consumes the loop_progress table.
export const priorityTierRank: Readonly<Record<PriorityTier, number>> = {
  fetch: 1,
  intervention: 2,
  pre_activity_spot: 3,
  brief: 4,
  routine: 5,
};

// A loop_kill flag short-circuits the loop before its next LLM call (ADR-0074 §Move1.2). Scope is
// per-loop or fleet-global; the flag is operator-only — no LLM tool path can clear it.
export const killFlagScopeSchema = z.enum(['loop', 'global']);
export type KillFlagScope = z.infer<typeof killFlagScopeSchema>;

// Open a live socket ONLY during an active chat, never as the idle transport (ADR-0074 §Move1.5 —
// the $0.03→$4.05/user/mo cost cliff). Every non-chat loop is 'none'.
export const socketResidencySchema = z.enum(['active-chat-only', 'none']);
export type SocketResidency = z.infer<typeof socketResidencySchema>;

// Move-2 autonomy ladder (ADR-0074 §Move2): L0 immutable (soul/CRS/safety — never ratchets),
// L1 observe, L2 propose+measure+human-approve, L3 unattended low-stakes behind a graduation gate.
// Every V1 loop is L0; L1–L3 activation is Phase-G. The field is pinned now so the runtime inherits it.
export const autonomyLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3']);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

// Terminal loop disposition (ADR-0074 §Move1.3). The max-iteration cap forces 'couldnt_converge'
// rather than a silent infinite loop; the kill flag yields 'killed'; the cross-run diversity∧success
// guard logs 'no_progress' instead of re-spending every cycle.
export const loopDispositionSchema = z.enum([
  'converged',
  'couldnt_converge',
  'killed',
  'no_progress',
]);
export type LoopDisposition = z.infer<typeof loopDispositionSchema>;

// The ADR-0074 LoopPolicy manifest — the uniform per-loop record the Governor reads (§manifest).
// One representation for every cross-loop concern: arbiter tier, the three per-run bounds, kill
// scope, socket residency, egress gate, autonomy level, and cooldown. Strict: an unknown field is
// a policy that some producer misunderstood, so it is rejected rather than silently ignored.
export const loopPolicySchema = z.strictObject({
  name: z.string().min(1),
  loop_type: loopTypeSchema,
  priority_tier: priorityTierSchema,
  max_tokens_per_run: z.int().positive(),
  max_subagent_spawns_per_run: z.int().nonnegative(),
  max_iterations_per_run: z.int().positive(),
  kill_flag_scope: killFlagScopeSchema,
  socket_residency: socketResidencySchema,
  egress_gated: z.boolean(),
  autonomy_level: autonomyLevelSchema,
  cooldown_min: z.int().nonnegative(),
});
export type LoopPolicy = z.infer<typeof loopPolicySchema>;

// Initial per-loop policies. The manifest SHAPE is the contract; the numeric budgets are starting
// config, tunable without an ADR (ADR-0074 §Reversibility: "LoopPolicy is config; thresholds tune
// without an ADR"). Grounding of the fixed fields: priority_tier follows the §Move1.1 arbiter;
// the two routine loops carry the tightest token budgets because they are the token-explosion risk
// the Governor exists to bound (§What breaks at 10k users); egress_gated is true for every loop
// that can reach an external send and false for dreaming, which only writes memory via the Scribe;
// socket_residency is 'none' for all six proactive loops (chat is the only 'active-chat-only' loop,
// and chat is not registered here — see below); every V1 loop is autonomy L0.
//
// 'chat' is deliberately absent: its arbiter tier is not pinned by ADR-0074 (an interactive loop is
// not window-contended), so it stays an open decision. A lookup for it therefore returns null and
// admit() denies fail-closed — the correct posture until chat's policy is decided and registered.
export const LOOP_POLICIES: Readonly<Partial<Record<LoopType, LoopPolicy>>> = {
  fetch: {
    name: 'fetch',
    loop_type: 'fetch',
    priority_tier: 'fetch',
    max_tokens_per_run: 16_000,
    max_subagent_spawns_per_run: 0,
    max_iterations_per_run: 8,
    kill_flag_scope: 'loop',
    socket_residency: 'none',
    egress_gated: true,
    autonomy_level: 'L0',
    cooldown_min: 120,
  },
  intervention: {
    name: 'intervention',
    loop_type: 'intervention',
    priority_tier: 'intervention',
    max_tokens_per_run: 16_000,
    max_subagent_spawns_per_run: 0,
    max_iterations_per_run: 8,
    kill_flag_scope: 'loop',
    socket_residency: 'none',
    egress_gated: true,
    autonomy_level: 'L0',
    cooldown_min: 120,
  },
  pre_activity_spot: {
    name: 'pre_activity_spot',
    loop_type: 'pre_activity_spot',
    priority_tier: 'pre_activity_spot',
    max_tokens_per_run: 12_000,
    max_subagent_spawns_per_run: 0,
    max_iterations_per_run: 6,
    kill_flag_scope: 'loop',
    socket_residency: 'none',
    egress_gated: true,
    autonomy_level: 'L0',
    cooldown_min: 60,
  },
  brief: {
    name: 'brief',
    loop_type: 'brief',
    priority_tier: 'brief',
    max_tokens_per_run: 24_000,
    max_subagent_spawns_per_run: 2,
    max_iterations_per_run: 10,
    kill_flag_scope: 'loop',
    socket_residency: 'none',
    egress_gated: true,
    autonomy_level: 'L0',
    cooldown_min: 0,
  },
  patrol: {
    name: 'patrol',
    loop_type: 'patrol',
    priority_tier: 'routine',
    max_tokens_per_run: 6_000,
    max_subagent_spawns_per_run: 0,
    max_iterations_per_run: 4,
    kill_flag_scope: 'loop',
    socket_residency: 'none',
    egress_gated: true,
    autonomy_level: 'L0',
    cooldown_min: 15,
  },
  dreaming: {
    name: 'dreaming',
    loop_type: 'dreaming',
    priority_tier: 'routine',
    max_tokens_per_run: 20_000,
    max_subagent_spawns_per_run: 3,
    max_iterations_per_run: 12,
    kill_flag_scope: 'loop',
    socket_residency: 'none',
    egress_gated: false,
    autonomy_level: 'L0',
    cooldown_min: 0,
  },
};

// Fail-closed lookup: a loop with no registered policy — an unknown name, or a known loop whose
// policy is still an open decision (chat) — returns null.
export function lookupLoopPolicy(loopType: LoopType): LoopPolicy | null {
  return LOOP_POLICIES[loopType] ?? null;
}

// The deterministic admission gate. A loop with no LoopPolicy is DENIED (ADR-0074 §null failure
// path: fail-closed — no unbounded loop ships). A loop with a policy is admitted at the contract
// layer; the runtime Governor layers the per-run budget, kill-flag, and no-progress checks on top.
export function admit(policy: LoopPolicy | null): GovernorVerdict {
  return policy === null ? 'deny' : 'admit';
}
