import { describe, expect, it } from 'vitest';
import { messagingSystemPrompt, type SurfacePresentation } from '../src/prompt/messaging-behavior';
import { BRAIN_NAMESPACES, TOOL_RECORDS } from '../src/tools/records';
import { toolCatalogue } from '../src/tools/loader';

const presentation: SurfacePresentation = { surface: 'app', delivery: { text: true, approval: 'native_buttons', reactions: false, attachments: false } };
const NAMES = Object.keys(TOOL_RECORDS);

// A seeded shuffle, so a failure names the order that broke it.
const shuffled = (names: readonly string[], seed: number): string[] => {
  const out = [...names];
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const pick = state % (index + 1);
    [out[index], out[pick]] = [out[pick]!, out[index]!];
  }
  return out;
};

// The system prompt leads the provider's cache prefix: the same admitted set must give the same bytes whatever order the
// host assembled its handlers in.
describe('tool catalogue in the system prompt', () => {
  it('is byte-identical for the same admitted set in any order', () => {
    const prompts = new Set(Array.from({ length: 20 }, (_, seed) => messagingSystemPrompt(shuffled(NAMES, seed + 1), presentation, 'harness')));
    expect(prompts.size).toBe(1);
  });

  it('lists groups in their declared order and names alphabetically within a group', () => {
    const lines = toolCatalogue(shuffled(NAMES, 7)).split('\n');
    const groups = lines.map((line) => line.slice(2, line.indexOf(':')));
    expect(groups).toEqual(Object.keys(BRAIN_NAMESPACES).filter((group) => groups.includes(group)));
    for (const line of lines) {
      const members = line.slice(line.indexOf(':') + 2, line.indexOf('. ')).split(', ');
      expect(members).toEqual([...members].sort());
    }
  });

  it('changes only when the admitted set changes', () => {
    const without = NAMES.filter((name) => name !== 'browse_act');
    expect(messagingSystemPrompt(shuffled(without, 3), presentation, 'harness')).toBe(messagingSystemPrompt(shuffled(without, 4), presentation, 'harness'));
    expect(messagingSystemPrompt(without, presentation, 'harness')).not.toBe(messagingSystemPrompt(NAMES, presentation, 'harness'));
  });
});
