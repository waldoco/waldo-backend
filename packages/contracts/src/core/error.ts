import { z } from 'zod';

// Branded so an ISO-8601 timestamp can't be passed where a plain string is expected.
// z.iso.datetime is Zod 4's ISO validator; offset:true also admits +HH:MM, not only 'Z'.
export const iso8601Schema = z.iso.datetime({ offset: true }).brand<'ISO8601'>();
export type ISO8601 = z.infer<typeof iso8601Schema>;

export const errorCodeSchema = z.enum([
  'auth_failed',
  'not_found',
  'forbidden',
  'rate_limited',
  'transient',
  'oversize',
  'invalid_args',
  // A tool/adapter ran and deterministically rejected the call (e.g. MCP isError per SEP-1303):
  // not transient, not an auth/lookup failure - the model should correct and retry differently.
  'rejected',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// One shape for every tool refusal, whichever stage refused it: a stable machine code, one
// sentence on what went wrong, one sentence the model can act on, and whether the same call
// may succeed if made again. The adapter codes above are members, so a tool's own typed
// failure needs no translation; the rest name the dispatcher, hook and loop stages.
export const toolErrorCodeSchema = z.enum([
  // The tool ran and refused (its ErrorCode, verbatim).
  ...errorCodeSchema.options,
  // The dispatcher refused before or after the handler.
  'unknown_tool',
  'unauthenticated',
  'acl_denied',
  'handler_unavailable',
  'handler_acl_drift',
  'taint_needs_approval',
  'approval_denied',
  'approval_check_unavailable',
  'egress_denied',
  'sanitise_denied',
  'hook_denied',
  'hook_failed',
  'handler_failed',
  'effect_receipt_unavailable',
  'invalid_handler_result',
  'invalid_tool_result',
  'result_oversize',
  // The tool loop refused without dispatching.
  'invalid_json_args',
  'repeat_refusal',
  'tools_withdrawn',
  'browsing_withheld',
  // The host held the call before it ran: the owner's monthly spend ceiling covers this paid tool.
  'budget_exhausted',
]);
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;

export const toolErrorSchema = z.strictObject({
  code: toolErrorCodeSchema,
  cause: z.string().min(1),
  fix: z.string().min(1),
  retryable: z.boolean(),
});
export type ToolError = z.infer<typeof toolErrorSchema>;

// Security and infrastructure causes are fixed text: a halt's internal reason never reaches the
// model through this table. Only `transient` is retryable - a repeat of the same call is
// evidence-free for every other code.
export const TOOL_ERRORS: Readonly<Record<ToolErrorCode, Readonly<Omit<ToolError, 'code'>>>> = Object.freeze({
  auth_failed: { cause: 'The tool is not connected or its credentials were refused.', fix: 'Do not retry; tell the owner this service needs connecting.', retryable: false },
  not_found: { cause: 'The tool could not find what the call named.', fix: 'Check the identifier or search for it first, then call again with the right one.', retryable: false },
  forbidden: { cause: 'The tool refused this call as not permitted.', fix: 'Do not repeat it; tell the owner what you were trying to do.', retryable: false },
  rate_limited: { cause: 'The tool is rate limited right now.', fix: 'Do not call it again this turn; use what you have or tell the owner it is rate limited.', retryable: false },
  transient: { cause: 'The tool failed for a passing reason.', fix: 'Try the same call once more; if it fails again, tell the owner.', retryable: true },
  oversize: { cause: 'The tool refused a payload that was too large.', fix: 'Narrow the request or shorten the content and call again.', retryable: false },
  invalid_args: { cause: 'The arguments did not match the tool schema.', fix: 'Fix the named arguments to match the schema and call again.', retryable: false },
  rejected: { cause: 'The tool ran and deterministically rejected the call.', fix: 'Do not repeat the same call; change the approach or tell the owner.', retryable: false },
  unknown_tool: { cause: 'No tool by that name exists.', fix: 'Call one of the tools listed for this turn.', retryable: false },
  unauthenticated: { cause: 'The call carried no authenticated owner.', fix: 'Stop calling tools this turn and answer with what you have.', retryable: false },
  acl_denied: { cause: 'This tool is not allowed for this turn.', fix: 'Use a tool listed for this turn or tell the owner it is unavailable here.', retryable: false },
  handler_unavailable: { cause: 'This tool is not set up on this Waldo.', fix: 'Use another tool or tell the owner this capability is not set up.', retryable: false },
  handler_acl_drift: { cause: 'This tool is misconfigured.', fix: 'Do not retry; tell the owner the tool is misconfigured.', retryable: false },
  taint_needs_approval: { cause: 'The arguments came from an email or web page, so this action needs the owner\'s approval first.', fix: 'Call propose_action with this exact tool and arguments; the owner gets a card to approve.', retryable: false },
  approval_denied: { cause: 'The owner has not approved this action.', fix: 'Propose it for approval instead of running it directly.', retryable: false },
  approval_check_unavailable: { cause: 'The approval check could not run.', fix: 'Do not retry; tell the owner the action could not be approved right now.', retryable: false },
  egress_denied: { cause: 'That address cannot be opened from this Waldo.', fix: 'Try another source or tell the owner the address is not reachable.', retryable: false },
  sanitise_denied: { cause: 'The content failed a privacy check.', fix: 'Remove the sensitive detail (health values, secrets, personal data) or ask the owner before sharing it.', retryable: false },
  hook_denied: { cause: 'A safety check refused this call.', fix: 'Do not repeat it; tell the owner what you were trying to do.', retryable: false },
  hook_failed: { cause: 'A tool check could not run.', fix: 'Do not retry this turn; tell the owner the tool is unavailable right now.', retryable: false },
  handler_failed: { cause: 'The tool threw while running.', fix: 'Do not repeat the same call; tell the owner it failed.', retryable: false },
  effect_receipt_unavailable: { cause: 'The tool could not prove its effect settled.', fix: 'Do not retry; tell the owner the outcome is unconfirmed.', retryable: false },
  invalid_handler_result: { cause: 'The tool returned a malformed result.', fix: 'Do not repeat the same call; tell the owner the tool misbehaved.', retryable: false },
  invalid_tool_result: { cause: 'The tool result failed validation after it ran.', fix: 'Do not repeat the same call; tell the owner the result could not be used.', retryable: false },
  result_oversize: { cause: 'The result was too large to show.', fix: 'Narrow the request (smaller range, fewer items) and call again.', retryable: false },
  invalid_json_args: { cause: 'The arguments were not valid JSON.', fix: 'Send the arguments as one JSON object matching the tool schema.', retryable: false },
  repeat_refusal: { cause: 'Same call already made this turn.', fix: 'Use the result it already returned.', retryable: false },
  tools_withdrawn: { cause: 'No more tool calls can run this turn.', fix: 'Answer now with what you found or did and what is left.', retryable: false },
  browsing_withheld: { cause: 'Browsing is unavailable on this Waldo for the rest of this turn.', fix: 'Use what you have or say what you could not read.', retryable: false },
  budget_exhausted: { cause: 'The owner\'s monthly spend ceiling is reached, so this paid tool is held; nothing ran.', fix: 'Do not call it again this month. Keep going without it: web_search and the other read tools still work and answers come from the cheaper model, so finish what you can with them and tell the owner what was held.', retryable: false },
});

// `cause` may be overridden only with text the model is allowed to see: its own argument
// detail, or a tool's own error text, which the dispatcher already bounds.
export const toolError = (code: ToolErrorCode, cause?: string): ToolError => ({
  code,
  cause: cause ?? TOOL_ERRORS[code].cause,
  fix: TOOL_ERRORS[code].fix,
  retryable: TOOL_ERRORS[code].retryable,
});

// Uniform return of every adapter method. A generic discriminated union kept as a static
// type, not a Zod schema: a generic Zod schema would be a factory function, not a value,
// and the contract callers depend on is the shape, not a runtime validator.
export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: ErrorCode };
