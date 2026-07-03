// Owning ADRs: ADR-0035 (canonical card_kinds_allowed vocabulary) + ADR-0013 (inline
// GenUI cards, chat_messages card columns) + ADR-0015 (Brief variant) + ADR-0027
// (draft_id-only email card).
// ADR-0013's `type` union is absorbed into the ADR-0035 kinds:
//   sleep | form | recovery | hrv | patrol_entry -> context_card (which stat or entry a
//     display card shows is payload, not kind)
//   calendar_block -> adjustment_proposal / window_proposal (a rendered block rides the
//     proposal that created it)
//   action_confirmation -> dissolved into the *_proposal kinds (each proposal card
//     carries its own confirm affordance, the ADR-0026/0027 pattern)
// Invariant under test: WaldoCardKind is the single owner of kind literals, the union's
// discriminators equal that vocabulary exactly, and every payload is Art-9-safe by
// construction (stable IDs + zone words; strictObject rejects raw sensor fields).
// Failure mode caught: a kind literal added/removed/reordered without ratification, a
// union variant drifting from the enum, or a raw physiological value smuggled into a
// journal-bound card payload.
import { describe, expect, it } from 'vitest';
import {
  briefCardDataSchema,
  cardDataSchema,
  draftEmailCardDataSchema,
  waldoCardKindSchema,
  waldoCardSchema,
} from './card';

const baseData = { source_refs: ['crs-2026-07-01'] } as const;

const baseCard = { kind: 'context_card', card_id: 'card-01', data: baseData } as const;

describe('waldoCardKind', () => {
  it('is exactly the seven ADR-0035 kinds, in order', () => {
    expect(waldoCardKindSchema.options).toEqual([
      'adjustment_proposal',
      'window_proposal',
      'fetch_card',
      'brief_card',
      'skill_proposal',
      'draft_email_card',
      'context_card',
    ]);
  });

  it("rejects an absorbed ADR-0013 display literal ('sleep')", () => {
    expect(waldoCardKindSchema.safeParse('sleep').success).toBe(false);
  });

  it("rejects a retired legacy literal ('sheet_write')", () => {
    expect(waldoCardKindSchema.safeParse('sheet_write').success).toBe(false);
  });
});

describe('waldoCard', () => {
  it('accepts one instance of every kind', () => {
    for (const kind of waldoCardKindSchema.options) {
      const data =
        kind === 'brief_card'
          ? { ...baseData, variant: 'morning' }
          : kind === 'draft_email_card'
            ? { draft_id: 'draft-01' }
            : baseData;
      expect(waldoCardSchema.safeParse({ kind, card_id: 'card-01', data }).success).toBe(true);
    }
  });

  it('union discriminators equal the kind vocabulary exactly (single owner)', () => {
    expect(waldoCardSchema.options.map((variant) => variant.shape.kind.value)).toEqual(
      waldoCardKindSchema.options,
    );
  });

  it('rejects an unknown kind', () => {
    expect(waldoCardSchema.safeParse({ ...baseCard, kind: 'intervention' }).success).toBe(false);
  });

  it('rejects a missing data payload', () => {
    const { data: _data, ...noData } = baseCard;
    expect(waldoCardSchema.safeParse(noData).success).toBe(false);
  });

  it('rejects an empty card_id', () => {
    expect(waldoCardSchema.safeParse({ ...baseCard, card_id: '' }).success).toBe(false);
  });

  it('rejects an extra field on a variant (strictObject)', () => {
    expect(waldoCardSchema.safeParse({ ...baseCard, persona: 'ios' }).success).toBe(false);
  });
});

describe('cardData — Art-9 firewall', () => {
  it('accepts zone words alongside stable refs', () => {
    const data = { ...baseData, form_zone: 'flagging', recovery_zone: 'mixed', load_zone: 'peak' };
    expect(cardDataSchema.safeParse(data).success).toBe(true);
  });

  it('rejects a raw-health-value field (hrv_ms)', () => {
    expect(cardDataSchema.safeParse({ ...baseData, hrv_ms: 42 }).success).toBe(false);
  });

  it('rejects a raw-health-value field (heart_rate)', () => {
    expect(cardDataSchema.safeParse({ ...baseData, heart_rate: 61 }).success).toBe(false);
  });

  it('rejects a raw-health-value field (spo2)', () => {
    expect(cardDataSchema.safeParse({ ...baseData, spo2: 97 }).success).toBe(false);
  });

  it("rejects the Load word 'peak' in form_zone (vocabularies do not mix)", () => {
    expect(cardDataSchema.safeParse({ ...baseData, form_zone: 'peak' }).success).toBe(false);
  });

  it('rejects an empty string in source_refs (stable IDs only)', () => {
    expect(cardDataSchema.safeParse({ source_refs: [''] }).success).toBe(false);
  });
});

describe('briefCardData', () => {
  it('requires the ADR-0015 variant', () => {
    expect(briefCardDataSchema.safeParse({ ...baseData }).success).toBe(false);
  });

  it('rejects an unknown variant', () => {
    expect(briefCardDataSchema.safeParse({ ...baseData, variant: 'night' }).success).toBe(false);
  });
});

describe('draftEmailCardData', () => {
  it('carries only the provider draft_id reference', () => {
    expect(draftEmailCardDataSchema.safeParse({ draft_id: 'draft-01' }).success).toBe(true);
  });

  it('rejects a smuggled body field (ADR-0027: body never persisted)', () => {
    expect(
      draftEmailCardDataSchema.safeParse({ draft_id: 'draft-01', body_markdown: 'hi' }).success,
    ).toBe(false);
  });
});
