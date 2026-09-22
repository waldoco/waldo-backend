import { describe, expect, it, vi } from 'vitest';
import { BrowserSessionBoundary, browserCommandSchema, type BrowserSession } from './browser-session';

const session = (overrides: Partial<BrowserSession> = {}): BrowserSession => ({
  id: 'browser-1', ownerId: 'owner-a', provider: 'browserbase_stagehand_http_v3',
  providerSessionId: 'provider-1', contextHandle: null, mode: 'public', state: 'active',
  generation: 1, expiresAt: 200, updatedAt: 1, ...overrides,
});
const base = {
  ownerId: 'owner-a', sessionId: 'browser-1', generation: 1,
  capabilityManifestDigest: `sha256:${'a'.repeat(64)}`,
  idempotencyKey: 'b'.repeat(64), expiresAt: 150,
} as const;

function harness(recovery: 'known_not_applied' | 'observed' | 'indeterminate' = 'known_not_applied') {
  const executor = {
    recover: vi.fn(async () => recovery === 'observed' ? { status: recovery, result: { recovered: true } } : { status: recovery }),
    issue: vi.fn(async () => ({ issued: true })),
  };
  const boundary = new BrowserSessionBoundary({ executor, now: () => 100, authorizeManifest: (digest, operation) => digest === `sha256:${'a'.repeat(64)}` && operation !== 'end' });
  boundary.put('owner-a', session());
  return { boundary, executor };
}

describe('BrowserSessionBoundary', () => {
  it('admits only credential-free HTTPS navigation in an owner-bound public session', async () => {
    const { boundary, executor } = harness();
    await expect(boundary.dispatch('owner-a', { ...base, operation: 'navigate', url: 'https://example.com/research' })).resolves.toEqual({ issued: true });
    expect(executor.issue).toHaveBeenCalledTimes(1);
    expect(browserCommandSchema.safeParse({ ...base, operation: 'navigate', url: 'http://example.com' }).success).toBe(false);
    expect(browserCommandSchema.safeParse({ ...base, operation: 'navigate', url: 'https://user:pass@example.com' }).success).toBe(false);
  });

  it('requires a separately bound approval for every act command', async () => {
    const { boundary, executor } = harness();
    const action = { ...base, operation: 'act', actionRef: 'observed-action-1', actionDigest: `sha256:${'c'.repeat(64)}`, approvalRef: null } as const;
    await expect(boundary.dispatch('owner-a', action)).rejects.toThrow('requires approval');
    await expect(boundary.dispatch('owner-a', { ...action, approvalRef: 'approval-1' })).resolves.toEqual({ issued: true });
    expect(executor.issue).toHaveBeenCalledTimes(1);
  });

  it('fails closed on owner, generation, expiry, manifest and takeover boundaries', async () => {
    const { boundary, executor } = harness();
    const command = { ...base, operation: 'observe', instruction: 'Find article titles' } as const;
    await expect(boundary.dispatch('owner-b', command)).rejects.toThrow('owner mismatch');
    await expect(boundary.dispatch('owner-a', { ...command, generation: 2 })).rejects.toThrow('generation mismatch');
    await expect(boundary.dispatch('owner-a', { ...command, expiresAt: 100 })).rejects.toThrow('expired');
    await expect(boundary.dispatch('owner-a', { ...command, capabilityManifestDigest: `sha256:${'d'.repeat(64)}` })).rejects.toThrow('not authorized');
    boundary.put('owner-a', session({ mode: 'authenticated_takeover', generation: 2, updatedAt: 2 }));
    await expect(boundary.dispatch('owner-a', { ...command, generation: 2 })).rejects.toThrow('takeover required');
    expect(executor.issue).not.toHaveBeenCalled();
  });

  it('recovers observed work and never repeats an indeterminate browser effect', async () => {
    const observed = harness('observed');
    const command = { ...base, operation: 'observe', instruction: 'Find article titles' } as const;
    await expect(observed.boundary.dispatch('owner-a', command)).resolves.toEqual({ recovered: true });
    expect(observed.executor.issue).not.toHaveBeenCalled();
    const unknown = harness('indeterminate');
    await expect(unknown.boundary.dispatch('owner-a', command)).rejects.toThrow('outcome indeterminate');
    expect(unknown.executor.issue).not.toHaveBeenCalled();
  });
});
