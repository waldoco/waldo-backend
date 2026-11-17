// The ceiling on the tool definitions the model sees each round, in estimated tokens (bytes / 4), on either provider's wire.
// It guards spend and creep, not reach: deferred tools still load when a turn needs them. Set about 3% above the largest
// measured round (6,121, the tapback round on OpenAI), so the tools Waldo uses unprompted stay core and anything else that
// grows the round has to be a decision.
export const TOOL_DEFINITION_BUDGET_TOKENS = 6_300;
