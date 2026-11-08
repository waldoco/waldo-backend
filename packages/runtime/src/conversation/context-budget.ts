// The sizes that bound an owner turn's context, read from WALDO_SWITCHES so staging traces can tune them without a code
// change. Each is fixed for a deploy, so the provider's cache of the stable prefix holds between turns. A value that is not
// a valid size of its kind reads as the default; the switches test checks both deployed configs carry valid values.
export type ContextBudget = Readonly<{
  // WALDO_CALL_CEILINGS: a chat's history, the conversation layer of a call aiming at the chat ceiling.
  historyTokens: number;
  // WALDO_CALL_CEILINGS: what a reply call's whole input aims at, by call class, and the point past which a turn's earlier
  // tool results are cleared.
  chatCeilingTokens: number;
  jobCeilingTokens: number;
  hardCeilingTokens: number;
  // WALDO_STEPPED_WINDOW: the share of the history budget a stepped cut keeps.
  steppedTarget: number;
  // WALDO_CONTEXT_CAPS: past this many characters of tool results, every result but the latest few is cleared; and the
  // characters of standing orders and of quests a turn reads.
  clearAtChars: number;
  keepLatest: number;
  standingOrdersChars: number;
  questsChars: number;
}>;

export const CONTEXT_BUDGET: ContextBudget = {
  historyTokens: 22_000, chatCeilingTokens: 40_000, jobCeilingTokens: 25_000, hardCeilingTokens: 80_000,
  steppedTarget: 0.5, clearAtChars: 120_000, keepLatest: 3, standingOrdersChars: 3_000, questsChars: 3_000,
};

export const CONTEXT_BUDGET_SETTINGS: Readonly<Record<keyof ContextBudget, string>> = {
  historyTokens: 'WALDO_HISTORY_BUDGET_TOKENS', chatCeilingTokens: 'WALDO_CHAT_CEILING_TOKENS', jobCeilingTokens: 'WALDO_JOB_CEILING_TOKENS',
  hardCeilingTokens: 'WALDO_HARD_CEILING_TOKENS', steppedTarget: 'WALDO_STEPPED_WINDOW_TARGET', clearAtChars: 'WALDO_TOOL_RESULTS_CLEAR_AT_CHARS',
  keepLatest: 'WALDO_TOOL_RESULTS_KEEP_LATEST', standingOrdersChars: 'WALDO_STANDING_ORDERS_CHARS', questsChars: 'WALDO_QUESTS_CHARS',
};

const valid = (key: keyof ContextBudget, value: number): boolean =>
  key === 'steppedTarget' ? value > 0 && value <= 1 : Number.isSafeInteger(value) && value > 0;

export const contextBudget = (env: object): ContextBudget => Object.fromEntries(
  (Object.keys(CONTEXT_BUDGET) as (keyof ContextBudget)[]).map((key) => {
    const raw = (env as Readonly<Record<string, unknown>>)[CONTEXT_BUDGET_SETTINGS[key]], value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return [key, valid(key, value) ? value : CONTEXT_BUDGET[key]];
  }),
) as ContextBudget;
