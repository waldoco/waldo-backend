import type {
  ModelName,
  SKILL_PROMPT_SERIALIZER_REVISION,
  SkillPromptBlock,
  SkillPromptFragment,
} from '@waldo/contracts';

export type CountResult =
  | { ok: true; tokens: number }
  | {
      ok: false;
      code: 'unavailable' | 'unmapped_model' | 'unpinned_revision' | 'count_failed';
    };

// This is the only prompt-budget surface given to a loader. Model, tokenizer, and serializer
// bindings stay inside the provider-owned factory that creates it.
export type ResolvedSkillBudget = Readonly<{
  countRenderedSkill(fragment: SkillPromptFragment): Promise<CountResult>;
  countRenderedBlock(block: SkillPromptBlock): Promise<CountResult>;
}>;

export type SkillBudgetFactoryInput = Readonly<{
  model: ModelName;
  serializerRevision: typeof SKILL_PROMPT_SERIALIZER_REVISION;
}>;

export type SkillBudgetFactory = (input: SkillBudgetFactoryInput) => ResolvedSkillBudget;

export function createUnavailableSkillBudget(): ResolvedSkillBudget {
  return Object.freeze({
    countRenderedSkill: async (): Promise<CountResult> => ({ ok: false, code: 'unavailable' }),
    countRenderedBlock: async (): Promise<CountResult> => ({ ok: false, code: 'unavailable' }),
  });
}
