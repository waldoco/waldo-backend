// The ceiling on the tool definitions the model sees each round, in estimated tokens (bytes / 4), on either provider's wire.
// It guards spend and creep, not reach: deferred tools still load when a turn needs them.
export const TOOL_DEFINITION_BUDGET_TOKENS = 4_200;
