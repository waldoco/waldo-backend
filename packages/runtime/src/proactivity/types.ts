export type ProactiveSource = 'mail' | 'calendar' | 'tasks' | 'drive' | 'workspace' | 'web' | 'conversation';
export type SourceKey = Readonly<{ source: ProactiveSource; accountId: string; collection: string }>;
export type SourceRef = SourceKey & Readonly<{ resourceId: string; revision: string }>;
export type Window = Readonly<{ days: readonly number[]; start: string; end: string }>;
export type ProactivityPolicy = Readonly<{
  revision: number; enabled: boolean; volume?: 'low' | 'normal' | 'high'; followups?: boolean; timezone: string; processingWindows: readonly Window[];
  notificationWindows: readonly Window[]; quietHours: Readonly<{ start: string; end: string }> | null;
}>;
export type SourceAccess = SourceKey & Readonly<{ epoch: number; connected: boolean }>;
export type Observation = SourceRef & Readonly<{ observedAt: number; deleted: boolean; contentRef: string | null }>;
export type Sweep = SourceKey & Readonly<{
  id: string; epoch: number; revision: number; mode: 'baseline' | 'changes'; state: 'running' | 'complete' | 'invalidated';
  cursor: string | null; pageToken: string | null; startedAt: number; completedAt: number | null; applied: number;
}>;
export type Coverage = SourceKey & Readonly<{ epoch: number; cursor: string | null; completedAt: number; applied: number }>;
export type WatchCondition = Readonly<
  { kind: 'source_change'; resourceIds: readonly string[] } |
  { kind: 'event'; eventType: 'message' | 'document' | 'location'; resourceId: string | null } |
  { kind: 'clock'; at: number } |
  { kind: 'cadence'; intervalMs: number }
>;
export type Watch = Readonly<{
  id: string; revision: number; responsibilityId: string; responsibilityRevision: number;
  sources: readonly (SourceKey & { epoch: number })[]; audience: string; condition: WatchCondition;
  state: 'active' | 'paused' | 'cancelled' | 'expired' | 'satisfied'; createdAt: number;
  nextCheckAt: number; expiresAt: number | null; subscription: Readonly<{ id: string; expiresAt: number; renewAt: number }> | null;
  closureRef: string | null;
}>;
export type WatchWake = Readonly<{
  id: string; watchId: string; watchRevision: number; eventKey: string; observedAt: number;
  state: 'pending' | 'checking' | 'checked' | 'blocked'; checkedAt: number | null; decisionId: string | null;
}>;
// These are host readback receipts, never an authorization decision produced by the model.
export type FreshCheck = Readonly<{
  refs: readonly SourceRef[]; checkedAt: number; coverage: 'complete' | 'partial';
  status: 'open' | 'handled' | 'unknown'; evidenceRefs: readonly string[];
  responsibilityRevision: number; audience: string;
}>;
export type ProactiveDecision = Readonly<{
  disposition: 'notify' | 'batch' | 'silent'; rationale: string; text: string; batchAt?: number;
}>;
export type Delivery = Readonly<{
  id: string; watchId: string; watchRevision: number; responsibilityId: string; responsibilityRevision: number;
  audience: string; sources: readonly (SourceKey & { epoch: number })[]; refs: readonly SourceRef[];
  check: FreshCheck; disposition: 'notify' | 'batch' | 'silent'; rationale: string; text: string;
  state: 'silent' | 'held' | 'pending' | 'sending' | 'delivered' | 'blocked' | 'unknown';
  createdAt: number; eligibleAt: number; expiresAt: number; attemptedAt: number | null;
  deliveredAt: number | null; receiptRef: string | null; reason: string | null;
}>;
export class ProactivityConflict extends Error {
  constructor(readonly code: 'stale_revision' | 'source_revoked' | 'invalid_input' | 'stale_source' | 'not_available') {
    super(`Proactivity operation rejected: ${code}`);
  }
}
export class SourceCursorExpired extends Error {
  constructor() { super('Source change cursor expired'); }
}
