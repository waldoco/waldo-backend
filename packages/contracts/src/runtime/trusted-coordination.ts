import { z } from 'zod';

const windowSchema = z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() });

export const trustedRelationshipSchema = z.strictObject({
  ownerId: z.string().min(1),
  peerOwnerId: z.string().min(1),
  purposes: z.array(z.literal('scheduling')).min(1),
  establishedAt: z.int().nonnegative(),
});
export type TrustedRelationship = z.infer<typeof trustedRelationshipSchema>;

export const coordinationRequestSchema = z.strictObject({
  requestId: z.string().min(1),
  requesterOwnerId: z.string().min(1),
  recipientOwnerId: z.string().min(1),
  purpose: z.literal('scheduling'),
  durationMinutes: z.int().min(5).max(480),
  windows: z.array(windowSchema).min(1).max(20),
  createdAt: z.int().nonnegative(),
  expiresAt: z.int().nonnegative(),
});
export type CoordinationRequest = z.infer<typeof coordinationRequestSchema>;

export const coordinationResponseSchema = z.strictObject({
  requesterOwnerId: z.string().min(1),
  requestId: z.string().min(1),
  decision: z.enum(['accept', 'decline']),
  slot: windowSchema.nullable(),
  at: z.int().nonnegative(),
});

type RelationshipStatus = 'active' | 'revoked' | 'blocked';
type RequestStatus = 'pending' | 'accepted' | 'declined' | 'confirmed' | 'withdrawn';
type StoredRequest = Readonly<CoordinationRequest & { status: RequestStatus; slot: z.infer<typeof windowSchema> | null; confirmedAt: number | null }>;

export type CoordinationView = Readonly<{
  requestId: string;
  role: 'requester' | 'recipient';
  peerOwnerId: string;
  status: 'pending' | 'accepted' | 'confirmed' | 'declined' | 'closed' | 'expired';
  durationMinutes: number;
  windows: readonly z.infer<typeof windowSchema>[];
  slot: z.infer<typeof windowSchema> | null;
}>;
export type CoordinationReceipt = Readonly<{ requestId: string; ownerId: string; peerOwnerId: string; purpose: 'scheduling'; slot: z.infer<typeof windowSchema>; confirmedAt: number }>;
export type CoordinationReport = Readonly<{ reporterOwnerId: string; reportedOwnerId: string; at: number }>;

const MINUTE = 60_000;

export class TrustedCoordinationModule {
  private readonly relationships = new Map<string, Readonly<TrustedRelationship & { status: RelationshipStatus }>>();
  private readonly requests = new Map<string, StoredRequest>();
  private readonly reportLog: CoordinationReport[] = [];

  establish(authenticatedOwnerId: string, input: unknown): void {
    const next = trustedRelationshipSchema.parse(input);
    if (next.ownerId !== authenticatedOwnerId) throw new Error('relationship owner mismatch');
    if (next.ownerId === next.peerOwnerId) throw new Error('relationship peer invalid');
    if (this.relationships.get(this.pair(next.ownerId, next.peerOwnerId))?.status === 'blocked') throw new Error('relationship blocked');
    this.relationships.set(this.pair(next.ownerId, next.peerOwnerId), Object.freeze({ ...next, status: 'active' }));
  }

  revoke(authenticatedOwnerId: string, peerOwnerId: string): void {
    this.end(authenticatedOwnerId, peerOwnerId, 'revoked');
  }

  block(authenticatedOwnerId: string, peerOwnerId: string, report: boolean, at: number): void {
    this.end(authenticatedOwnerId, peerOwnerId, 'blocked');
    if (report) this.reportLog.push(Object.freeze({ reporterOwnerId: authenticatedOwnerId, reportedOwnerId: peerOwnerId, at }));
  }

  reports(): readonly CoordinationReport[] {
    return Object.freeze([...this.reportLog]);
  }

  request(authenticatedOwnerId: string, input: unknown): CoordinationView {
    const next = coordinationRequestSchema.parse(input);
    if (next.requesterOwnerId !== authenticatedOwnerId) throw new Error('coordination owner mismatch');
    if (next.expiresAt <= next.createdAt) throw new Error('coordination expiry precedes creation');
    if (next.windows.some((item) => item.end - item.start < next.durationMinutes * MINUTE)) throw new Error('coordination window too short');
    this.assertMutual(next.requesterOwnerId, next.recipientOwnerId, next.purpose);
    if (this.requests.has(this.pair(next.requesterOwnerId, next.requestId))) throw new Error('coordination request exists');
    return this.view(authenticatedOwnerId, this.store({ ...next, status: 'pending', slot: null, confirmedAt: null }), next.createdAt);
  }

  respond(authenticatedOwnerId: string, input: unknown): CoordinationView {
    const response = coordinationResponseSchema.parse(input);
    const request = this.get(response.requesterOwnerId, response.requestId);
    if (request.recipientOwnerId !== authenticatedOwnerId) throw new Error('coordination request not found');
    this.assertLive(request, 'pending', response.at);
    if (response.decision === 'decline') return this.view(authenticatedOwnerId, this.store({ ...request, status: 'declined' }), response.at);
    const slot = response.slot;
    if (!slot || slot.end - slot.start !== request.durationMinutes * MINUTE
      || !request.windows.some((item) => item.start <= slot.start && slot.end <= item.end)) {
      throw new Error('coordination slot outside offer');
    }
    return this.view(authenticatedOwnerId, this.store({ ...request, status: 'accepted', slot }), response.at);
  }

