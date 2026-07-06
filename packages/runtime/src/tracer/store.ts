import type { ClassState, DailyPushBudget, ExemptTelemetry } from '@waldo/contracts';

const PUSH_CLASS = 'fetch_alert';

// The DeliveryGate is the single writer of class_state, daily_push_budget, and exempt_telemetry.
// All rows are keyed by userId (tenant scoping) and DO-local. Every mutation here is a sync
// sql.exec so it composes inside the DeliveryGate's transactionSync — no awaits, no I/O beyond SQL.
export class Store {
  constructor(private readonly sql: SqlStorage) {}

  readClassState(userId: string): ClassState {
    const rows = this.sql
      .exec<{ count: number; last_sent_at: number | null }>(
        'SELECT count, last_sent_at FROM class_state WHERE user_id = ? AND push_class = ?',
        userId,
        PUSH_CLASS,
      )
      .toArray();
    const row = rows[0];
    return {
      fetch_alert: {
        count: row?.count ?? 0,
        last_sent_at: row?.last_sent_at ?? null,
      },
    };
  }

  // Bumps the per-class cap counter and stamps last_sent_at (drives the 2h cooldown). Upsert so the
  // first send for a user creates the row. daily_push_budget is deliberately untouched here.
  incrementClassState(userId: string, now: number): void {
    this.sql.exec(
      `INSERT INTO class_state (user_id, push_class, count, last_sent_at)
         VALUES (?, ?, 1, ?)
       ON CONFLICT(user_id, push_class)
         DO UPDATE SET count = count + 1, last_sent_at = excluded.last_sent_at`,
      userId,
      PUSH_CLASS,
      now,
    );
  }

  readBudget(userId: string): DailyPushBudget {
    const rows = this.sql
      .exec<{ sends_total: number }>(
        'SELECT sends_total FROM daily_push_budget WHERE user_id = ?',
        userId,
      )
      .toArray();
    return { sends_total: rows[0]?.sends_total ?? 0, exempt_sends: 0, class_state: {} };
  }

  readExemptTelemetry(userId: string): ExemptTelemetry {
    const rows = this.sql
      .exec<{ exempt_sends: number }>(
        'SELECT exempt_sends FROM exempt_telemetry WHERE user_id = ? AND push_class = ?',
        userId,
        PUSH_CLASS,
      )
      .toArray();
    return { exempt_sends: rows[0]?.exempt_sends ?? 0 };
  }

  // Audit / WIS / push-pressure counter: an exempt send bypasses the daily budget but is still
  // counted so an exempt class cannot escape observability.
  incrementExemptSend(userId: string): void {
    this.sql.exec(
      `INSERT INTO exempt_telemetry (user_id, push_class, exempt_sends)
         VALUES (?, ?, 1)
       ON CONFLICT(user_id, push_class)
         DO UPDATE SET exempt_sends = exempt_sends + 1`,
      userId,
      PUSH_CLASS,
    );
  }
}
