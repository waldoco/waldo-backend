import { describe, expect, it } from 'vitest';
import { assertBrowserStep, decideBrowserFallback, type BrowserFallbackPolicy } from './browser-policy';

const policy = (overrides: Partial<BrowserFallbackPolicy> = {}): BrowserFallbackPolicy => ({
  ownerId: 'owner-a', purpose: 'public research', connectorAvailable: false,
  allowedHosts: ['example.com'], allowedOperations: ['navigate', 'observe', 'extract'],
  maxSteps: 8, maxDurationMs: 60_000, modelDataClasses: ['public_text'],
  authenticated: false, requiresTakeover: false, ...overrides,
});

describe('browser fallback policy', () => {
  it('prefers a typed connector whenever one is available', () => {
    expect(decideBrowserFallback('owner-a', policy({ connectorAvailable: true }))).toEqual({ route: 'connector', reason: 'connector_preferred' });
  });

  it('admits bounded public browser fallback and enforces host, operation and budget', () => {
    const decision = decideBrowserFallback('owner-a', policy());
    expect(decision.route).toBe('browser');
    if (decision.route !== 'browser') throw new Error('unexpected route');
    expect(() => assertBrowserStep(decision.policy, { operation: 'extract', url: 'https://example.com/a', completedSteps: 2, elapsedMs: 500 })).not.toThrow();
    expect(() => assertBrowserStep(decision.policy, { operation: 'extract', url: 'https://evil.test/a', completedSteps: 2, elapsedMs: 500 })).toThrow('host not allowed');
    expect(() => assertBrowserStep(decision.policy, { operation: 'act', url: 'https://example.com/a', completedSteps: 2, elapsedMs: 500 })).toThrow('operation not allowed');
    expect(() => assertBrowserStep(decision.policy, { operation: 'extract', url: 'https://example.com/a', completedSteps: 8, elapsedMs: 500 })).toThrow('budget exhausted');
  });

  it('routes authenticated and effect-capable flows to takeover instead of autonomous browser', () => {
    expect(() => decideBrowserFallback('owner-a', policy({ authenticated: true }))).toThrow('requires takeover');
    expect(() => decideBrowserFallback('owner-a', policy({ allowedOperations: ['navigate', 'act'] }))).toThrow('requires takeover');
    expect(decideBrowserFallback('owner-a', policy({ authenticated: true, requiresTakeover: true })).route).toBe('takeover');
  });

  it('rejects cross-owner policy use', () => {
    expect(() => decideBrowserFallback('owner-b', policy())).toThrow('owner mismatch');
  });
});
