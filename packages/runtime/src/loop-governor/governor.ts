import type {
  GovernorVerdict,
  LoopDisposition,
  LoopProgressRow,
  LoopType,
  ToolName,
  TriggerType,
} from '@waldo/contracts';
import {
  admit,
  isNoProgress,
  loopDispositionSchema,
  loopProgressRowSchema,
  loopToolObservationSchema,
  loopTypeSchema,
  lookupLoopPolicy,
  outboundTextPassesArt9Floor,
  priorityTierRank,
} from '@waldo/contracts';
import type { Deps } from '../seams/deps';

export const GOVERNOR_ALLOW_REASONS = ['policy_admitted'] as const;
export const GOVERNOR_DENY_REASONS = [
  'policy_missing',
  'kill_flag_active',
  'no_progress',
  'duplicate_observation',
  'token_budget_exhausted',
  'iteration_budget_exhausted',
  'subagent_budget_exhausted',
  'art9_egress_blocked',
] as const;

const NO_PROGRESS_DIVERSITY_THRESHOLD = 0.2;
const NO_PROGRESS_SUCCESS_THRESHOLD = 0.2;

export type GovernorAllowReason = (typeof GOVERNOR_ALLOW_REASONS)[number];
export type GovernorDenyReason = (typeof GOVERNOR_DENY_REASONS)[number];
export type GovernorReason = GovernorAllowReason | GovernorDenyReason;

export type GovernorDecision =
  | {
      verdict: 'admit';
      reason: GovernorAllowReason;
      disposition: null;
      loopType: LoopType;
    }
  | {
      verdict: 'deny';
      reason: GovernorDenyReason;
      disposition: LoopDisposition | null;
      loopType: LoopType;
    };

export type StartGovernorRunInput = {
  runId: string;
  userId: string;
  trigger: TriggerType;
  occurrenceAt: number;
  loopType?: LoopType;
  occurrenceId?: string;
};

export type LoopUsageInput = {
  runId: string;
  tokensUsed?: number;
  iterations?: number;
  subagentSpawns?: number;
};

export type LoopObservationInput = {
  runId: string;
  toolName: ToolName;
  canonicalParamsHash: string;
  resultHash: string;
  success: boolean;
};

export type LoopEgressInput = {
  runId: string;
  text: string;
};

export type SetLoopKillFlagInput = {
  scope: 'global' | 'loop';
  loopType: LoopType | null;
  active: boolean;
};

export type LoopAdmissionCandidate = {
  loopType: LoopType;
  occurrenceAt: number;
  sequence?: number;
};

type GovernorRunSqlRow = {
  run_id: string;
  user_id: string;
  loop_type: string;
  occurrence_id: string;
  verdict: string | null;
  reason: string | null;
  disposition: string | null;
  tokens_used: number;
  iterations: number;
  subagent_spawns: number;
  created_at: number;
  updated_at: number;
};

type GovernorRunRow = Omit<GovernorRunSqlRow, 'loop_type' | 'verdict' | 'reason' | 'disposition'> & {
  loop_type: LoopType;
  verdict: GovernorVerdict | null;
  reason: GovernorReason | null;
  disposition: LoopDisposition | null;
};

type KillFlagSqlRow = {
  flag_key: string;
  scope: string;
  loop_type: string | null;
  active: number;
  updated_at: number;
};

export class LoopGovernor {
  constructor(
    private readonly sql: SqlStorage,
    private readonly deps: Deps,
  ) {}

  startRun(input: StartGovernorRunInput): void {
    const loopType = loopTypeSchema.parse(input.loopType ?? loopTypeForTrigger(input.trigger));
    if (!Number.isInteger(input.occurrenceAt) || input.occurrenceAt < 0) {
      throw new Error('governor startRun requires a non-negative integer occurrenceAt');
    }
    const occurrenceId = input.occurrenceId ?? occurrenceWindowId(loopType, input.occurrenceAt);
    if (input.runId.length === 0 || input.userId.length === 0 || occurrenceId.length === 0) {
      throw new Error('governor startRun requires non-empty run, user, and occurrence ids');
    }
    const at = this.deps.now();
    this.sql.exec(
      `INSERT INTO loop_governor_runs
         (run_id, user_id, loop_type, occurrence_id, verdict, reason, disposition,
          tokens_used, iterations, subagent_spawns, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 0, ?, ?)`,
      input.runId,
      input.userId,
      loopType,
      occurrenceId,
      at,
      at,
    );
  }

