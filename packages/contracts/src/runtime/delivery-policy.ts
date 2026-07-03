import { z } from 'zod';
import { channelNameSchema } from '../adapters/channel';
import type { TriggerType } from '../core/trigger';

// ADR-0068: one typed delivery-policy table is the single representation of every proactive send —
// class × channel × budget × standalone × quiet-hours × collapse × priority × cooldown. The
// DeliveryGate (a later runtime wave) is its sole enforcement point and the single writer of the
// push budget; this module is contract-only (no gate, no DDL, no scheduler here).
//
// Authority: the ADR's 2026-06-27 founder ratification + its "Current decision after 2026-06-27
// ratification" block. The pre-ratification table rows (ADR body lines 40-52) are superseded by that
// block, which this contract encodes. Values below MATCH the ratified block; none is a pending
// deviation. Reconciliations the ratification settled, kept consistent here:
//   • fetch_alert is budget:'exempt' — exempt for the daily push budget but still counted for cap /
//     cooldown / audit telemetry (ratified: "exempt-but-counted"; the old fetch-reservation rule is
//     retired). The superseded body table's row-43 "counted" is historical.
//   • The Admission verdict enum is exactly send|hold|degrade|drop — 'defer_next_day' was deleted:
//     it failed the deletion test once constellation_first became exempt + once-ever, so there is no
//     next-day budget deferral for a verdict to name.
//   • brief has no APNs leg, so it never consumes the daily budget; it is encoded budget:'counted'
//     (not 'exempt') because 'exempt' would wrongly grant the exhaustion-survival + cap-skip
//     semantics reserved for milestone/system classes, whereas apns:false already makes brief
//     non-decrementing. Its daily_cap:3 is the scheduled-brief cap (enforced by the scheduler, not
//     this gate); the additive event-variant brief is a runtime special-case, not a fourth budget unit.
//   • constellation_first's "once ever" is a lifetime bound the runtime enforces via class_state;
//     daily_cap:1 is its daily projection (once-ever ⊂ once-per-day).
//   • sync_error's "admits only if zero counted sends today" is a runtime admission condition, not a
//     simple cap, so daily_cap is null; escalation is carried by exempt_after_h:6 and the 24 h re-knock.
// Cross-repo follow-up (not this PR): amend the ADR's superseded body text (row-43 "counted", the
// stale "agent_invocable ∩ exempt = ∅" invariant at line 149, and the phantom tool name
// "execute_adjustment" in row-3, whose real tool is execute_action) so a future reader is not misled.

export const deliveryVerdictSchema = z.enum(['send', 'hold', 'degrade', 'drop']);
export type DeliveryVerdict = z.infer<typeof deliveryVerdictSchema>;

// The ten proactive push classes, in ADR-0068 table order. Rows 1–4 are agent-emitted (a trigger
// names them through admit()); rows 5–10 are system-emitted (constructed only via the gate's
// internal systemCandidate() seam, unreachable from any tool).
export const pushClassSchema = z.enum([
  'brief',
  'fetch_alert',
  'adjustment',
  'pre_activity_spot',
  'constellation_first',
  'constellation_update',
  'spot_digest',
  'intervention_knock',
  'sync_error',
  'system_consent',
]);
export type PushClass = z.infer<typeof pushClassSchema>;

// Quiet-hours disposition per class: hold until quiet-end, drop (never crosses quiet hours), the
// fetch confidence bypass, or hold only while an intervention is pending.
export const quietHoursRuleSchema = z.enum([
  'hold',
  'drop',
  'bypass_high_confidence',
  'hold_while_pending',
]);
export type QuietHoursRule = z.infer<typeof quietHoursRuleSchema>;

// Budget class: 'counted' decrements the daily APNs budget on send; 'exempt' never does (its cost is
// bounded by its own cap instead). Exemption is a class property no tool path can reach (ADR-0068 D5).
export const budgetClassSchema = z.enum(['counted', 'exempt']);
export type BudgetClass = z.infer<typeof budgetClassSchema>;

// Cooldown scope (ratified 2026-06-27, required v0.2.1 field): a 'class'-scoped cooldown tracks one
// last_sent_at for the whole class; an 'event'-scoped cooldown tracks it per event_id (a meeting, a
// connector). The two event-scoped rows — pre_activity_spot (1 h per meeting) and sync_error (24 h
// re-knock per failing connector) — are exactly the rows the pre-ratification schema could not
// represent, so their cooldowns no longer die at the day-row rollover.
export const cooldownScopeSchema = z.enum(['class', 'event']);
export type CooldownScope = z.infer<typeof cooldownScopeSchema>;

