import { z } from 'zod';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const pendingApprovalSchema = z.strictObject({
  approvalId: z.string().min(1),
  ownerId: z.string().min(1),
  operation: z.string().min(1),
  effectClass: z.enum(['reversible', 'irreversible']),
  payloadDigest: digest,
  manifestDigest: digest,
  generation: z.int().nonnegative(),
  summary: z.string().min(1).max(500),
  telegramScope: z.boolean(),
  createdAt: z.int().nonnegative(),
  expiresAt: z.int().nonnegative(),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

export const approvalDecisionSchema = z.strictObject({
  approvalId: z.string().min(1),
  decision: z.enum(['approve', 'decline']),
  payloadDigest: digest,
  generation: z.int().nonnegative(),
  surface: z.enum(['app', 'telegram']),
  at: z.int().nonnegative(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'superseded' | 'stopped' | 'consumed';
export type ApprovalRecord = Readonly<PendingApproval & { status: ApprovalStatus; decidedAt: number | null; surface: 'app' | 'telegram' | null }>;

export class ApprovalQueueModule {
  private readonly records = new Map<string, ApprovalRecord>();

  propose(authenticatedOwnerId: string, input: unknown): ApprovalRecord {
    const next = pendingApprovalSchema.parse(input);
    if (next.ownerId !== authenticatedOwnerId) throw new Error('approval owner mismatch');
    if (next.expiresAt <= next.createdAt) throw new Error('approval expiry precedes creation');
    if (this.records.has(this.key(next.ownerId, next.approvalId))) throw new Error('approval already exists');
    return this.store({ ...next, status: 'pending', decidedAt: null, surface: null });
  }

  decide(authenticatedOwnerId: string, input: unknown): ApprovalRecord {
    const decision = approvalDecisionSchema.parse(input);
    const record = this.open(authenticatedOwnerId, decision.approvalId, 'pending');
    if (decision.at >= record.expiresAt) throw new Error('approval expired');
    if (decision.payloadDigest !== record.payloadDigest || decision.generation !== record.generation) {
      throw new Error('approval substitution');
    }
    if (decision.surface === 'telegram' && !record.telegramScope) throw new Error('approval surface not permitted');
    return this.store({ ...record, status: decision.decision === 'approve' ? 'approved' : 'declined', decidedAt: decision.at, surface: decision.surface });
  }

  consume(authenticatedOwnerId: string, approvalId: string, payloadDigest: string, generation: number, at: number): ApprovalRecord {
    const record = this.open(authenticatedOwnerId, approvalId, 'approved');
    if (at >= record.expiresAt) throw new Error('approval expired');
    if (payloadDigest !== record.payloadDigest || generation !== record.generation) throw new Error('approval substitution');
    return this.store({ ...record, status: 'consumed' });
  }

  supersede(authenticatedOwnerId: string, approvalId: string): ApprovalRecord {
    return this.close(authenticatedOwnerId, approvalId, 'superseded');
  }

  stop(authenticatedOwnerId: string, approvalId: string): ApprovalRecord {
    return this.close(authenticatedOwnerId, approvalId, 'stopped');
  }

  pending(authenticatedOwnerId: string, at: number): readonly ApprovalRecord[] {
    return Object.freeze([...this.records.values()]
      .filter((item) => item.ownerId === authenticatedOwnerId && item.status === 'pending' && at < item.expiresAt)
      .sort((a, b) => a.createdAt - b.createdAt || a.approvalId.localeCompare(b.approvalId)));
  }

  private close(ownerId: string, approvalId: string, status: 'superseded' | 'stopped'): ApprovalRecord {
    const record = this.get(ownerId, approvalId);
    if (record.status !== 'pending' && record.status !== 'approved') throw new Error('approval not open');
    return this.store({ ...record, status });
  }

  private open(ownerId: string, approvalId: string, status: ApprovalStatus): ApprovalRecord {
    const record = this.get(ownerId, approvalId);
    if (record.status !== status) throw new Error(`approval not ${status}`);
    return record;
  }

  private get(ownerId: string, approvalId: string): ApprovalRecord {
    const record = this.records.get(this.key(ownerId, approvalId));
    if (!record) throw new Error('approval not found');
    return record;
  }

  private store(record: ApprovalRecord): ApprovalRecord {
    const stored = Object.freeze({ ...record });
    this.records.set(this.key(stored.ownerId, stored.approvalId), stored);
    return stored;
  }

  private key(ownerId: string, approvalId: string): string {
    return JSON.stringify([ownerId, approvalId]);
  }
}