  admitRun(runId: string): GovernorDecision {
    const row = this.readRun(runId);
    const killed = this.killDecision(row);
    if (killed !== null) return killed;
    const policy = lookupLoopPolicy(row.loop_type);
    const verdict = admit(policy);
    if (verdict === 'deny') {
      return this.recordDecision(row, {
        verdict: 'deny',
        reason: 'policy_missing',
        disposition: null,
        loopType: row.loop_type,
      });
    }

    return this.recordDecision(row, {
      verdict: 'admit',
      reason: 'policy_admitted',
      disposition: null,
      loopType: row.loop_type,
    });
  }

  recordUsage(input: LoopUsageInput): GovernorDecision {
    const row = this.readRun(input.runId);
    const killed = this.killDecision(row);
    if (killed !== null) return killed;
    return this.recordUsageAfterEffectBoundary(input, row);
  }

  // A provider receipt proves the external call has already happened. Its bounded accounting
  // must commit even if a kill arrived while the adapter was in flight; otherwise the durable
  // receipt and Governor counters diverge and a restart can no longer audit the real effect.
  recordSettledProviderUsage(input: LoopUsageInput): GovernorDecision {
    const row = this.readRun(input.runId);
    const totals = this.usageTotals(input, row);
    // This is a post-effect fact, unlike ordinary preflight usage. Commit it before consulting a
    // kill flag or policy so a receipt can never be durably visible without its bounded charge.
    this.writeUsageTotals(input.runId, totals);
    const settledRow = this.readRun(input.runId);
    const killed = this.killDecision(settledRow);
    if (killed !== null) return killed;
    return this.recordDecision(
      settledRow,
      this.usageDecision(
        settledRow.loop_type,
        lookupLoopPolicy(settledRow.loop_type),
        totals.tokensUsed,
        totals.iterations,
        totals.subagentSpawns,
      ),
    );
  }

  private recordUsageAfterEffectBoundary(
    input: LoopUsageInput,
    row: GovernorRunRow,
  ): GovernorDecision {
    const totals = this.usageTotals(input, row);
    const policy = lookupLoopPolicy(row.loop_type);
    if (policy === null) {
      return this.recordDecision(row, {
        verdict: 'deny',
        reason: 'policy_missing',
        disposition: null,
        loopType: row.loop_type,
      });
    }
    this.writeUsageTotals(input.runId, totals);
    return this.recordDecision(
      this.readRun(input.runId),
      this.usageDecision(
        row.loop_type,
        policy,
        totals.tokensUsed,
        totals.iterations,
        totals.subagentSpawns,
      ),
    );
  }

  private usageTotals(
    input: LoopUsageInput,
    row: GovernorRunRow,
  ): Readonly<{ tokensUsed: number; iterations: number; subagentSpawns: number }> {
    const tokensUsed = nextCounterTotal(input.tokensUsed, row.tokens_used, 'tokensUsed');
    const iterations = nextCounterTotal(input.iterations, row.iterations, 'iterations');
    const subagentSpawns = nextCounterTotal(
      input.subagentSpawns,
      row.subagent_spawns,
      'subagentSpawns',
    );
    return { tokensUsed, iterations, subagentSpawns };
  }

  private writeUsageTotals(
    runId: string,
    totals: Readonly<{ tokensUsed: number; iterations: number; subagentSpawns: number }>,
  ): void {
    this.sql.exec(
      `UPDATE loop_governor_runs
          SET tokens_used = ?, iterations = ?, subagent_spawns = ?, updated_at = ?
        WHERE run_id = ?`,
      totals.tokensUsed,
      totals.iterations,
      totals.subagentSpawns,
      this.deps.now(),
      runId,
    );
  }

