import { describe, expect, it } from 'vitest';
import type { WaldoCard } from '@waldo/contracts';
import { shapeForPersona } from '../src/channels/persona-formatter';

const fetchCard: WaldoCard = {
  kind: 'fetch_card',
  card_id: 'card_fetch',
  data: { source_refs: ['source_a'] },
};

const contextCard: WaldoCard = {
  kind: 'context_card',
  card_id: 'card_context',
  data: { source_refs: ['source_b'] },
};

function shape(overrides: Partial<Parameters<typeof shapeForPersona>[0]>) {
  return shapeForPersona({
    channel: 'telegram',
    text: 'short reply',
    cards: [],
    affordances: [],
    ...overrides,
  });
}

describe('shapeForPersona', () => {
  it('fails closed for a declared channel with no accepted persona', () => {
    const result = shape({ channel: 'discord' });
    expect(result).toEqual({
      shaped: false,
      channel: 'discord',
      reason: 'no_persona_declared',
    });
  });

  it('truncates past the verbosity ceiling at a word boundary and records the overage', () => {
    const text = 'word '.repeat(200);
    const result = shape({ text });

    if (!result.shaped) throw new Error('expected telegram to shape');
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.text.endsWith('word')).toBe(true);
    expect(Math.ceil(result.text.length / 3)).toBeLessThanOrEqual(180);
    expect(result.enforced).toContainEqual({
      control: 'verbosity_ceiling',
      action: 'truncated',
      ceiling: 180,
      counted: 334,
    });
  });

  it('leaves text under the ceiling untouched and records no truncation', () => {
    const result = shape({ text: 'this fits well inside the telegram ceiling' });

    if (!result.shaped) throw new Error('expected telegram to shape');
    expect(result.text).toBe('this fits well inside the telegram ceiling');
    expect(result.enforced.some((e) => e.control === 'verbosity_ceiling')).toBe(false);
  });

  it('uses an injected token counter instead of the character heuristic', () => {
    const text = 'word '.repeat(200);
    const result = shape({ text, countTokens: () => 1 });

    if (!result.shaped) throw new Error('expected telegram to shape');
    expect(result.text).toBe(text);
    expect(result.enforced.some((e) => e.control === 'verbosity_ceiling')).toBe(false);
  });

  it('drops cards the work-channel persona forbids and keeps the permitted ones', () => {
    const result = shape({ channel: 'slack', cards: [fetchCard, contextCard] });

    if (!result.shaped) throw new Error('expected slack to shape');
    expect(result.cards).toEqual([contextCard]);
    expect(result.enforced).toContainEqual({
      control: 'card_kind',
      action: 'dropped',
      kind: 'fetch_card',
    });
  });

  it('drops affordances the persona does not declare', () => {
    const result = shape({ affordances: ['buttons', 'quick_replies'] });

    if (!result.shaped) throw new Error('expected telegram to shape');
    expect(result.affordances).toEqual(['buttons']);
    expect(result.enforced).toContainEqual({
      control: 'inline_affordance',
      action: 'dropped',
      affordance: 'quick_replies',
    });
  });

  it('reports health controls as unenforced when the persona demands stripping', () => {
    const result = shape({ channel: 'slack' });

    if (!result.shaped) throw new Error('expected slack to shape');
    expect(result.enforced).toContainEqual({
      control: 'health_data_redaction',
      action: 'not_enforced',
      policy: 'work_filter',
    });
    expect(result.enforced).toContainEqual({
      control: 'raw_value_policy',
      action: 'not_enforced',
      policy: 'show_descriptions_only',
    });
  });

  it('reports no health control when the persona demands no stripping', () => {
    const result = shape({ channel: 'telegram' });

    if (!result.shaped) throw new Error('expected telegram to shape');
    expect(
      result.enforced.some(
        (e) => e.control === 'health_data_redaction' || e.control === 'raw_value_policy',
      ),
    ).toBe(false);
  });

  it('resolves in_app through the apns persona, which permits every card kind', () => {
    const result = shape({ channel: 'in_app', cards: [fetchCard, contextCard] });

    if (!result.shaped) throw new Error('expected in_app to shape');
    expect(result.cards).toEqual([fetchCard, contextCard]);
    expect(result.enforced.some((e) => e.control === 'card_kind')).toBe(false);
  });
});
