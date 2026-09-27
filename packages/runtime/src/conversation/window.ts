import type { ConversationModelMessage } from '@waldo/contracts';

// F1 (paper audit, arXiv 2609.20804): the chat turn path had NO input-context bound - the full
// conversation ancestor path went to the model every turn, so overflow terminated the turn with a
// provider error (the paper\'s T0 failure mode). This module is the bound: a token-aware rolling
// window over the assembled messages with a defined overflow behavior (drop oldest, never fail).
//
// Budget rationale: the current chat model\'s verified context window is 400k tokens
// (gpt-5-nano; OpenAI/Azure model docs, verified 2026-09-27). 100k bounds the conversation-history
// share, leaving headroom for the composed system prompt, in-turn tool turns and the 4096-token
// output pin, and caps per-turn input cost under the cheapest-passing routing rule.
export const CONVERSATION_INPUT_BUDGET_TOKENS = 100_000;

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
