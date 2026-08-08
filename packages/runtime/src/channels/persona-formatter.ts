import type { ChannelName, ChannelPersona, WaldoCard, WaldoCardKind } from '@waldo/contracts';
import { channelPersonaAllowsCard, personaForChannel } from '@waldo/contracts';

type InlineAffordance = ChannelPersona['inline_affordances'][number];

// Every persona field currently reaches delivery only as REASONS prompt text
// (prompt/reasons.ts:145-148). A model asked to respect a ceiling is not a ceiling.
// This module enforces the fields that can be checked after generation, and names the
// ones that cannot rather than implying coverage they do not have.
export type PersonaEnforcement =
  | { control: 'verbosity_ceiling'; action: 'truncated'; ceiling: number; counted: number }
  | { control: 'card_kind'; action: 'dropped'; kind: WaldoCardKind }
  | { control: 'inline_affordance'; action: 'dropped'; affordance: InlineAffordance }
  | {
      control: 'health_data_redaction';
      action: 'not_enforced';
      policy: ChannelPersona['health_data_redaction'];
    }
  | {
      control: 'raw_value_policy';
      action: 'not_enforced';
      policy: ChannelPersona['raw_value_policy'];
    };

export type PersonaShapeInput = {
  channel: ChannelName;
  text: string;
  cards: WaldoCard[];
  affordances: InlineAffordance[];
  countTokens?: (text: string) => number;
};

export type PersonaShapeResult =
  | { shaped: false; channel: ChannelName; reason: 'no_persona_declared' }
  | {
      shaped: true;
      channel: ChannelName;
      text: string;
      cards: WaldoCard[];
      affordances: InlineAffordance[];
      enforced: PersonaEnforcement[];
    };

// Deliberately over-counts against real tokenizers: a ceiling that under-counts leaks.
// A real tokenizer replaces this through countTokens without touching the enforcement path.
const CHARS_PER_TOKEN_FLOOR = 3;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_FLOOR);
}

// Assumes the counter is non-decreasing in prefix length, which holds for character
// heuristics and for BPE tokenizers alike.
function longestPrefixWithinCeiling(
  text: string,
  ceiling: number,
  countTokens: (text: string) => number,
): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, mid)) <= ceiling) low = mid;
    else high = mid - 1;
  }
  const cut = text.slice(0, low);
  if (cut.length === text.length) return cut;
  const lastBoundary = cut.lastIndexOf(' ');
  return (lastBoundary > 0 ? cut.slice(0, lastBoundary) : cut).trimEnd();
}

export function shapeForPersona(input: PersonaShapeInput): PersonaShapeResult {
  const persona = personaForChannel(input.channel);
  // Fail closed. A channel with declared vocabulary but no accepted persona has no
  // shaping rules, and unshaped delivery would silently bypass every declared control.
  if (persona === undefined) {
    return { shaped: false, channel: input.channel, reason: 'no_persona_declared' };
  }

  const countTokens = input.countTokens ?? estimateTokens;
  const enforced: PersonaEnforcement[] = [];

  const counted = countTokens(input.text);
  let text = input.text;
  if (counted > persona.verbosity_ceiling_tokens) {
    text = longestPrefixWithinCeiling(input.text, persona.verbosity_ceiling_tokens, countTokens);
    enforced.push({
      control: 'verbosity_ceiling',
      action: 'truncated',
      ceiling: persona.verbosity_ceiling_tokens,
      counted,
    });
  }

  const cards: WaldoCard[] = [];
  for (const card of input.cards) {
    if (channelPersonaAllowsCard(input.channel, card.kind)) cards.push(card);
    else enforced.push({ control: 'card_kind', action: 'dropped', kind: card.kind });
  }

  const affordances: InlineAffordance[] = [];
  for (const affordance of input.affordances) {
    if (persona.inline_affordances.includes(affordance)) affordances.push(affordance);
    else enforced.push({ control: 'inline_affordance', action: 'dropped', affordance });
  }

  // Stripping health values from generated prose needs semantic detection this module
  // cannot perform deterministically. Reporting the gap keeps the control observable
  // instead of letting a passing formatter imply the redaction happened.
  if (persona.health_data_redaction !== 'none') {
    enforced.push({
      control: 'health_data_redaction',
      action: 'not_enforced',
      policy: persona.health_data_redaction,
    });
  }
  if (persona.raw_value_policy === 'show_descriptions_only') {
    enforced.push({
      control: 'raw_value_policy',
      action: 'not_enforced',
      policy: persona.raw_value_policy,
    });
  }

  return { shaped: true, channel: input.channel, text, cards, affordances, enforced };
}
