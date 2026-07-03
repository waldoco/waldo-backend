import type { SinkAck, SinkRequest } from '@waldo/contracts';
import type { NotificationReceiverDO } from './receiver-do';

// The delivery seam between TracerDO and the notification receiver. In production this fans out to
// APNs/Telegram AND writes the Supabase notification_log dedup row; here it forwards to the
// NotificationReceiverDO stand-in for that write-once mirror. It is intentionally NOT idempotent
// itself — exactly-once DELIVERY is the receiver's write-once duty (ADR-0054). The sender's only
// obligation is a STABLE idempotency_key on every (re)send, read from the committed outbox row, so a
// crash/resume re-send presents the same key and the receiver dedups it.
export class ReceiverSink {
  constructor(
    private readonly receivers: DurableObjectNamespace<NotificationReceiverDO>,
    private readonly now: () => number,
  ) {}

  // One at-least-once delivery attempt to the per-user receiver ledger. A transient provider failure
  // (accepted:false — nothing recorded) throws, leaving the run at its pre-ack GATED state so the next
  // wake re-drives with the same key. A recorded delivery (fresh or deduped) returns the ack.
  async send(userId: string, req: SinkRequest): Promise<SinkAck> {
    const id = this.receivers.idFromName(`notif:${userId}`);
    const res = await this.receivers.get(id).deliver({
      idempotency_key: req.idempotency_key,
      payload: req.payload,
      at: this.now(),
    });
    if (!res.accepted) {
      throw new Error('sink: transient delivery failure — receiver rejected, retry on next wake');
    }
    return { idempotency_key: req.idempotency_key, accepted: true };
  }
}
