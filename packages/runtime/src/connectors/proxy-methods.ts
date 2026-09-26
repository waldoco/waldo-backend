// The connector-proxy method allowlist, shared verbatim by the runtime client
// (connections.ts) and the Edge Function (supabase/functions/connector-proxy/index.ts): a
// method must pass BOTH sides, so the list lives once here. Adding a method means naming its
// scope-gate feature and its arg bounds below, or it does not ship.
import { GOOGLE_FEATURE_SCOPES, type GoogleFeature } from './google';

export const PROXY_METHODS = ['events', 'draft', 'event', 'createEvent', 'moveEvent', 'cancelEvent', 'changedEvents', 'newMail', 'tasks', 'sendRaw', 'findSentByMessageId'] as const;
export type ProxyMethod = (typeof PROXY_METHODS)[number];

// Scope gate: the stored grant must cover the method's feature before the proxy spends the
// token on it. Scope is not permission - tool-level owner approval still gates every effect.
export const PROXY_METHOD_FEATURE: Readonly<Record<ProxyMethod, GoogleFeature>> = {
  events: 'calendar', event: 'calendar', createEvent: 'calendar', moveEvent: 'calendar', cancelEvent: 'calendar', changedEvents: 'calendar',
  draft: 'mail', newMail: 'mail', sendRaw: 'mail', findSentByMessageId: 'mail',
  tasks: 'tasks',
};

// Arg bounds, enforced by the Edge Function before any token is touched. The generic 2MB args
// envelope bounds every method; the newer methods get strict shapes. Bounds, never content
// inspection - args are never logged or stored by the proxy.
const GENERIC_ARGS_LIMIT = 2_000_000;
const RAW_MIME_LIMIT = 1_000_000;
const SHORT = 512;
const TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'in_progress', 'done', 'all']);
const isBoundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export const validateProxyArgs = (method: ProxyMethod, args: unknown): string | null => {
  if (!Array.isArray(args)) return 'args must be an array';
  if (JSON.stringify(args).length > GENERIC_ARGS_LIMIT) return 'args too large';
  switch (method) {
    case 'sendRaw': {
      const [raw, threadId] = args as unknown[];
      if (!isBoundedString(raw, RAW_MIME_LIMIT)) return 'sendRaw needs bounded raw MIME bytes';
      if (threadId !== undefined && !isBoundedString(threadId, SHORT)) return 'sendRaw thread id must be a short string';
      return null;
    }
    case 'findSentByMessageId': {
      const [messageId] = args as unknown[];
      return isBoundedString(messageId, SHORT) ? null : 'findSentByMessageId needs a bounded message id string';
    }
    case 'tasks': {
      const [status, limit] = args as unknown[];
      if (!isBoundedString(status, SHORT) || !TASK_STATUSES.has(status)) return 'tasks needs a known status filter';
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return 'tasks limit must be an integer 1..100';
      return null;
    }
    default:
      return null;
  }
};

// Feature scopes are re-exported here so the Edge Function imports one module, not two.
export { GOOGLE_FEATURE_SCOPES };

// Turn/trace correlation key: opaque, bounded, non-PII (the turn trace id, e.g. tg-904957567).
// Both sides enforce the shape - the Worker omits an invalid value, the Edge Function rejects
// it - so structured logs join the exact turn without ever carrying do_name, connection, args,
// account, provider content or tokens.
export const CORRELATION_TRACE_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
export const validCorrelationTrace = (value: unknown): string | undefined =>
  typeof value === 'string' && CORRELATION_TRACE_SHAPE.test(value) ? value : undefined;
