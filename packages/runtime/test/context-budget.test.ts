// The sizes that bound an owner turn's context are deploy settings in WALDO_SWITCHES. Each defaults to today's value; a
// value that is not a valid size of its kind is read as that default, and both deployed configs carry valid values.
import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatVars } from '../../../scripts/wrangler-vars.mjs';
import { CONTEXT_BUDGET, CONTEXT_BUDGET_SETTINGS, contextBudget, ignoredSettings } from '../src/conversation/context-budget';
import { compactionSettings } from '../src/conversation/compaction';
import { steppedWindowStart } from '../src/conversation/window';

describe('contextBudget', () => {
  it('defaults to the sizes the turn used before they were settings', () => {
    expect(CONTEXT_BUDGET).toEqual({
      historyTokens: 22_000, chatCeilingTokens: 40_000, jobCeilingTokens: 25_000, hardCeilingTokens: 80_000,
      steppedTarget: 0.5, clearAtChars: 120_000, keepLatest: 3, standingOrdersChars: 3_000, questsChars: 3_000, whatsNewChars: 1_200,
    });
    expect(contextBudget({})).toEqual(CONTEXT_BUDGET);
  });

  it('reads each size from its own setting', () => {
    const set = { WALDO_HISTORY_BUDGET_TOKENS: '14000', WALDO_CHAT_CEILING_TOKENS: '36000', WALDO_JOB_CEILING_TOKENS: '20000', WALDO_HARD_CEILING_TOKENS: '64000',
      WALDO_STEPPED_WINDOW_TARGET: '0.6', WALDO_TOOL_RESULTS_CLEAR_AT_CHARS: '90000', WALDO_TOOL_RESULTS_KEEP_LATEST: '2', WALDO_STANDING_ORDERS_CHARS: '2000', WALDO_QUESTS_CHARS: '1500', WALDO_WHATS_NEW_CHARS: '900' };
    expect(contextBudget(set)).toEqual({ historyTokens: 14_000, chatCeilingTokens: 36_000, jobCeilingTokens: 20_000, hardCeilingTokens: 64_000,
      steppedTarget: 0.6, clearAtChars: 90_000, keepLatest: 2, standingOrdersChars: 2_000, questsChars: 1_500, whatsNewChars: 900 });
    expect(Object.values(CONTEXT_BUDGET_SETTINGS).sort()).toEqual(Object.keys(set).sort());
  });

  it('reads a value that is not a valid size of its kind as the default', () => {
    for (const bad of ['', 'abc', '0', '-5', '1.5', '22k', 'Infinity', ' ']) {
      expect(contextBudget({ WALDO_HISTORY_BUDGET_TOKENS: bad, WALDO_TOOL_RESULTS_KEEP_LATEST: bad }), bad).toEqual(CONTEXT_BUDGET);
    }
    for (const bad of ['0', '-0.5', '1.5', 'half']) expect(contextBudget({ WALDO_STEPPED_WINDOW_TARGET: bad }).steppedTarget, bad).toBe(0.5);
    expect(contextBudget({ WALDO_STEPPED_WINDOW_TARGET: '1' }).steppedTarget).toBe(1);
  });

  it('names each setting it read as its default because the value was not valid, and no setting that was unset or valid', () => {
    expect(ignoredSettings({})).toEqual([]);
    expect(ignoredSettings({ WALDO_HISTORY_BUDGET_TOKENS: '14000', WALDO_STEPPED_WINDOW_TARGET: '0.6' })).toEqual([]);
    expect(ignoredSettings({ WALDO_HISTORY_BUDGET_TOKENS: '14k', WALDO_TOOL_RESULTS_KEEP_LATEST: '0', WALDO_CHAT_CEILING_TOKENS: '36000' }))
      .toEqual(['WALDO_HISTORY_BUDGET_TOKENS', 'WALDO_TOOL_RESULTS_KEEP_LATEST']);
  });

  it('both deployed configs carry every setting, each a valid value', () => {
    const parsed = parseJsonc(config) as { vars: Record<string, unknown>; env: Record<string, { vars: Record<string, unknown> }> };
    for (const vars of [flatVars(parsed.vars), flatVars(parsed.env.staging!.vars)] as Record<string, string>[]) {
      for (const name of Object.values(CONTEXT_BUDGET_SETTINGS)) expect(vars[name], name).toBeDefined();
      const read = contextBudget(vars);
      for (const [key, name] of Object.entries(CONTEXT_BUDGET_SETTINGS)) expect(read[key as keyof typeof read], name).toBe(Number(vars[name]));
    }
  });
});

describe('where the turn reads them', () => {
  it('the chat history budget under WALDO_CALL_CEILINGS is the history setting', () => {
    expect(compactionSettings({ WALDO_CALL_CEILINGS: '1', WALDO_HISTORY_BUDGET_TOKENS: '14000' }).budgetTokens).toBe(14_000);
    expect(compactionSettings({ WALDO_CALL_CEILINGS: '1' }).budgetTokens).toBe(22_000);
    expect(compactionSettings({ WALDO_HISTORY_BUDGET_TOKENS: '14000' }).budgetTokens).toBe(compactionSettings({}).budgetTokens);
  });

  it('a stepped cut keeps the newest rows that fit in the target share of the budget', () => {
    const costs = Array.from({ length: 20 }, () => 10);
    expect(compactionSettings({ WALDO_STEPPED_WINDOW: '1', WALDO_STEPPED_WINDOW_TARGET: '0.8' }).steppedTarget).toBe(0.8);
    expect(steppedWindowStart(costs, 100, 0, 0.5)).toBe(14);
    expect(steppedWindowStart(costs, 100, 0, 0.8)).toBe(11);
  });
});
