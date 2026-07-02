// Owning ADR: ADR-0028 (REASONS Canvas: layer order, per-layer composition, A-layer skill
// fence, recall-before-act wiring) with the recall seam from ADR-0031.
// Invariant under test: the canvas contract is closed and ordered — seven layers with
// safeguards last, every input assigned to exactly one layer, the skill fence rendered
// byte-exactly with an empty render for zero skills, and recall integrated only as the
// single recall(ctx, hint?) gateway.
// Failure mode caught: layer reordering or a layer/input minted outside the ADR, the skill
// fence drifting from the pinned format (or an empty fence reaching the model), and the
// dead recallBeforeAct(ctx, skills) three-source shape resurfacing as an export.
import { describe, expect, it } from 'vitest';
import * as recallExports from '../memory/recall';
import { recallResultSchema } from '../memory/recall';
import * as reasonsExports from './reasons';
import {
  layerInputSchema,
  REASONS_LAYER_INPUTS,
  REASONS_LAYER_JOIN,
  reasonsLayerSchema,
  wrapSkills,
} from './reasons';
import type { PromptBuilderDeps } from './reasons';
import { skillSchema } from './skill';

const skillA = skillSchema.parse({
  name: 'monday-team-update',
  version: 1,
  provenance: 'user',
  identity_locked: false,
  provisional: false,
  trigger_types: ['brief'],
  trigger_condition: 'monday before 10am',
  required_tools: ['draft_email'],
  required_connectors: ['email'],
  effectiveness: 0.7,
  invocations: 13,
  last_used: null,
  body_markdown: 'Pull the schedule, draft the update.',
  created_at: '2026-05-15T00:00:00Z',
});

const skillB = skillSchema.parse({
  ...skillA,
  name: 'prep-for-event',
  provenance: 'system',
  effectiveness: 0.925,
  body_markdown: 'Scan the calendar for the next high-stakes event.',
});

describe('reasonsLayer', () => {
  it('is exactly the seven REASONS layers, in canvas order', () => {
    expect(reasonsLayerSchema.options).toEqual([
      'requirements',
      'entities',
      'approach',
      'structure',
      'operations',
      'norms',
      'safeguards',
    ]);
  });

  it('keeps safeguards as the final layer', () => {
    expect(reasonsLayerSchema.options.at(-1)).toBe('safeguards');
  });

  it('rejects a layer minted outside the ADR', () => {
    expect(reasonsLayerSchema.safeParse('reflection').success).toBe(false);
  });
});

describe('layerInput', () => {
  it('is exactly the twelve canvas inputs, in layer order', () => {
    expect(layerInputSchema.options).toEqual([
      'trigger_context',
      'user_profile',
      'trigger_behaviour',
      'available_skills',
      'tool_acl',
      'recall',
      'health_context',
      'workspace_files',
      'zone_modifier',
      'mode_template',
      'soul_base',
      'safety_rules',
    ]);
  });

  it("rejects 'model_name' — model selection is roster territory, never a prompt input", () => {
    expect(layerInputSchema.safeParse('model_name').success).toBe(false);
  });
});

describe('REASONS_LAYER_INPUTS', () => {
  it('is exactly the ADR-0028 per-layer composition', () => {
    expect(REASONS_LAYER_INPUTS).toEqual({
      requirements: ['trigger_context'],
      entities: ['user_profile'],
      approach: ['trigger_behaviour', 'available_skills'],
      structure: ['tool_acl'],
      operations: ['recall', 'health_context', 'workspace_files'],
      norms: ['zone_modifier', 'mode_template', 'soul_base'],
      safeguards: ['safety_rules'],
    });
  });

  it('assigns every input to exactly one layer, covering the full vocabulary', () => {
    const flat = Object.values(REASONS_LAYER_INPUTS).flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual([...layerInputSchema.options].sort());
  });

  it('leads operations with recall — memory is consulted before fresh context', () => {
    expect(REASONS_LAYER_INPUTS.operations[0]).toBe('recall');
  });

  it('joins layers with a blank line', () => {
    expect(REASONS_LAYER_JOIN).toBe('\n\n');
  });
});

describe('wrapSkills', () => {
  it('renders zero selected skills as the empty string — no empty fence', () => {
    expect(wrapSkills([])).toBe('');
  });

  it('renders one skill byte-exactly in the ADR-0028 fence format', () => {
    expect(wrapSkills([skillA])).toBe(
      '<available-skills>\n' +
        '<skill name="monday-team-update" effectiveness="0.70" provenance="user">\n' +
        'Pull the schedule, draft the update.\n' +
        '</skill>\n' +
        '</available-skills>',
    );
  });

  it('joins multiple skill elements with a blank line inside one fence', () => {
    const rendered = wrapSkills([skillA, skillB]);
    expect(rendered).toContain(
      '</skill>\n\n<skill name="prep-for-event" effectiveness="0.93" provenance="system">',
    );
    expect(rendered.match(/<available-skills>/g)).toHaveLength(1);
    expect(rendered.startsWith('<available-skills>\n')).toBe(true);
    expect(rendered.endsWith('\n</available-skills>')).toBe(true);
  });

  it('renders effectiveness with two decimals (0.925 rounds to 0.93)', () => {
    expect(wrapSkills([skillB])).toContain('effectiveness="0.93"');
  });
});

describe('recall integration — the single recall(ctx, hint?) gateway', () => {
  const deps: PromptBuilderDeps<{ user_id: string }> = {
    loadForTrigger: async () => ({ selected: [], excluded: [] }),
    recall: async (_ctx, hint) => ({
      memory_hits: [],
      episode_hits: [],
      evolution_hits: [],
      query_used: hint ?? 'trigger-signal',
      duration_ms: 0,
    }),
  };

  it('accepts a bare ctx call and a skill-derived hint — one optional string, no skills array', async () => {
    const bare = await deps.recall({ user_id: 'user-1' });
    expect(recallResultSchema.safeParse(bare).success).toBe(true);
    const hinted = await deps.recall({ user_id: 'user-1' }, skillA.name);
    expect(hinted.query_used).toBe('monday-team-update');
  });

  it('exports no recallBeforeAct — the legacy three-source shape is dead', () => {
    expect(Object.keys(reasonsExports)).not.toContain('recallBeforeAct');
    expect(Object.keys(recallExports)).not.toContain('recallBeforeAct');
  });
});
