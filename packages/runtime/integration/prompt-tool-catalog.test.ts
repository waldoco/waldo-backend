import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPromptCatalog, loadPromptCatalog, appendPromptVersion, selectPrompt, buildToolCatalog, loadToolCatalog } from '../evals/prompt-experiments/catalog';
import { sendMessageHandler } from '../src/tools/live/messaging';
import { getContextHandler } from '../src/tools/live/get-context';
import { webSearchHandler } from '../src/tools/live/web-search';
import { toolDefinitions } from '../src/conversation/tool-loop';
import { MESSAGING_BEHAVIOR } from '../src/prompt/messaging-behavior';
import { reactionInstruction, TELEGRAM_REACTIONS } from '../src/channels/reactions';
import { MEMORY_INSTRUCTION, NIGHTLY_MEMORY_INSTRUCTION } from '../src/memory/claims';
import { DAY_PLAN_INSTRUCTION } from '../src/prompt/day-cards';

const source = 'c002d446327bfccb72cbe3e13492017f5c828b6d';
describe('source-backed prompt catalog', () => {
  it('loads all five existing static templates without changing their bytes', () => {
    const catalog = loadPromptCatalog(JSON.stringify(buildPromptCatalog(source)));
    expect(catalog.entries.map((entry) => entry.id)).toEqual(['waldo.reply', 'waldo.reaction', 'waldo.memory-extraction', 'waldo.nightly-consolidation', 'waldo.day-planning']);
    expect(catalog.entries.map((entry) => entry.instruction)).toEqual([
      MESSAGING_BEHAVIOR, reactionInstruction(TELEGRAM_REACTIONS), MEMORY_INSTRUCTION, NIGHTLY_MEMORY_INSTRUCTION, DAY_PLAN_INSTRUCTION,
    ]);
    expect(catalog.entries.every((entry) => entry.version === 1 && entry.source_revision === source)).toBe(true);
  });
  it('matches the committed source snapshot; drift requires an explicit new version', () => {
    const pinned = loadPromptCatalog(readFileSync(new URL('../evals/prompt-experiments/catalog.v1.json', import.meta.url), 'utf8'));
    expect(buildPromptCatalog(source)).toEqual(pinned);
  });
  it('retains the original version for rollback and rejects edits, skipped bumps and duplicates', () => {
    const initial = buildPromptCatalog(source);
    const original = selectPrompt(initial, 'waldo.reply', 1);
    const bumped = appendPromptVersion(initial, { ...original, version: 2 });
    expect(selectPrompt(bumped, 'waldo.reply', 1)).toEqual(original);
    expect(selectPrompt(bumped, 'waldo.reply', 2).content_digest).toBe(original.content_digest);
    expect(() => appendPromptVersion(bumped, { ...original, version: 2 })).toThrow();
    expect(() => appendPromptVersion(initial, { ...original, version: 3 })).toThrow();
    expect(() => appendPromptVersion(initial, { ...original, version: 2, instruction: 'tampered' })).toThrow();
    expect(() => selectPrompt(initial, 'waldo.reply', 2)).toThrow();
    const selected = selectPrompt(bumped, 'waldo.reply', 1);
    selected.instruction = 'caller mutation';
    expect(selectPrompt(bumped, 'waldo.reply', 1)).toEqual(original);
    expect(() => loadPromptCatalog(JSON.stringify({ ...initial, entries: initial.entries.slice(1) }))).toThrow();
  });
  it('reflects actual handler schemas without calling handlers or guessing approval-free reads', () => {
    const handlers = [getContextHandler({ timezone: 'UTC', now: () => { throw new Error('handler called'); } }), webSearchHandler(undefined, () => { throw new Error('network called'); })];
    const tools = buildToolCatalog(handlers, 1, source);
    expect(tools.entries.map(({ name, description, parameters }) => ({ name, description, parameters }))).toEqual(toolDefinitions(handlers));
    expect(tools.entries.every((entry) => entry.side_effect_class === 'unspecified' && entry.approval_requirement === 'handler_specific_unverified')).toBe(true);
    expect(() => buildToolCatalog([handlers[0]!, handlers[0]!], 1, source)).toThrow('duplicate');
    expect(buildToolCatalog(handlers, 2, source).digest).not.toBe(tools.digest);
    const mutation = buildToolCatalog([sendMessageHandler({ proposeSendMessage: async () => { throw new Error('proposal called'); } })], 1, source);
    expect(mutation.entries[0]).toMatchObject({ autonomy_gated: false, mutates_state: true, side_effect_class: 'privileged_action', approval_requirement: 'runtime_privileged_gate' });
    expect(loadToolCatalog(JSON.stringify(tools))).toEqual(tools);
    expect(loadToolCatalog(JSON.stringify(buildToolCatalog(handlers, 2, source))).version).toBe(2);
    expect(loadToolCatalog(JSON.stringify(tools)).version).toBe(1);
    expect(() => loadToolCatalog(JSON.stringify({ ...tools, version: 2 }))).toThrow('digest');
  });
});
