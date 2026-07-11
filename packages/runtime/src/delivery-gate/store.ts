import type {
  Admission,
  AdjustmentSubKind,
  ClassState,
  DailyPushBudget,
  DeliveryCandidate,
  ExemptTelemetry,
  HeldCandidate,
  PushClass,
} from '@waldo/contracts';
import { DELIVERY_POLICY, deliveryCandidateSchema, heldCandidateSchema } from '@waldo/contracts';

export class DeliveryGateStore {
  constructor(private readonly sql: SqlStorage) {}

  writeCandidate(runId: string, candidate: DeliveryCandidate): void {
    const parsed = deliveryCandidateSchema.parse(candidate);
    this.sql.exec(
      `INSERT INTO run_candidates (run_id, candidate_json)
         VALUES (?, ?)
       ON CONFLICT(run_id)
         DO UPDATE SET candidate_json = excluded.candidate_json`,
      runId,
      JSON.stringify(parsed),
    );
  }

  readCandidateJson(runId: string): string | null {
    const row = this.sql
      .exec<{ candidate_json: string }>(
        'SELECT candidate_json FROM run_candidates WHERE run_id = ?',
        runId,
      )
      .toArray()[0];
    return row?.candidate_json ?? null;
  }

  deleteCandidate(runId: string): void {
    this.sql.exec('DELETE FROM run_candidates WHERE run_id = ?', runId);
  }

  readClassState(userId: string, candidate: DeliveryCandidate, now: number): ClassState {
    const pushClass = candidate.push_class;
    const localDate = utcLocalDate(now);
    const rows = this.sql
      .exec<{ count: number; last_sent_at: number | null }>(
        `SELECT count, last_sent_at
           FROM class_state
          WHERE user_id = ? AND local_date = ? AND push_class = ?`,
        userId,
        localDate,
        pushClass,
      )
      .toArray();
    const row = rows[0];
    const lastSentAt =
      DELIVERY_POLICY[pushClass].cooldown_scope === 'event'
        ? this.readEventCooldown(userId, pushClass, candidate.event_id)
        : this.readLatestClassSentAt(userId, pushClass);
    return {
      [pushClass]: {
        count: row?.count ?? 0,
        last_sent_at: lastSentAt,
      },
    };
  }

  readSubKindState(
    userId: string,
    pushClass: PushClass,
    subKind: AdjustmentSubKind,
    now: number,
  ): { count: number; last_sent_at: number | null } {
    const localDate = utcLocalDate(now);
    const row = this.sql
      .exec<{ count: number; last_sent_at: number | null }>(
        `SELECT count, last_sent_at
           FROM subkind_state
          WHERE user_id = ? AND local_date = ? AND push_class = ? AND sub_kind = ?`,
        userId,
        localDate,
        pushClass,
        subKind,
      )
      .toArray()[0];
    return {
      count: row?.count ?? 0,
      last_sent_at: this.readLatestSubKindSentAt(userId, pushClass, subKind),
    };
  }

  incrementClassState(userId: string, pushClass: PushClass, now: number): void {
    const localDate = utcLocalDate(now);
    this.sql.exec(
      `INSERT INTO class_state (user_id, local_date, push_class, count, last_sent_at)
         VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, local_date, push_class)
         DO UPDATE SET count = count + 1, last_sent_at = excluded.last_sent_at`,
      userId,
      localDate,
      pushClass,
      now,
    );
  }

  recordEventCooldown(
    userId: string,
    pushClass: PushClass,
    eventId: string,
    now: number,
  ): void {
    this.sql.exec(
      `INSERT INTO event_cooldowns (user_id, push_class, event_id, last_sent_at)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, push_class, event_id)
         DO UPDATE SET last_sent_at = excluded.last_sent_at`,
      userId,
      pushClass,
      eventId,
      now,
    );
  }

  incrementSubKindState(
    userId: string,
    pushClass: PushClass,
    subKind: AdjustmentSubKind,
    now: number,
  ): void {
    const localDate = utcLocalDate(now);
    this.sql.exec(
      `INSERT INTO subkind_state (user_id, local_date, push_class, sub_kind, count, last_sent_at)
         VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id, local_date, push_class, sub_kind)
         DO UPDATE SET count = count + 1, last_sent_at = excluded.last_sent_at`,
      userId,
      localDate,
      pushClass,
      subKind,
      now,
    );
  }

  private readEventCooldown(
    userId: string,
    pushClass: PushClass,
    eventId: string,
  ): number | null {
    const row = this.sql
      .exec<{ last_sent_at: number }>(
        `SELECT last_sent_at
           FROM event_cooldowns
          WHERE user_id = ? AND push_class = ? AND event_id = ?`,
        userId,
        pushClass,
        eventId,
      )
      .toArray()[0];
    return row?.last_sent_at ?? null;
  }

  private readLatestClassSentAt(userId: string, pushClass: PushClass): number | null {
    const row = this.sql
      .exec<{ last_sent_at: number }>(
        `SELECT last_sent_at
           FROM class_state
          WHERE user_id = ? AND push_class = ? AND last_sent_at IS NOT NULL
          ORDER BY last_sent_at DESC
          LIMIT 1`,
        userId,
        pushClass,
      )
      .toArray()[0];
    return row?.last_sent_at ?? null;
  }