  // This projected gate deliberately does not consume usage. RunLoopDO invokes it immediately
  // before an external provider effect so a call that would exceed an iteration/token/subagent
  // bound is never issued and the receipt settlement can remain the sole counter mutation.
  checkUsageBudget(input: LoopUsageInput): GovernorDecision {
    const row = this.readRun(input.runId);
    if (this.hasActiveKill(row.loop_type)) {
      return this.recordDecision(row, {
        verdict: 'deny',
        reason: 'kill_flag_active',
        disposition: 'killed',
        loopType: row.loop_type,
      });
    }
    const policy = lookupLoopPolicy(row.loop_type);
    const tokensUsed = nextCounterTotal(input.tokensUsed, row.tokens_used, 'tokensUsed');
    const iterations = nextCounterTotal(input.iterations, row.iterations, 'iterations');
    const subagentSpawns = nextCounterTotal(
      input.subagentSpawns,
      row.subagent_spawns,
      'subagentSpawns',
    );
    const decision = this.usageDecision(row.loop_type, policy, tokensUsed, iterations, subagentSpawns);
    return decision.verdict === 'deny' ? this.recordDecision(row, decision) : decision;
  }

  private usageDecision(
    loopType: LoopType,
    policy: ReturnType<typeof lookupLoopPolicy>,
    tokensUsed: number,
    iterations: number,
    subagentSpawns: number,
  ): GovernorDecision {
    if (policy === null) {
      return {
        verdict: 'deny',
        reason: 'policy_missing',
        disposition: null,
        loopType,
      };
    }
    if (tokensUsed > policy.max_tokens_per_run) {
      return {
        verdict: 'deny',
        reason: 'token_budget_exhausted',
        disposition: 'killed',
        loopType,
      };
    }

    if (iterations > policy.max_iterations_per_run) {
      return {
        verdict: 'deny',
        reason: 'iteration_budget_exhausted',
        disposition: 'couldnt_converge',
        loopType,
      };
    }

    if (subagentSpawns > policy.max_subagent_spawns_per_run) {
      return {
        verdict: 'deny',
        reason: 'subagent_budget_exhausted',
        disposition: 'killed',
        loopType,
      };
    }

    return {
      verdict: 'admit',
      reason: 'policy_admitted',
      disposition: null,
      loopType,
    };
  }

  recordObservation(input: LoopObservationInput): GovernorDecision {
    const observation = loopToolObservationSchema.parse({
      tool_name: input.toolName,
      canonical_params_hash: input.canonicalParamsHash,
      result_hash: input.resultHash,
    });
    const row = this.readRun(input.runId);
    const killed = this.killDecision(row);
    if (killed !== null) return killed;
    const duplicate = this.persistObservationFacts(input, row, observation);
    if (duplicate !== null) return duplicate;
    return this.observationDecision(row);
  }

  // A completed tool receipt is factual even when a kill arrives while the tool adapter is in
  // flight. Persist its bounded observation/progress first, then let the kill become the final
  // Governor decision. Ordinary observations retain their pre-effect kill check above.
  recordSettledToolObservation(input: LoopObservationInput): GovernorDecision {
    const observation = loopToolObservationSchema.parse({
      tool_name: input.toolName,
      canonical_params_hash: input.canonicalParamsHash,
      result_hash: input.resultHash,
    });
    const row = this.readRun(input.runId);
    const duplicate = this.persistObservationFacts(input, row, observation);
    if (duplicate !== null) return duplicate;
    const killed = this.killDecision(this.readRun(input.runId));
    if (killed !== null) return killed;
    return this.observationDecision(row);
  }

