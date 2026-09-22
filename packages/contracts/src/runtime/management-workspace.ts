import { z } from 'zod';

const workspaceItemBase = {
  id: z.string().min(1),
  ownerId: z.string().min(1),
  updatedAt: z.int().nonnegative(),
} as const;

export const workspaceConversationSchema = z.strictObject({
  ...workspaceItemBase,
  kind: z.literal('conversation'),
  chatId: z.string().min(1),
  leafId: z.string().min(1),
  surface: z.string().min(1),
  title: z.string().min(1),
});

export const workspaceMemoryCorrectionSchema = z.strictObject({
  ...workspaceItemBase,
  kind: z.literal('memory_correction'),
  memoryKey: z.string().min(1),
  status: z.enum(['active', 'superseded', 'forgotten']),
  provenance: z.string().min(1),
});

export const workspaceConnectionSchema = z.strictObject({
  ...workspaceItemBase,
  kind: z.literal('connection'),
  provider: z.string().min(1),
  accountLabel: z.string().min(1),
  custody: z.enum(['native_vault', 'managed_broker']),
  status: z.enum(['active', 'reauthorization_required', 'revoked', 'error']),
  lastFreshAt: z.int().nonnegative().nullable(),
});

export const workspaceApprovalSchema = z.strictObject({
  ...workspaceItemBase,
  kind: z.literal('approval'),
  action: z.string().min(1),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'stopped', 'undone']),
  activityRef: z.string().min(1),
});

export const workspaceActivitySchema = z.strictObject({
  ...workspaceItemBase,
  kind: z.literal('activity'),
  event: z.string().min(1),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'stopped', 'undone']),
  evidenceRef: z.string().min(1).nullable(),
});

export const workspaceHeartbeatSchema = z.strictObject({
  ...workspaceItemBase,
  kind: z.literal('heartbeat'),
  component: z.string().min(1),
  status: z.enum(['healthy', 'degraded', 'offline']),
  checkedAt: z.int().nonnegative(),
  nextCheckAt: z.int().nonnegative().nullable(),
});

export const managementWorkspaceItemSchema = z.discriminatedUnion('kind', [
  workspaceConversationSchema,
  workspaceMemoryCorrectionSchema,
  workspaceConnectionSchema,
  workspaceApprovalSchema,
  workspaceActivitySchema,
  workspaceHeartbeatSchema,
]);
export type ManagementWorkspaceItem = z.infer<typeof managementWorkspaceItemSchema>;

export type ManagementWorkspaceSnapshot = Readonly<{
  ownerId: string;
  generatedAt: number;
  items: readonly ManagementWorkspaceItem[];
}>;

export class ManagementWorkspace {
  private readonly items = new Map<string, ManagementWorkspaceItem>();

  upsert(authenticatedOwnerId: string, input: unknown): ManagementWorkspaceItem {
    const item = managementWorkspaceItemSchema.parse(input);
    if (item.ownerId !== authenticatedOwnerId) throw new Error('workspace owner mismatch');
    const key = JSON.stringify([item.kind, item.id]);
    const prior = this.items.get(key);
    if (prior && prior.ownerId !== item.ownerId) throw new Error('workspace owner mismatch');
    if (prior && prior.updatedAt > item.updatedAt) throw new Error('workspace stale update');
    const stored = Object.freeze({ ...item });
    this.items.set(key, stored);
    return stored;
  }

  snapshot(authenticatedOwnerId: string, generatedAt: number): ManagementWorkspaceSnapshot {
    const items = [...this.items.values()]
      .filter((item) => item.ownerId === authenticatedOwnerId)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
    return Object.freeze({ ownerId: authenticatedOwnerId, generatedAt, items: Object.freeze(items) });
  }
}

export type ManagementWorkspaceAttention = Readonly<{
  kind: ManagementWorkspaceItem['kind'];
  id: string;
  reason: 'approval_pending' | 'connection_attention' | 'activity_failed' | 'heartbeat_unhealthy';
}>;

export type ManagementWorkspaceView = Readonly<{
  ownerId: string;
  generatedAt: number;
  conversations: readonly z.infer<typeof workspaceConversationSchema>[];
  memoryCorrections: readonly z.infer<typeof workspaceMemoryCorrectionSchema>[];
  connections: readonly z.infer<typeof workspaceConnectionSchema>[];
  approvals: readonly z.infer<typeof workspaceApprovalSchema>[];
  activity: readonly z.infer<typeof workspaceActivitySchema>[];
  heartbeats: readonly z.infer<typeof workspaceHeartbeatSchema>[];
  attention: readonly ManagementWorkspaceAttention[];
}>;

export function projectManagementWorkspace(snapshot: ManagementWorkspaceSnapshot): ManagementWorkspaceView {
  const conversations = [];
  const memoryCorrections = [];
  const connections = [];
  const approvals = [];
  const activity = [];
  const heartbeats = [];
  const attention: ManagementWorkspaceAttention[] = [];

  for (const input of snapshot.items) {
    const item = managementWorkspaceItemSchema.parse(input);
    if (item.ownerId !== snapshot.ownerId) throw new Error('workspace owner mismatch');
    switch (item.kind) {
      case 'conversation':
        conversations.push(item);
        break;
      case 'memory_correction':
        memoryCorrections.push(item);
        break;
      case 'connection':
        connections.push(item);
        if (item.status !== 'active')
          attention.push({ kind: item.kind, id: item.id, reason: 'connection_attention' });
        break;
      case 'approval':
        approvals.push(item);
        if (item.status === 'pending')
          attention.push({ kind: item.kind, id: item.id, reason: 'approval_pending' });
        break;
      case 'activity':
        activity.push(item);
        if (item.status === 'failed')
          attention.push({ kind: item.kind, id: item.id, reason: 'activity_failed' });
        break;
      case 'heartbeat':
        heartbeats.push(item);
        if (item.status !== 'healthy')
          attention.push({ kind: item.kind, id: item.id, reason: 'heartbeat_unhealthy' });
        break;
    }
  }

  return Object.freeze({
    ownerId: snapshot.ownerId,
    generatedAt: snapshot.generatedAt,
    conversations: Object.freeze(conversations),
    memoryCorrections: Object.freeze(memoryCorrections),
    connections: Object.freeze(connections),
    approvals: Object.freeze(approvals),
    activity: Object.freeze(activity),
    heartbeats: Object.freeze(heartbeats),
    attention: Object.freeze(attention),
  });
}