  private readLatestSubKindSentAt(
    userId: string,
    pushClass: PushClass,
    subKind: AdjustmentSubKind,
  ): number | null {
    const row = this.sql
      .exec<{ last_sent_at: number }>(
        `SELECT last_sent_at
           FROM subkind_state
          WHERE user_id = ? AND push_class = ? AND sub_kind = ? AND last_sent_at IS NOT NULL
          ORDER BY last_sent_at DESC
          LIMIT 1`,
        userId,
        pushClass,
        subKind,
      )
      .toArray()[0];
    return row?.last_sent_at ?? null;
  }

  readBudget(userId: string, now: number): DailyPushBudget {
    const localDate = utcLocalDate(now);
    const row = this.sql
      .exec<{ sends_total: number; exempt_sends: number }>(
        `SELECT sends_total, exempt_sends
           FROM daily_push_budget
          WHERE user_id = ? AND local_date = ?`,
        userId,
        localDate,
      )
      .toArray()[0];
    return {
      local_date: localDate,
      sends_total: row?.sends_total ?? 0,
      exempt_sends: row?.exempt_sends ?? 0,
      class_state: {},
    };
  }

  incrementCountedBudget(userId: string, now: number): void {
    const localDate = utcLocalDate(now);
    this.sql.exec(
      `INSERT INTO daily_push_budget (user_id, local_date, sends_total)
         VALUES (?, ?, 1)
       ON CONFLICT(user_id, local_date)
         DO UPDATE SET sends_total = sends_total + 1`,
      userId,
      localDate,
    );
  }

  incrementExemptBudget(userId: string, now: number): void {
    const localDate = utcLocalDate(now);
    this.sql.exec(
      `INSERT INTO daily_push_budget (user_id, local_date, exempt_sends)
         VALUES (?, ?, 1)
       ON CONFLICT(user_id, local_date)
         DO UPDATE SET exempt_sends = exempt_sends + 1`,
      userId,
      localDate,
    );
  }

  readExemptTelemetry(userId: string, pushClass: PushClass): ExemptTelemetry {
    const row = this.sql
      .exec<{ exempt_sends: number }>(
        'SELECT exempt_sends FROM exempt_telemetry WHERE user_id = ? AND push_class = ?',
        userId,
        pushClass,
      )
      .toArray()[0];
    return { exempt_sends: row?.exempt_sends ?? 0 };
  }

  incrementExemptSend(userId: string, pushClass: PushClass): void {
    this.sql.exec(
      `INSERT INTO exempt_telemetry (user_id, push_class, exempt_sends)
         VALUES (?, ?, 1)
       ON CONFLICT(user_id, push_class)
         DO UPDATE SET exempt_sends = exempt_sends + 1`,
      userId,
      pushClass,
    );
  }

  recordHeld(userId: string, candidate: DeliveryCandidate, admission: Admission): void {
    if (admission.verdict !== 'hold' || admission.hold_until === undefined) {
      throw new Error('recordHeld requires a held admission');
    }
    const held = heldCandidateSchema.parse({
      event_id: candidate.event_id,
      push_class: candidate.push_class,
      candidate,
      hold_until: admission.hold_until,
      expires_at: admission.stamped.expires_at ?? null,
    });
    this.sql.exec(
      `INSERT INTO held_candidates
         (user_id, event_id, push_class, candidate_json, hold_until, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, event_id)
         DO UPDATE SET
           push_class = excluded.push_class,
           candidate_json = excluded.candidate_json,
           hold_until = excluded.hold_until,
           expires_at = excluded.expires_at`,
      userId,
      held.event_id,
      held.push_class,
      JSON.stringify(held.candidate),
      held.hold_until,
      held.expires_at,
    );
  }

  readHeld(userId: string, eventId: string): HeldCandidate | null {
    const row = this.sql
      .exec<{
        event_id: string;
        push_class: PushClass;
        candidate_json: string;
        hold_until: number;
        expires_at: number | null;
      }>(
        `SELECT event_id, push_class, candidate_json, hold_until, expires_at
           FROM held_candidates
          WHERE user_id = ? AND event_id = ?`,
        userId,
        eventId,
      )
      .toArray()[0];
    if (!row) return null;
    return heldCandidateSchema.parse({
      event_id: row.event_id,
      push_class: row.push_class,
      candidate: JSON.parse(row.candidate_json),
      hold_until: row.hold_until,
      expires_at: row.expires_at,
    });
  }

  deleteHeld(userId: string, eventId: string): void {
    this.sql.exec(
      'DELETE FROM held_candidates WHERE user_id = ? AND event_id = ?',
      userId,
      eventId,
    );
  }

  applyAdmission(
    userId: string,
    candidate: DeliveryCandidate,
    admission: Admission,
    now: number,
  ): void {
    if (admission.verdict !== 'send' && admission.verdict !== 'degrade') return;
    const pushClass = admission.stamped.push_class;
    this.incrementClassState(userId, pushClass, now);
    if (candidate.push_class === 'adjustment' && candidate.sub_kind !== undefined) {
      this.incrementSubKindState(userId, pushClass, candidate.sub_kind, now);
    }
    if (DELIVERY_POLICY[pushClass].cooldown_scope === 'event') {
      this.recordEventCooldown(userId, pushClass, candidate.event_id, now);
    }
    if (admission.budget_charged) {
      this.incrementCountedBudget(userId, now);
    }
    if (admission.stamped.budget_exempt) {
      this.incrementExemptSend(userId, pushClass);
      this.incrementExemptBudget(userId, now);
    }
  }
}

function utcLocalDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
