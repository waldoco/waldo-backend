import { describe, expect, it, vi } from 'vitest';
import {
  crsPillarSchema, derivedHealthDestinationEligibilitySchema, derivedHealthDestinationViewSchema, DERIVED_HEALTH_VIEW_BOUNDS, formHealthViewSchema,
  HEALTH_SIGNALS, HEALTH_SIGNAL_GRAINS, partialHealthViewSchema, recoveryComponentSchema, recoveryHealthViewSchema, SANITISE_DESTINATION_POLICIES,
} from '@waldo/contracts';
import { healthSignalV1Schema } from '../../contracts/src/app/health-ingest';
import { healthContextBook, type HealthContextRow } from '../src/channels/health-context';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import { prepareWithScribe } from '../src/scribe/prepare';

// The owner's derived health view passes the Scribe on its way into every run, whatever the owner's phone sends: an owner whose
// sources report every kind Waldo stores gets the view in their Brief and their own turn, never a run refused for its size.
// Synthetic owner; no reading value appears anywhere, since neither read returns one.
const NOW = Date.now();
const clock = { timezone: 'UTC', now: () => new Date(NOW) };
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ROW: HealthContextRow = {
  context: {
    id: 'ctx-every-kind', day: new Date(NOW).toISOString().slice(0, 10), compiled_at: ago(1), freshness: 'fresh', confidence: 0.8, drivers: [], tags: [],
    recovery: { score: 71, zone: 'good', algorithm_version: 'recovery.candidate.v4' },
    form: { score: 66, zone: 'good', algorithm_version: 'form.v10' },
    weight: { score: 40, zone: 'moderate', algorithm_version: 'weight.v5' },
    basis: [{ source: 'apple', consent_epoch: 1 }],
  },
  previous: null,
};
const EVERY_KIND = healthSignalV1Schema.options;
const materialFor = async (kinds: readonly string[]) => {
  const call = async (fn: string) => {
    if (fn === 'health_context_read') return ROW;
    if (fn === 'health_inventory_read') return { sources: [{ source: 'apple', kinds: kinds.map(signal => ({ signal, newest_at: ago(2), days: 25 })) }] };
    throw new Error(`unexpected rpc ${fn}`);
  };
  const material = await healthContextBook(call, 'owner-every-kind', clock, undefined, undefined, { partial: true, inventory: true }).latest();
  if (material === null || material === 'unreadable') throw new Error('no health material');
  expect('inventory' in material.view && material.view.inventory).toHaveLength(kinds.length);
  return material;
};

const OWNER = '10000000-0000-0000-0000-000000000001';
const CANARIES = ['0123456789abcdef', '1123456789abcdef', '2123456789abcdef'];
const scope = (): RunEffectScope => ({ runId: 'run-view', attempt: 'attempt-view', deadline: NOW + 15 * 60_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const briefAdmission = () => ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
  expectedPhysicalDoId: 'actual-do', job: 'brief', occurrenceKey: 'brief:every-kind', occurredAt: Date.now() - 1 });
const chatAdmission = () => ownerMessageAdmission({
  lookup: async () => ({ owner_id: OWNER, do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
  scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
  actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
  allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text: 'How am I doing today?',
  occurrenceKey: 'chat:every-kind', occurredAt: Date.now() - 1, now: Date.now,
});
const compose = async (admission: Parameters<typeof createOwnerTurnContext>[0], kinds: readonly string[]) => {
  const material = await materialFor(kinds);
  const context = createOwnerTurnContext(admission, { health: async () => material });
  return context.composer.compose(context.invocation, { ...context.snapshot(), canary_tokens: CANARIES, replay_context_ref: null });
};

describe('the health view composes for an owner whose phone sends every kind', () => {
  it.each([['the Brief', briefAdmission], ['their own turn', chatAdmission]] as const)('in %s', async (_run, admit) => {
    const composed = await compose(await admit(), EVERY_KIND);
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    if (!composed.ok) return;
    // The last kind of the inventory, so the whole list reached the prompt.
    expect(composed.prompt).toContain(`${HEALTH_SIGNALS[EVERY_KIND.at(-1)!].words} (`);
  });
});

// The largest view each schema admits: every optional piece present and every list at its longest. Each passes the Scribe for
// the system prompt, so the destination's caps cover whatever the schema lets a view hold; a schema that grows past them fails
// here, not in an owner's run.
const SOURCES = ['apple', 'oura', 'whoop', 'samsung', 'health_connect'] as const;
const shared = {
  authority: 'backend', provenance_refs: ['a', 'b', 'c', 'd'].map(c => `hpr_${c.repeat(32)}`), destination_eligibility: derivedHealthDestinationEligibilitySchema.options,
  baseline_state: { recovery: 'personal', form: 'personal', load: 'provisional' }, sleep_debt: { amount: 'some', trend: 'building' },
  energy_windows: [['07:00', '09:00', 'peak'], ['13:00', '14:00', 'dip'], ['16:00', '18:00', 'peak'], ['21:00', '22:00', 'dip']].map(([start, end, kind]) => ({ start, end, kind })),
  missing_pillars: { recovery: 'stale_inputs', form: 'stale_inputs', load: 'calendar_demand_unavailable', sleep_debt: 'missing_sleep' },
  inventory: EVERY_KIND.map(signal => ({ signal, grain: HEALTH_SIGNAL_GRAINS[0], newest: 'today', regularity: 'nearly_every_day', sources: [...SOURCES] })),
};
const common = { ...shared, trend: 'steady', freshness: 'fresh', confidence_band: 'high' };
const LARGEST = {
  form: formHealthViewSchema.parse({ ...common, algorithm_version: 'form.v9', form_zone: 'steady', missing_components: crsPillarSchema.options }),
  recovery: recoveryHealthViewSchema.parse({ ...common, algorithm_version: 'recovery.v5', recovery_zone: 'solid', missing_components: recoveryComponentSchema.options }),
  partial: partialHealthViewSchema.parse({ ...shared, availability: 'partial', freshness: 'stale', as_of_day: 'yesterday', sources: [...SOURCES],
    present: ['last_night_sleep', 'recent_sleep', 'calendar', 'activity', 'workouts'], load_zone: 'moderate', no_score_row: true }),
};

describe('the system prompt takes the largest health view the schemas admit', () => {
  it.each(Object.entries(LARGEST))('a %s view', (_kind, view) => {
    // Every key the schema has is present, so the view is the largest of its kind.
    const schema = { form: formHealthViewSchema, recovery: recoveryHealthViewSchema, partial: partialHealthViewSchema }[_kind as keyof typeof LARGEST];
    expect(Object.keys(view).sort()).toEqual(Object.keys(schema.shape).sort());
    const prepared = prepareWithScribe(view, derivedHealthDestinationViewSchema, 'system_prompt', null, CANARIES as never);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  });
  it('sizes the destination by the view\'s own bounds', () => {
    expect(SANITISE_DESTINATION_POLICIES.system_prompt).toMatchObject({
      max_depth: DERIVED_HEALTH_VIEW_BOUNDS.depth, max_object_fields: DERIVED_HEALTH_VIEW_BOUNDS.fields, max_array_items: DERIVED_HEALTH_VIEW_BOUNDS.items,
    });
  });
});
