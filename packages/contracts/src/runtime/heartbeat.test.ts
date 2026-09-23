import { describe, expect, it } from 'vitest';
import { HeartbeatStatusModule, type ComponentHeartbeat } from './heartbeat';

const heartbeat = (overrides: Partial<ComponentHeartbeat> = {}): ComponentHeartbeat => ({
  ownerId: 'owner-a', component: 'owner-do', generation: 1, checkedAt: 100,
  expiresAt: 200, state: 'healthy', detail: null, ...overrides,
});

describe('HeartbeatStatusModule', () => {
  it('reports deterministic aggregate state without making transport the task lifetime', () => {
    const module = new HeartbeatStatusModule();
    module.put('owner-a', heartbeat());
    module.put('owner-a', heartbeat({ component: 'scheduler', state: 'degraded', detail: 'repair pending' }));
    expect(module.status('owner-a', 150)).toMatchObject({ overall: 'degraded', components: [
      { component: 'owner-do', state: 'healthy' }, { component: 'scheduler', state: 'degraded' },
    ] });
  });

  it('treats expired checks as offline while preserving recorded state', () => {
    const module = new HeartbeatStatusModule();
    const stored = module.put('owner-a', heartbeat());
    expect(module.status('owner-a', 200)).toMatchObject({ overall: 'offline', components: [{ state: 'offline', detail: 'heartbeat expired' }] });
    expect(stored.state).toBe('healthy');
  });

  it('rejects cross-owner, stale generation, stale time and impossible expiry', () => {
    const module = new HeartbeatStatusModule();
    module.put('owner-a', heartbeat({ generation: 2 }));
    expect(() => module.put('owner-b', heartbeat())).toThrow('owner mismatch');
    expect(() => module.put('owner-a', heartbeat({ generation: 1, checkedAt: 110 }))).toThrow('stale');
    expect(() => module.put('owner-a', heartbeat({ generation: 2, checkedAt: 99 }))).toThrow('stale');
    expect(() => module.put('owner-a', heartbeat({ component: 'bad', checkedAt: 200, expiresAt: 100 }))).toThrow('expiry');
  });

  it('isolates owner status views', () => {
    const module = new HeartbeatStatusModule();
    module.put('owner-a', heartbeat());
    expect(module.status('owner-b', 150)).toEqual({ ownerId: 'owner-b', generatedAt: 150, overall: 'healthy', components: [] });
    module.put('owner-b', heartbeat({ ownerId: 'owner-b', state: 'degraded' }));
    expect(module.status('owner-a', 150).overall).toBe('healthy');
    expect(module.status('owner-b', 150).overall).toBe('degraded');
  });
});
