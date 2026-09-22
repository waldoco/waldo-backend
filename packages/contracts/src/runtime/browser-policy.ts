import { z } from 'zod';

export const browserFallbackPolicySchema = z.strictObject({
  ownerId: z.string().min(1),
  purpose: z.string().min(1),
  connectorAvailable: z.boolean(),
  allowedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1),
  allowedOperations: z.array(z.enum(['navigate', 'observe', 'extract', 'act'])).min(1),
  maxSteps: z.int().min(1).max(100),
  maxDurationMs: z.int().min(1).max(600_000),
  modelDataClasses: z.array(z.string().min(1)),
  authenticated: z.boolean(),
  requiresTakeover: z.boolean(),
});
export type BrowserFallbackPolicy = z.infer<typeof browserFallbackPolicySchema>;

export type BrowserFallbackDecision = Readonly<
  | { route: 'connector'; reason: 'connector_preferred' }
  | { route: 'browser'; policy: BrowserFallbackPolicy }
  | { route: 'takeover'; policy: BrowserFallbackPolicy }
>;

export function decideBrowserFallback(authenticatedOwnerId: string, input: unknown): BrowserFallbackDecision {
  const policy = browserFallbackPolicySchema.parse(input);
  if (policy.ownerId !== authenticatedOwnerId) throw new Error('browser policy owner mismatch');
  if (policy.connectorAvailable) return Object.freeze({ route: 'connector', reason: 'connector_preferred' });
  if (policy.authenticated && !policy.requiresTakeover) throw new Error('authenticated browser automation requires takeover policy');
  if (policy.allowedOperations.includes('act') && !policy.requiresTakeover) throw new Error('browser act requires takeover policy');
  const normalized = Object.freeze({
    ...policy,
    allowedHosts: [...new Set(policy.allowedHosts)].sort(),
    allowedOperations: [...new Set(policy.allowedOperations)],
    modelDataClasses: [...new Set(policy.modelDataClasses)].sort(),
  });
  return policy.requiresTakeover
    ? Object.freeze({ route: 'takeover' as const, policy: normalized })
    : Object.freeze({ route: 'browser' as const, policy: normalized });
}

export function assertBrowserStep(policy: BrowserFallbackPolicy, input: Readonly<{
  operation: 'navigate' | 'observe' | 'extract' | 'act';
  url: string;
  completedSteps: number;
  elapsedMs: number;
}>): void {
  const host = /^https:\/\/([^/@]+)(?:\/|$)/.exec(input.url)?.[1]?.toLowerCase();
  if (!host || !policy.allowedHosts.includes(host)) throw new Error('browser host not allowed');
  if (!policy.allowedOperations.includes(input.operation)) throw new Error('browser operation not allowed');
  if (input.completedSteps >= policy.maxSteps || input.elapsedMs >= policy.maxDurationMs) throw new Error('browser budget exhausted');
}
