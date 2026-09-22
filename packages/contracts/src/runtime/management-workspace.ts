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