  private persistObservationFacts(
    input: LoopObservationInput,
    row: GovernorRunRow,
    observation: ReturnType<typeof loopToolObservationSchema.parse>,
  ): GovernorDecision | null {
    const at = this.deps.now();
    this.readProgressIfPresent(row.user_id, row.loop_type, row.occurrence_id);
    if (this.hasObservation(input.runId, observation)) {
      return this.recordDecision(row, {
        verdict: 'deny',
        reason: 'duplicate_observation',
        disposition: 'couldnt_converge',
        loopType: row.loop_type,
      });
    }
    this.sql.exec(
      `INSERT INTO loop_observations
         (run_id, tool_name, canonical_params_hash, result_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.runId,
      observation.tool_name,
      observation.canonical_params_hash,
      observation.result_hash,
      at,
    );
    this.sql.exec(
      `INSERT INTO loop_progress
         (user_id, loop_type, occurrence_id, call_count, unique_param_hashes, successes, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)
       ON CONFLICT(user_id, loop_type, occurrence_id)
         DO UPDATE SET
           call_count = call_count + 1,
           successes = successes + excluded.successes,
           updated_at = excluded.updated_at`,
      row.user_id,
      row.loop_type,
      row.occurrence_id,
      input.success ? 1 : 0,
      at,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO loop_progress_params
         (user_id, loop_type, occurrence_id, canonical_params_hash)
       VALUES (?, ?, ?, ?)`,
      row.user_id,
      row.loop_type,
      row.occurrence_id,
      observation.canonical_params_hash,
    );
    const uniqueParamHashes = this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n
           FROM loop_progress_params
          WHERE user_id = ? AND loop_type = ? AND occurrence_id = ?`,
        row.user_id,
        row.loop_type,
        row.occurrence_id,
      )
      .one().n;
    this.sql.exec(
      `UPDATE loop_progress
          SET unique_param_hashes = ?, updated_at = ?
        WHERE user_id = ? AND loop_type = ? AND occurrence_id = ?`,
      uniqueParamHashes,
      at,
      row.user_id,
      row.loop_type,
      row.occurrence_id,
    );
    return null;
  }

  private observationDecision(row: GovernorRunRow): GovernorDecision {
    if (
      isNoProgress(
        this.readProgress(row.user_id, row.loop_type, row.occurrence_id),
        NO_PROGRESS_DIVERSITY_THRESHOLD,
        NO_PROGRESS_SUCCESS_THRESHOLD,
      )
    ) {
      return this.recordDecision(row, {
        verdict: 'deny',
        reason: 'no_progress',
        disposition: 'no_progress',
        loopType: row.loop_type,
      });
    }

    return this.recordDecision(row, {
      verdict: 'admit',
      reason: 'policy_admitted',
      disposition: null,
      loopType: row.loop_type,
    });
  }

  checkEgress(input: LoopEgressInput): GovernorDecision {
    if (typeof input.text !== 'string') {
      throw new Error('checkEgress requires text');
    }
    const row = this.readRun(input.runId);
    const killed = this.killDecision(row);
    if (killed !== null) return killed;
    const policy = lookupLoopPolicy(row.loop_type);
    if (policy === null) {
      return this.recordDecision(row, {
        verdict: 'deny',
        reason: 'policy_missing',
        disposition: null,
        loopType: row.loop_type,
      });
    }
    if (!policy.egress_gated || outboundTextPassesArt9Floor(input.text)) {
      return this.recordDecision(row, {
        verdict: 'admit',
        reason: 'policy_admitted',
        disposition: null,
        loopType: row.loop_type,
      });
    }
    return this.recordDecision(row, {
      verdict: 'deny',
      reason: 'art9_egress_blocked',
      disposition: 'killed',
      loopType: row.loop_type,
    });
  }

  readDecision(runId: string): GovernorDecision | null {
    return decisionFromRow(this.readRun(runId));
  }

  // RunJournalOutbox uses this only to bind a trusted V2 journal row to the same derived
  // tenant-plus-principal owner scope as its Governor progress state.
  readRunOwnerScope(runId: string): string {
    return this.readRun(runId).user_id;
  }

  private readRun(runId: string): GovernorRunRow {
    const row = this.sql
      .exec<GovernorRunSqlRow>('SELECT * FROM loop_governor_runs WHERE run_id = ?', runId)
      .toArray()[0];
    if (!row) throw new Error(`LoopGovernor: no run row for ${runId}`);
    return parseGovernorRun(row);
  }

  setKillFlag(input: SetLoopKillFlagInput): void {
    if (input.scope === 'global' && input.loopType !== null) {
      throw new Error('global kill flag must not name a loop');
    }
    if (input.scope === 'loop' && input.loopType === null) {
      throw new Error('loop kill flag requires a loop type');
    }
    const loopType = input.loopType === null ? null : loopTypeSchema.parse(input.loopType);
    const flagKey = input.scope === 'global' ? 'global' : `loop:${loopType}`;
    this.sql.exec(
      `INSERT INTO loop_kill_flags (flag_key, scope, loop_type, active, updated_at)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(flag_key)
         DO UPDATE SET
           scope = excluded.scope,
           loop_type = excluded.loop_type,
           active = excluded.active,
           updated_at = excluded.updated_at`,
      flagKey,
      input.scope,
      loopType,
      input.active ? 1 : 0,
      this.deps.now(),
    );
  }

  private recordDecision<T extends GovernorDecision>(row: GovernorRunRow, decision: T): T {
    this.sql.exec(
      `UPDATE loop_governor_runs
          SET verdict = ?, reason = ?, disposition = ?, updated_at = ?
        WHERE run_id = ?`,
      decision.verdict,
      decision.reason,
      decision.disposition,
      this.deps.now(),
      row.run_id,
    );
    return decision;
  }

  private killDecision(row: GovernorRunRow): GovernorDecision | null {
    if (!this.hasActiveKill(row.loop_type)) return null;
    return this.recordDecision(row, {
      verdict: 'deny',
      reason: 'kill_flag_active',
      disposition: 'killed',
      loopType: row.loop_type,
    });
  }

  private hasActiveKill(loopType: LoopType): boolean {
    const rows = this.sql
      .exec<KillFlagSqlRow>(
        `SELECT *
           FROM loop_kill_flags
          WHERE flag_key = 'global' OR flag_key = ?`,
        `loop:${loopType}`,
      )
      .toArray();
    return rows.some((row) => parseKillFlag(row).active);
  }

  private readProgress(
    userId: string,
    loopType: LoopType,
    occurrenceId: string,
  ): LoopProgressRow {
    const row = this.sql
      .exec<{
        call_count: number;
        unique_param_hashes: number;
        successes: number;
        updated_at: number;
      }>(
        `SELECT call_count, unique_param_hashes, successes, updated_at
           FROM loop_progress
          WHERE user_id = ? AND loop_type = ? AND occurrence_id = ?`,
        userId,
        loopType,
        occurrenceId,
      )
      .one();
    return loopProgressRowSchema.parse({
      loop_name: loopType,
      occurrence_id: occurrenceId,
      call_count: row.call_count,
      unique_param_hashes: row.unique_param_hashes,
      successes: row.successes,
      updated_at: row.updated_at,
    });
  }

  private hasObservation(
    runId: string,
    observation: { tool_name: ToolName; canonical_params_hash: string; result_hash: string },
  ): boolean {
    return (
      this.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n
             FROM loop_observations
            WHERE run_id = ?
              AND tool_name = ?
              AND canonical_params_hash = ?
              AND result_hash = ?`,
          runId,
          observation.tool_name,
          observation.canonical_params_hash,
          observation.result_hash,
        )
        .one().n > 0
    );
  }

  private readProgressIfPresent(
    userId: string,
    loopType: LoopType,
    occurrenceId: string,
  ): LoopProgressRow | null {
    const row = this.sql
      .exec<{
        call_count: number;
        unique_param_hashes: number;
        successes: number;
        updated_at: number;
      }>(
        `SELECT call_count, unique_param_hashes, successes, updated_at
           FROM loop_progress
          WHERE user_id = ? AND loop_type = ? AND occurrence_id = ?`,
        userId,
        loopType,
        occurrenceId,
      )
      .toArray()[0];
    if (!row) return null;
    return loopProgressRowSchema.parse({
      loop_name: loopType,
      occurrence_id: occurrenceId,
      call_count: row.call_count,
      unique_param_hashes: row.unique_param_hashes,
      successes: row.successes,
      updated_at: row.updated_at,
    });
  }
}

