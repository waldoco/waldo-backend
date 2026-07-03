import { DurableObject } from 'cloudflare:workers';

// Fault injection for the exactly-once substrate. Undefined in the default path; set ONLY by tests via
// runInDurableObject before a delivery is driven.
//   'transient_once' — the next deliver() returns a retryable failure (accepted:false) once, then clears,
//                       recording NOTHING. Models a provider retryable status (an APNs 5xx / rejected
//                       write): the sender re-sends on the next wake and delivers exactly once.
//   'non_idempotent' — skip the write-once dedup so a replayed idempotency_key records a SECOND row. This
//                       is the break-proof that keeps the durable-dedup assertion non-vacuous: with dedup
//                       on, a replay is a no-op (ledger stays 1); with it off, the ledger count becomes 2.
export type ReceiverFault = 'transient_once' | 'non_idempotent';

// NotificationReceiverDO — the DURABLE, receiver-side, write-once delivery ledger, and the exactly-once
// DELIVERY enforcement point of this substrate. It is the test stand-in for PRODUCTION's Supabase
// `notification_log` (`idempotency_key UNIQUE`, ADR-0054): a cross-store write-once mirror that lives
// OUTSIDE the sending DO. Modelling it as a SEPARATE Durable Object — never a table inside TracerDO — is
// deliberate: delivery-dedup authority must not sit in the sender's own store. Exactly-once delivery is
// at-least-once send with a stable idempotency_key (TracerDO's duty) + write-once dedup here.
export class NotificationReceiverDO extends DurableObject<Cloudflare.Env> {
  // Set only by tests (see ReceiverFault). In-memory, not persisted — eviction clears it.
  __fault?: ReceiverFault;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Append-only accepted-delivery log. Dedup is enforced in deliver() by an existence check that models
    // Supabase's `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING`, so the 'non_idempotent' fault can
    // show what an unguarded receiver would do: a second row for a replayed key.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS delivered (
         seq             INTEGER PRIMARY KEY AUTOINCREMENT,
         idempotency_key TEXT NOT NULL,
         payload         TEXT NOT NULL,
         first_at        INTEGER NOT NULL
       )`,
    );
  }

  // Record one delivery. `accepted` is false only on a transient failure (nothing recorded — the sender
  // must retry); `fresh` says whether the key was first-seen (production's "actually push vs suppress
  // duplicate" signal). Idempotent unless the 'non_idempotent' fault is set. The DO input gate serialises
  // calls, so the count-then-insert pair cannot interleave with another delivery on this instance.
  async deliver(req: {
    idempotency_key: string;
    payload: string;
    at: number;
  }): Promise<{ accepted: boolean; fresh: boolean }> {
    if (this.__fault === 'transient_once') {
      this.__fault = undefined;
      return { accepted: false, fresh: false };
    }
    const seen = this.ctx.storage.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM delivered WHERE idempotency_key = ?',
        req.idempotency_key,
      )
      .one().n;
    if (seen > 0 && this.__fault !== 'non_idempotent') return { accepted: true, fresh: false };
    this.ctx.storage.sql.exec(
      'INSERT INTO delivered (idempotency_key, payload, first_at) VALUES (?, ?, ?)',
      req.idempotency_key,
      req.payload,
      req.at,
    );
    return { accepted: true, fresh: seen === 0 };
  }
}
