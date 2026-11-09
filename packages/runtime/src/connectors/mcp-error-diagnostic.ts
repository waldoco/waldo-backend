// Project Google RPC errors onto closed operational fields. Provider text, metadata
// values, resource names and URLs never become diagnostics or log fields.
const STATUSES = ['PERMISSION_DENIED', 'UNAUTHENTICATED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'UNIMPLEMENTED', 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'ABORTED', 'ALREADY_EXISTS', 'CANCELLED', 'DATA_LOSS', 'UNKNOWN', 'OUT_OF_RANGE'] as const;
const REASONS = ['SERVICE_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'ACCESS_TOKEN_EXPIRED', 'CREDENTIALS_MISSING', 'IAM_PERMISSION_DENIED', 'BILLING_DISABLED', 'CONSUMER_INVALID', 'SECURITY_POLICY_VIOLATED', 'RESOURCE_USAGE_RESTRICTION_VIOLATED', 'API_KEY_SERVICE_BLOCKED', 'ACCOUNT_STATE_INVALID'] as const;
const SERVICES = ['drivemcp.googleapis.com', 'drive.googleapis.com'] as const;
export type McpErrorDiagnostic = Readonly<{ stage: 'tools/call'; provider_status?: typeof STATUSES[number]; reason?: typeof REASONS[number]; service?: typeof SERVICES[number] }>;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const member = <T extends string>(values: readonly T[], value: unknown): T | undefined => typeof value === 'string' && values.includes(value as T) ? value as T : undefined;

export const safeMcpErrorDiagnostic = (value: unknown): McpErrorDiagnostic | undefined => {
  const source = record(value);
  if (source?.stage !== 'tools/call') return undefined;
  const provider_status = member(STATUSES, source.provider_status);
  const reason = member(REASONS, source.reason);
  const service = member(SERVICES, source.service);
  return { stage: 'tools/call', ...(provider_status ? { provider_status } : {}), ...(reason ? { reason } : {}), ...(service ? { service } : {}) };
};

export const mcpErrorDiagnostic = (result: unknown): McpErrorDiagnostic => {
  const source = record(result);
  const candidates: unknown[] = [source?.structuredContent];
  if (Array.isArray(source?.content)) for (const item of source.content) {
    const content = record(item);
    if (content?.type !== 'text' || typeof content.text !== 'string') continue;
    try { candidates.push(JSON.parse(content.text)); } catch { /* Unstructured text is not a diagnostic source. */ }
  }
  for (const candidate of candidates) {
    const outer = record(candidate);
    const error = record(outer?.error) ?? outer;
    if (!error) continue;
    const provider_status = member(STATUSES, error.status);
    const info = Array.isArray(error.details) ? error.details.map(record).find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && detail.domain === 'googleapis.com') : undefined;
    const reason = member(REASONS, info?.reason);
    const service = member(SERVICES, record(info?.metadata)?.service);
    if (provider_status || reason || service) return { stage: 'tools/call', ...(provider_status ? { provider_status } : {}), ...(reason ? { reason } : {}), ...(service ? { service } : {}) };
  }
  return { stage: 'tools/call' };
};
