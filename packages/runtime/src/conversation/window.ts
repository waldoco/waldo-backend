import { MODEL_CONTEXT_SPECS, WALDO_CHAT_MODEL, type ConversationModelMessage, type ModelName } from '@waldo/contracts';

// F1 (paper audit, arXiv 2609.20804): the chat turn path had NO input-context bound - the full
// conversation ancestor path went to the model every turn, so overflow terminated the turn with a
// provider error (the paper\'s T0 failure mode). This module is the bound: a token-aware rolling
// window over the assembled messages with a defined overflow behavior (drop oldest, never fail).
//
// Budget rationale: the current chat model\'s verified context window is 400k tokens
// (OpenAI/Azure model docs, verified 2026-09-27). 100k bounds the conversation-history
// share, leaving headroom for the composed system prompt, in-turn tool turns and the 4096-token
// output pin, and caps per-turn input cost under the cheapest-passing routing rule.
// Wire ceiling for the conversation-history share of the input, in the ADR/owner-decision
// (2026-09-26) pattern: fixed ceilings stay as hard caps and the per-model derivation may only
// TIGHTEN below them (same construction as deriveContextBudgetChars in contracts/model/context-budget).
export const CONVERSATION_HISTORY_WIRE_CEILING_TOKENS = 100_000;

// Effective history budget for the active model: the model's usable window (context minus output
// reserve minus safety margin, from the verified roster specs) tightened to the wire ceiling.
export const conversationInputBudgetTokens = (model: ModelName = WALDO_CHAT_MODEL): number => {
  const spec = MODEL_CONTEXT_SPECS[model];
  const usable = Math.max(spec.context_window_tokens - spec.output_reserve_tokens - spec.safety_margin_tokens, 0);
  return Math.min(usable, CONVERSATION_HISTORY_WIRE_CEILING_TOKENS);
};

// Default budget for the current chat model: 100k (every roster model's usable window exceeds the
// ceiling today, so the ceiling is the effective budget; a smaller-window model tightens instead).
export const CONVERSATION_INPUT_BUDGET_TOKENS = conversationInputBudgetTokens();

// Heuristic estimator: 4 bytes per token (UTF-8) plus a small per-message framing overhead.
// Deliberately conservative-simple; no tokenizer dependency in the hot path.
export const estimateMessageTokens = (message: ConversationModelMessage): number =>
  Math.ceil(new TextEncoder().encode(message.content).byteLength / 4) + 8;

export type ConversationWindowStats = Readonly<{
  kept: number;
  dropped: number;
  estimated_tokens: number;
  budget_tokens: number;
}>;

// Keeps the newest messages that fit the budget, oldest dropped first. The final message (the
// current owner turn) is always kept even if it alone exceeds the budget - overflow degrades to
// a shorter window, never to a failed turn.
export const windowModelMessages = (
  messages: readonly ConversationModelMessage[],
  budgetTokens: number = CONVERSATION_INPUT_BUDGET_TOKENS,
): Readonly<{ messages: readonly ConversationModelMessage[]; stats: ConversationWindowStats }> => {
  let tokens = 0;
  let firstKept = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = estimateMessageTokens(messages[index]!);
    if (index < messages.length - 1 && tokens + cost > budgetTokens) break;
    tokens += cost;
    firstKept = index;
  }
  const kept = messages.slice(firstKept);
  return {
    messages: kept,
    stats: { kept: kept.length, dropped: messages.length - kept.length, estimated_tokens: tokens, budget_tokens: budgetTokens },
  };
};
