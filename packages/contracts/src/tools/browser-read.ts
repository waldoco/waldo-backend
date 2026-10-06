import { z } from 'zod';

export const browsePageProviderSchema = z.enum([
  'cloudflare_playwright',
  'browserbase_stagehand_http_v3',
]);

// Content-free diagnostics can cross model and trace seams without provider payloads,
// session identifiers, owner data, or URLs becoming an alternate disclosure channel.
export const browserReadDiagnosticSchema = z.strictObject({
  provider: browsePageProviderSchema,
  phase: z.enum([
    'configuration', 'admission', 'initialization', 'allocation', 'connection',
    'navigation', 'extraction', 'cleanup', 'complete',
  ]),
  reason: z.enum([
    'provider_disabled', 'provider_unconfigured', 'provider_http', 'provider_failure',
    'navigation_failed', 'page_http', 'empty_content', 'deadline_elapsed', 'run_closed',
    'source_rejected', 'unsafe_redirect', 'invalid_session', 'cleanup_unconfirmed', 'completed',
  ]),
  cleanup: z.enum(['not_started', 'allocation_refused', 'confirmed', 'unconfirmed', 'unknown_allocation']),
  http_status: z.int().min(100).max(599).optional(),
  configured_alternatives: z.array(browsePageProviderSchema).max(1).optional(),
  fallback_from: z.literal('cloudflare_playwright').optional(),
}).superRefine((diagnostic, ctx) => {
  if (diagnostic.configured_alternatives?.includes(diagnostic.provider)) {
    ctx.addIssue({ code: 'custom', message: 'an alternative must name another provider', path: ['configured_alternatives'] });
  }
  if (diagnostic.fallback_from !== undefined && diagnostic.provider !== 'browserbase_stagehand_http_v3') {
    ctx.addIssue({ code: 'custom', message: 'fallback provenance requires the browserbase destination', path: ['fallback_from'] });
  }
});
export type BrowserReadDiagnostic = z.infer<typeof browserReadDiagnosticSchema>;
