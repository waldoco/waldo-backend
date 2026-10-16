import { toolNameSchema, type ToolName } from '@waldo/contracts';
import { TOOL_CLAIM_EFFECT } from './claim-verify-effects';
import { checkClaimsAgainstReceipts, type ClaimFinding, type DoneClaim, type ReceiptState, type ToolReceipt } from './claim-verify-lint';

// The claim hook turns the tool events of one turn into typed receipts and checks typed done-claims against them
// with the existing structured check. It reads no reply wording. The claims come from note_done (done-claims.ts).
export type LoopEventLike = Readonly<{
  seq: number;
  call: Readonly<{ name: string; args?: unknown }>;
  ok: boolean;
  // Only a tool result that itself says its receipt is unavailable is unresolved.
  receiptStatus?: 'unavailable';
  code?: string;
  // The effect was done by a child task; the parent receipts it like its own so the reply can claim only receipted effects.
  delegated?: true;
  // When the tool call returned, epoch ms.
  at?: number;
}>;

// The ref a tool's receipt carries, taken from typed args only. A tool not listed has no ref.
const REF_ARG: Partial<Record<ToolName, string>> = { workspace_write: 'path', workspace_render: 'path' };
// The effects whose receipts carry a ref, so a claim can name one.
export const REF_EFFECTS: ReadonlySet<string> = new Set((Object.keys(REF_ARG) as ToolName[]).flatMap(name => TOOL_CLAIM_EFFECT[name] ?? []));

const toolName = (name: unknown): ToolName | null => {
  const parsed = toolNameSchema.safeParse(name);
  return parsed.success ? parsed.data : null;
};
const refOf = (name: ToolName, args: unknown): string | undefined => {
  const key = REF_ARG[name];
  if (!key || !args || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const receiptsFromLoopEvents = (events: readonly LoopEventLike[]): readonly ToolReceipt[] => events.flatMap(event => {
  const name = toolName(event?.call?.name);
  const effect = name ? TOOL_CLAIM_EFFECT[name] : null;
  if (!name || !effect) return [];
  const state: ReceiptState = event.ok ? 'accepted' : event.receiptStatus === 'unavailable' ? 'unresolved' : 'failed';
  const ref = refOf(name, event.call.args);
  return [{ seq: event.seq, tool: name, effect, ok: event.ok, state, ...(event.delegated ? { delegated: true } : {}), ...(ref !== undefined ? { ref } : {}) }];
});

// No fallback: a failure here throws to the caller, who owns what a failed check means.
// Returning "no findings" on error would read as "all claims verified".
export const evaluateTurnClaims = (claims: readonly DoneClaim[], events: readonly LoopEventLike[]): readonly ClaimFinding[] =>
  checkClaimsAgainstReceipts(claims, receiptsFromLoopEvents(events));