// adjustment is the only class with sub_kinds (ADR-0068 row 3), so its cap cannot live in the row's
// single daily_cap: 'proposed' is capped (no calendar/task mutation backs it — uncapped it is the
// spam surface the ADR names), while 'executed' is deliberately uncapped (1:1 with a real mutation
// already bounded by the ADR-0018 autonomy gates; capping the notice would hide the action).
export const adjustmentSubKindSchema = z.enum(['proposed', 'executed']);
export type AdjustmentSubKind = z.infer<typeof adjustmentSubKindSchema>;

export const subCapSchema = z.strictObject({
  daily_cap: z.int().positive().nullable(),
  cooldown_min: z.int().positive().nullable(),
});
export type SubCap = z.infer<typeof subCapSchema>;

// One row of the canonical table. priority null = does not compete for a constrained APNs slot;
// daily_cap/cooldown_min null = not gated on that axis at the row level; sub_caps non-null only on
// adjustment. Two documented exceptions to the "priority null ⟺ exempt" reading make it a comment,
// not an enforced rule: brief (counted, no APNs leg, priority null) and fetch_alert (exempt, yet P1).
// The refine keeps the ADR's named spam control structural, not test-only: any class carrying
// sub_caps MUST cap its 'proposed' sub-kind (a backing-less proposal is the spam surface).
export const deliveryPolicyRowSchema = z
  .strictObject({
    apns: z.boolean(),
    telegram: z.boolean(),
    feed: z.boolean(),
    budget: budgetClassSchema,
    exempt_after_h: z.int().positive().nullable(),
    is_standalone: z.boolean(),
    quiet_hours: quietHoursRuleSchema,
    priority: z.int().min(1).max(7).nullable(),
    daily_cap: z.int().positive().nullable(),
    cooldown_min: z.int().positive().nullable(),
    cooldown_scope: cooldownScopeSchema,
    agent_invocable: z.boolean(),
    sub_caps: z.strictObject({ proposed: subCapSchema, executed: subCapSchema }).nullable(),
  })
  .refine((row) => row.sub_caps === null || row.sub_caps.proposed.daily_cap !== null, {
    error: "a sub-capped class must cap its 'proposed' sub-kind — it is the backing-less spam surface",
    path: ['sub_caps', 'proposed', 'daily_cap'],
  });
export type DeliveryPolicyRow = z.infer<typeof deliveryPolicyRowSchema>;

