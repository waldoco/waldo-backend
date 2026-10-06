import { browserReadDiagnosticSchema, errorCodeSchema } from '@waldo/contracts';
import type { ToolDispatchErrorReason } from '../tools/dispatcher';

const dispatchReasons = {
  unknown_tool: true, handler_unavailable: true, effect_receipt_unavailable: true,
  handler_acl_drift: true, acl_denied: true, invalid_args: true, approval_denied: true,
  egress_denied: true, sanitise_denied: true, hook_halt: true, handler_failed: true,
  invalid_handler_result: true, tool_result_error: true, invalid_tool_result: true,
  result_oversize: true,
} satisfies Record<ToolDispatchErrorReason, true>;

// Only the finite diagnostic vocabulary reaches capture-off traces; provider payloads stay
// behind the existing content switch. Parse again here rather than trusting the caller.
export const browserReadTraceCode = (value: unknown, code?: unknown, reason?: unknown): string | undefined => {
  const parsed = browserReadDiagnosticSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const diagnostic = parsed.data;
  const fields = ['browser_read', diagnostic.provider, diagnostic.phase, diagnostic.reason,
    diagnostic.cleanup, diagnostic.http_status ?? 'none', diagnostic.fallback_from ?? 'none'];
  if (code !== undefined || reason !== undefined) {
    const parsedCode = errorCodeSchema.safeParse(code);
    if (!parsedCode.success || typeof reason !== 'string' || !Object.hasOwn(dispatchReasons, reason)) return undefined;
    fields.push(parsedCode.data, reason);
  }
  return fields.join(':');
};

export const gateBrowserReadTraceCode = (code: unknown): string | undefined => {
  if (typeof code !== 'string') return undefined;
  // Existing dispatcher codes keep their historical behavior; browser diagnostics own only
  // this reserved prefix, which must never become an alternate free-form content channel.
  if (!code.startsWith('browser_read')) return code;
  const parts = code.split(':');
  if (parts.length !== 7 && parts.length !== 9) return undefined;
  const [, provider, phase, reason, cleanup, status, fallback, dispatchCode, dispatchReason] = parts;
  const encoded = browserReadTraceCode({ provider, phase, reason, cleanup,
    ...(status === 'none' ? {} : { http_status: Number(status) }),
    ...(fallback === 'none' ? {} : { fallback_from: fallback }),
  }, dispatchCode, dispatchReason);
  return encoded === code ? code : undefined;
};