  confirm(authenticatedOwnerId: string, requestId: string, at: number): CoordinationView {
    const request = this.get(authenticatedOwnerId, requestId);
    if (request.requesterOwnerId !== authenticatedOwnerId) throw new Error('coordination request not found');
    this.assertLive(request, 'accepted', at);
    return this.view(authenticatedOwnerId, this.store({ ...request, status: 'confirmed', confirmedAt: at }), at);
  }

  withdraw(authenticatedOwnerId: string, requestId: string, at: number): CoordinationView {
    const request = this.get(authenticatedOwnerId, requestId);
    if (request.requesterOwnerId !== authenticatedOwnerId) throw new Error('coordination request not found');
    if (request.status !== 'pending' && request.status !== 'accepted') throw new Error('coordination request not open');
    return this.view(authenticatedOwnerId, this.store({ ...request, status: 'withdrawn' }), at);
  }

  list(authenticatedOwnerId: string, at: number): readonly CoordinationView[] {
    return Object.freeze([...this.requests.values()]
      .filter((item) => item.requesterOwnerId === authenticatedOwnerId || item.recipientOwnerId === authenticatedOwnerId)
      .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId))
      .map((item) => this.view(authenticatedOwnerId, item, at)));
  }

  receipts(authenticatedOwnerId: string): readonly CoordinationReceipt[] {
    return Object.freeze([...this.requests.values()]
      .filter((item) => item.status === 'confirmed' && (item.requesterOwnerId === authenticatedOwnerId || item.recipientOwnerId === authenticatedOwnerId))
      .map((item) => Object.freeze({
        requestId: item.requestId,
        ownerId: authenticatedOwnerId,
        peerOwnerId: item.requesterOwnerId === authenticatedOwnerId ? item.recipientOwnerId : item.requesterOwnerId,
        purpose: item.purpose,
        slot: item.slot!,
        confirmedAt: item.confirmedAt!,
      })));
  }

  private view(ownerId: string, request: StoredRequest, at: number): CoordinationView {
    const role = request.requesterOwnerId === ownerId ? 'requester' : 'recipient';
    const open = request.status === 'pending' || request.status === 'accepted';
    const severed = open && !this.isMutual(request.requesterOwnerId, request.recipientOwnerId, request.purpose);
    const status = severed || request.status === 'withdrawn' ? 'closed'
      : open && at >= request.expiresAt ? (role === 'requester' ? 'closed' : 'expired')
        : request.status === 'declined' && role === 'requester' ? 'closed'
          : request.status;
    return Object.freeze({
      requestId: request.requestId,
      role,
      peerOwnerId: role === 'requester' ? request.recipientOwnerId : request.requesterOwnerId,
      status,
      durationMinutes: request.durationMinutes,
      windows: request.windows,
      slot: request.slot,
    });
  }

  private assertLive(request: StoredRequest, status: RequestStatus, at: number): void {
    if (request.status !== status) throw new Error(`coordination request not ${status}`);
    if (at >= request.expiresAt) throw new Error('coordination request expired');
    this.assertMutual(request.requesterOwnerId, request.recipientOwnerId, request.purpose);
  }

  private assertMutual(a: string, b: string, purpose: 'scheduling'): void {
    if (!this.isMutual(a, b, purpose)) throw new Error('coordination relationship not mutual');
  }

  private isMutual(a: string, b: string, purpose: 'scheduling'): boolean {
    return [this.pair(a, b), this.pair(b, a)].every((key) => {
      const item = this.relationships.get(key);
      return item?.status === 'active' && item.purposes.includes(purpose);
    });
  }

  private end(ownerId: string, peerOwnerId: string, status: 'revoked' | 'blocked'): void {
    const key = this.pair(ownerId, peerOwnerId);
    const prior = this.relationships.get(key);
    if (!prior && status === 'revoked') throw new Error('relationship not found');
    this.relationships.set(key, Object.freeze({ ownerId, peerOwnerId, purposes: prior?.purposes ?? ['scheduling' as const], establishedAt: prior?.establishedAt ?? 0, status }));
  }

  private get(requesterOwnerId: string, requestId: string): StoredRequest {
    const request = this.requests.get(this.pair(requesterOwnerId, requestId));
    if (!request) throw new Error('coordination request not found');
    return request;
  }

  private store(request: StoredRequest): StoredRequest {
    const stored = Object.freeze({ ...request, windows: Object.freeze(request.windows.map((item) => Object.freeze({ ...item }))) as StoredRequest['windows'] });
    this.requests.set(this.pair(stored.requesterOwnerId, stored.requestId), stored);
    return stored;
  }

  private pair(first: string, second: string): string {
    return JSON.stringify([first, second]);
  }
}
