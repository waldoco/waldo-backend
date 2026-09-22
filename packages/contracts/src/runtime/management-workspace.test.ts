import { describe, expect, it } from 'vitest';
import { ManagementWorkspace, managementWorkspaceItemSchema } from './management-workspace';

const base = { id: '1', ownerId: 'owner-a', updatedAt: 1 };

describe('ManagementWorkspace', () => {
  it('projects the six management surfaces in deterministic order', () => {
    const workspace = new ManagementWorkspace();
    const inputs = [
      { ...base, kind: 'heartbeat', component: 'owner-do', status: 'healthy', checkedAt: 1, nextCheckAt: 2 },
      { ...base, kind: 'conversation', chatId: 'c', leafId: 'l', surface: 'app', title: 'Chat' },
      { ...base, kind: 'memory_correction', memoryKey: 'm', status: 'active', provenance: 'user' },
      { ...base, kind: 'connection', provider: 'google', accountLabel: 'work', custody: 'native_vault', status: 'active', lastFreshAt: 1 },
      { ...base, kind: 'approval', action: 'send', status: 'pending', activityRef: 'a' },
      { ...base, kind: 'activity', event: 'drafted', status: 'completed', evidenceRef: 'e' },
    ];
    for (const input of inputs) workspace.upsert('owner-a', input);
    expect(workspace.snapshot('owner-a', 5).items.map((item) => item.kind)).toEqual([
      'activity', 'approval', 'connection', 'conversation', 'heartbeat', 'memory_correction',
    ]);
  });

  it('isolates owners and rejects cross-owner writes', () => {
    const workspace = new ManagementWorkspace();
    expect(() => workspace.upsert('owner-b', { ...base, kind: 'conversation', chatId: 'c', leafId: 'l', surface: 'app', title: 'Chat' })).toThrow('owner mismatch');
    workspace.upsert('owner-a', { ...base, kind: 'conversation', chatId: 'c', leafId: 'l', surface: 'app', title: 'Chat' });
    expect(workspace.snapshot('owner-b', 2).items).toEqual([]);
  });

  it('rejects stale updates but permits an idempotent timestamp replacement', () => {
    const workspace = new ManagementWorkspace();
    const connection = { ...base, updatedAt: 5, kind: 'connection', provider: 'google', accountLabel: 'work', custody: 'native_vault', status: 'active', lastFreshAt: 5 };
    workspace.upsert('owner-a', connection);
    expect(() => workspace.upsert('owner-a', { ...connection, updatedAt: 4 })).toThrow('stale');
    expect(workspace.upsert('owner-a', { ...connection, status: 'error' })).toMatchObject({ status: 'error' });
  });

  it('keeps finite status and custody vocabularies fail closed', () => {
    expect(managementWorkspaceItemSchema.safeParse({ ...base, kind: 'connection', provider: 'google', accountLabel: 'work', custody: 'composio', status: 'active', lastFreshAt: null }).success).toBe(false);
    expect(managementWorkspaceItemSchema.safeParse({ ...base, kind: 'approval', action: 'send', status: 'maybe', activityRef: 'a' }).success).toBe(false);
  });
});
