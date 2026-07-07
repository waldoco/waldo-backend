import type {
  DeliveryGateReason,
  DeliveryVerdict,
  JournalRow,
  RunState,
} from '@waldo/contracts';
import {
  deliveryGateReasonSchema,
  journalRowSchema,
  runStateSchema,
  runStateTransitions,
} from '@waldo/contracts';
import type { Deps } from '../seams/deps';

type JournalSqlRow = {
  run_id: string;
  user_id: string;
  trigger: string;
  state: string;
  verdict: string | null;
  gate_reason: string | null;
  occurrence_at: number;
  created_at: number;
  updated_at: number;
};

function toRow(r: JournalSqlRow): JournalRow {
  return journalRowSchema.parse({
    run_id: r.run_id,
    user_id: r.user_id,
    trigger: r.trigger,
    state: r.state,
    verdict: r.verdict,
    gate_reason: r.gate_reason,
    occurrence_at: r.occurrence_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

// Journal writer/reader over DO SQLite enforcing the reduced FSM. All reads are SQLite-only
// so an evicted, reconstructed DO resumes from the committed step with no in-memory state.
export class Journal {
  constructor(
    private readonly sql: SqlStorage,
    private readonly deps: Deps,
  ) {}

  openRun(input: {
    runId: string;
    userId: string;
    trigger: string;
    occurrenceAt: number;
  }): void {
    const at = this.deps.now();
    this.sql.exec(
      `INSERT INTO journal
         (run_id, user_id, trigger, state, verdict, gate_reason, occurrence_at, created_at, updated_at)
       VALUES (?, ?, ?, 'RUN_OPENED', NULL, NULL, ?, ?, ?)`,
      input.runId,
      input.userId,
      input.trigger,
      input.occurrenceAt,
      at,
      at,
    );
  }

  read(runId: string): JournalRow | null {
    const rows = this.sql
      .exec<JournalSqlRow>('SELECT * FROM journal WHERE run_id = ?', runId)
      .toArray();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  // State-only parse for transition checks inside trusted write paths. Callers that may drive
  // side effects must first perform a full read() parse.
  readState(runId: string): RunState | null {
    const row = this.sql
      .exec<{ state: string }>('SELECT state FROM journal WHERE run_id = ?', runId)
      .toArray()[0];
    return row ? runStateSchema.parse(row.state) : null;
  }

  // A run is open while it has not reached a terminal state (DONE/FAILED). Exactly one open run
  // per DO at a time in the tracer, so resume reconstructs the whole run from this single SELECT.
  findOpenRun(): JournalRow | null {
    const rows = this.sql
      .exec<JournalSqlRow>(
        "SELECT * FROM journal WHERE state NOT IN ('DONE', 'FAILED') LIMIT 1",
      )
      .toArray();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  advance(runId: string, to: RunState): void {
    const from = this.readState(runId);
    if (from === null) throw new Error(`advance: no journal row for ${runId}`);
    if (!runStateTransitions[from].includes(to)) {
      throw new Error(`illegal transition ${from} -> ${to}`);
    }
    this.sql.exec(
      'UPDATE journal SET state = ?, updated_at = ? WHERE run_id = ?',
      to,
      this.deps.now(),
      runId,
    );
  }

  // The verdict is durable only alongside the GATED advance in the same transaction. Non-send
  // verdicts keep a closed reason next to the verdict so evicted runtimes can explain the gate.
  stampVerdict(
    runId: string,
    verdict: DeliveryVerdict,
    gateReason: DeliveryGateReason | null,
  ): void {
    const from = this.readState(runId);
    if (from !== 'GOVERNOR_ADMITTED') {
      throw new Error(`stampVerdict requires GOVERNOR_ADMITTED, got ${from}`);
    }
    if (verdict === 'send' && gateReason !== null) {
      throw new Error('stampVerdict: send verdict must not carry a gate reason');
    }
    if (verdict !== 'send' && gateReason === null) {
      throw new Error('stampVerdict: non-send verdict requires a gate reason');
    }
    const parsedReason =
      gateReason === null ? null : deliveryGateReasonSchema.parse(gateReason);
    this.sql.exec(
      'UPDATE journal SET verdict = ?, gate_reason = ?, updated_at = ? WHERE run_id = ?',
      verdict,
      parsedReason,
      this.deps.now(),
      runId,
    );
  }
}