function nextCounterTotal(delta: number | undefined, current: number, field: string): number {
  if (delta === undefined) return current;
  if (!Number.isInteger(delta) || delta < 0) {
    throw new Error(`recordUsage requires a non-negative integer ${field}`);
  }
  return current + delta;
}

function occurrenceWindowId(loopType: LoopType, occurrenceAt: number): string {
  return `${loopType}:${occurrenceAt}`;
}

export function loopTypeForTrigger(trigger: TriggerType): LoopType {
  switch (trigger) {
    case 'fetch_alert':
      return 'fetch';
    case 'intervention':
      return 'intervention';
    case 'pre_activity_spot':
      return 'pre_activity_spot';
    case 'brief':
      return 'brief';
    case 'dreaming_mode':
      return 'dreaming';
    case 'user_message':
      return 'chat';
    case 'handoff_act':
    case 'handoff_explore':
    case 'handoff_plan':
    case 'handoff_replan':
    case 'patrol':
    case 'pre_brief_sweep':
      return 'patrol';
  }
}

export function compareLoopAdmission(
  a: LoopAdmissionCandidate,
  b: LoopAdmissionCandidate,
): number {
  const rank = rankForLoop(a.loopType) - rankForLoop(b.loopType);
  if (rank !== 0) return rank;
  const occurrence = a.occurrenceAt - b.occurrenceAt;
  if (occurrence !== 0) return occurrence;
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

function rankForLoop(loopType: LoopType): number {
  const policy = lookupLoopPolicy(loopType);
  return policy === null ? Number.POSITIVE_INFINITY : priorityTierRank[policy.priority_tier];
}

function parseGovernorRun(row: GovernorRunSqlRow): GovernorRunRow {
  return {
    ...row,
    loop_type: loopTypeSchema.parse(row.loop_type),
    verdict: parseVerdict(row.verdict),
    reason: parseReason(row.reason),
    disposition: row.disposition === null ? null : loopDispositionSchema.parse(row.disposition),
  };
}

function decisionFromRow(row: GovernorRunRow): GovernorDecision | null {
  if (row.verdict === null && row.reason === null && row.disposition === null) return null;
  if (row.verdict === null || row.reason === null) {
    throw new Error(`incomplete governor decision for ${row.run_id}`);
  }
  if (row.verdict === 'admit') {
    if (row.reason !== 'policy_admitted' || row.disposition !== null) {
      throw new Error(`invalid admitted governor decision for ${row.run_id}`);
    }
    return {
      verdict: 'admit',
      reason: row.reason,
      disposition: null,
      loopType: row.loop_type,
    };
  }
  if (!(GOVERNOR_DENY_REASONS as readonly string[]).includes(row.reason)) {
    throw new Error(`invalid denied governor reason ${row.reason}`);
  }
  return {
    verdict: 'deny',
    reason: row.reason as GovernorDenyReason,
    disposition: row.disposition,
    loopType: row.loop_type,
  };
}

function parseVerdict(verdict: string | null): GovernorVerdict | null {
  if (verdict === null || verdict === 'admit' || verdict === 'deny') return verdict;
  throw new Error(`invalid governor verdict ${verdict}`);
}

function parseReason(reason: string | null): GovernorReason | null {
  if (reason === null) return null;
  if (
    (GOVERNOR_ALLOW_REASONS as readonly string[]).includes(reason) ||
    (GOVERNOR_DENY_REASONS as readonly string[]).includes(reason)
  ) {
    return reason as GovernorReason;
  }
  throw new Error(`invalid governor reason ${reason}`);
}

function parseKillFlag(row: KillFlagSqlRow): SetLoopKillFlagInput {
  const active = parseActive(row.active);
  if (row.scope === 'global') {
    if (row.loop_type !== null || row.flag_key !== 'global') {
      throw new Error('invalid global loop kill flag row');
    }
    return { scope: 'global', loopType: null, active };
  }
  if (row.scope === 'loop') {
    const loopType = loopTypeSchema.parse(row.loop_type);
    if (row.flag_key !== `loop:${loopType}`) {
      throw new Error('invalid loop kill flag key');
    }
    return { scope: 'loop', loopType, active };
  }
  throw new Error(`invalid loop kill flag scope ${row.scope}`);
}

function parseActive(active: number): boolean {
  if (active === 0) return false;
  if (active === 1) return true;
  throw new Error(`invalid loop kill flag active value ${active}`);
}