// The single representation of delivery policy — data, not prose. A runtime reads a class's row; a
// policy change is one row edit. Values transcribed from the ADR-0068 ratified block (see the module
// header for the reconciliations the ratification settled).
export const DELIVERY_POLICY: Record<PushClass, DeliveryPolicyRow> = {
  brief: {
    apns: false,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'drop',
    priority: null,
    daily_cap: 3,
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: true,
    sub_caps: null,
  },
  fetch_alert: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'bypass_high_confidence',
    priority: 1,
    daily_cap: 3,
    cooldown_min: 120,
    cooldown_scope: 'class',
    agent_invocable: true,
    sub_caps: null,
  },
  adjustment: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'hold',
    priority: 2,
    daily_cap: null,
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: true,
    sub_caps: {
      proposed: { daily_cap: 3, cooldown_min: 60 },
      executed: { daily_cap: null, cooldown_min: null },
    },
  },
  pre_activity_spot: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'hold',
    priority: 3,
    daily_cap: 2,
    cooldown_min: 60,
    cooldown_scope: 'event',
    agent_invocable: true,
    sub_caps: null,
  },
  constellation_first: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: true,
    quiet_hours: 'hold',
    priority: null,
    daily_cap: 1,
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  constellation_update: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'hold',
    priority: 5,
    daily_cap: 1,
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  spot_digest: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'drop',
    priority: 6,
    daily_cap: 1,
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  intervention_knock: {
    apns: true,
    telegram: true,
    feed: false,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: true,
    quiet_hours: 'hold_while_pending',
    priority: null,
    daily_cap: 2,
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  sync_error: {
    apns: true,
    telegram: false,
    feed: true,
    budget: 'counted',
    exempt_after_h: 6,
    is_standalone: true,
    quiet_hours: 'hold',
    priority: 7,
    daily_cap: null,
    cooldown_min: 1440,
    cooldown_scope: 'event',
    agent_invocable: false,
    sub_caps: null,
  },
  system_consent: {
    apns: true,
    telegram: false,
    feed: true,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: true,
    quiet_hours: 'hold',
    priority: null,
    daily_cap: null,
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
};

// Tier is one integer (ADR-0016): Pro Max raises the cap and nothing else — same table, priorities,
// exemptions, cooldowns. Budget counts APNs sends only.
export const DAILY_PUSH_BUDGET = { pro: 3, pro_max: 5 } as const;

// Which push classes each trigger may proactively emit. Derived from the ADR-0068 Emitter column
// (proactive emitters), NOT from tool-ACL membership: user_message holds propose_schedule and
// execute_action, but it is a reactive trigger and reactive conversations are out of the proactive
// gate's scope — binding to ACL membership would wrongly let it name a proactive class. adjustment is
// bound to the proactive triggers that hold propose_schedule/execute_action (handoff_act,
// pre_activity_spot); the exact adjustment emitter set is flagged for founder ratification. System
// classes (agent_invocable: false) bind to no trigger — they enter only through systemCandidate().
export const TRIGGER_PUSH_CLASSES: Record<TriggerType, readonly PushClass[]> = {
  brief: ['brief'],
  fetch_alert: ['fetch_alert'],
  patrol: [],
  pre_brief_sweep: [],
  handoff_explore: [],
  handoff_plan: [],
  handoff_act: ['adjustment'],
  handoff_replan: [],
  intervention: [],
  user_message: [],
  dreaming_mode: [],
  pre_activity_spot: ['pre_activity_spot', 'adjustment'],
};

// The current block rule (ADR-0068), replacing the stale "agent_invocable ∩ budget:'exempt' = ∅":
// every AGENT-REACHABLE exempt class MUST carry a non-null, positive daily cap — an exempt class the
// agent can invoke without a real bound is unbounded proactive spend. The agent_invocable qualifier is
// load-bearing: system-emitted exempt classes (system_consent) legitimately carry a null cap ("as
// legally required") because no tool path can reach them. Assumes a schema-parsed row (daily_cap is
// positive-or-null); the > 0 guard makes the "real bound" contract explicit for any raw caller.
export function agentReachableExemptHasCap(row: DeliveryPolicyRow): boolean {
  return !(row.agent_invocable && row.budget === 'exempt') || (row.daily_cap !== null && row.daily_cap > 0);
}

// The fetch_alert-only policy sliver the Phase-C tracer consumes (it needs a non-null daily_cap for
// its cap comparison). It is a reduced typed view of DELIVERY_POLICY.fetch_alert, pinned to it by a
// consistency test; a later runtime wave migrates the tracer to read the row directly and drops this.
export const fetchAlertPolicySchema = z.strictObject({
  push_class: z.literal('fetch_alert'),
  budget_exempt: z.literal(true),
  daily_cap: z.int().positive(),
  cooldown_min: z.int().positive(),
});
export type FetchAlertPolicy = z.infer<typeof fetchAlertPolicySchema>;

export const FETCH_ALERT_POLICY: FetchAlertPolicy = {
  push_class: 'fetch_alert',
  budget_exempt: true,
  daily_cap: 3,
  cooldown_min: 120,
};

// The DeliveryGate verdict, stamped onto the outbox payload so crash-resume replays a frozen decision
// (ADR-0068 D5). channels/collapse_id/hold_until are populated by the full gate (a later runtime
// wave: channel arbitration, collapse-key assignment, quiet-hours math) and are optional here so the
// reduced Phase-C tracer admission — which computes none of them — stays honest rather than
// fabricating values. The stamp CANNOT lie about its class: its exemption and standalone flags MUST
// equal the class's DELIVERY_POLICY row, so a gate bug that mis-stamps a false exemption is a parse
// failure, not a silent budget bypass.
export const admissionSchema = z
  .strictObject({
    verdict: deliveryVerdictSchema,
    channels: z.array(channelNameSchema).optional(),
    collapse_id: z.string().min(1).optional(),
    hold_until: z.string().min(1).optional(),
    stamped: z.strictObject({
      push_class: pushClassSchema,
      is_standalone: z.boolean(),
      budget_exempt: z.boolean(),
    }),
  })
  .refine(
    (a) =>
      a.stamped.budget_exempt === (DELIVERY_POLICY[a.stamped.push_class].budget === 'exempt') &&
      a.stamped.is_standalone === DELIVERY_POLICY[a.stamped.push_class].is_standalone,
    { error: 'admission stamp must match its class DELIVERY_POLICY row (exemption + standalone)' },
  );
export type Admission = z.infer<typeof admissionSchema>;
