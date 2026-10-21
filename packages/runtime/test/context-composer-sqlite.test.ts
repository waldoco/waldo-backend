import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import {
  acceptTrustedInvocation,
  recallResultSchema,
  skillRowSchema,
  type SkillRow,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  createContextComposer,
  type ContextComposerDependencies,
  type ContextSource,
  type RuntimeOwnedContextInputs,
} from '../src/context-composer';
import {
  HeadlessLocalOwnerBindingResolver,
  SqliteSystemSkillRepository,
} from '../src/context-composer/sqlite';
import { provisionDoSchema } from '../src/do-schema';
import type { TestStorageDO } from './support/worker-entry';
import type { ResolvedSkillBudget } from '../src/skills/budget';

const SNAPSHOT_AT = Date.parse('2026-07-15T12:00:00.000Z');
const PRINCIPAL_A = 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRINCIPAL_B = 'prn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PRINCIPAL_UNMAPPED = 'prn_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const TENANT = 'ten_cccccccccccccccccccccccccccccccc';
const TENANT_B = 'ten_dddddddddddddddddddddddddddddddd';
const OWNER_A = "owner-a' OR 1=1 --";
const OWNER_B = 'owner-b';
const OWNER_B_TENANT_B = 'owner-b-tenant-b';
const REVISION = {
  staged: 'rev_00000000000000000000000000000001',
  materials: 'rev_11111111111111111111111111111111',
  owner: 'rev_22222222222222222222222222222222',
  skills: 'rev_33333333333333333333333333333333',
  skillState: 'rev_44444444444444444444444444444444',
  recall: 'rev_55555555555555555555555555555555',
} as const;
const RUNTIME_INPUTS: RuntimeOwnedContextInputs = {
  snapshot_ref: 'snp_77777777777777777777777777777777',
  snapshot_at: SNAPSHOT_AT,
  canary_tokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'],
  replay_context_ref: null,
};

function attestation(
  request: Readonly<{ snapshot_ref: string; snapshot_at: number }>,
  revision_ref: string,
) {
  return { snapshot_ref: request.snapshot_ref, snapshot_at: request.snapshot_at, revision_ref };
}

const exactTestSkillBudget: ResolvedSkillBudget = {
  countRenderedSkill: async () => ({ ok: true as const, tokens: 1 }),
  countRenderedBlock: async () => ({ ok: true as const, tokens: 1 }),
};

let sequence = 0;

function source(source_key: string, overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    source_key,
    source_kind: 'runtime_metadata',
    scope: 'system',
    source_taint: null,
    produced_at: SNAPSHOT_AT,
    ...overrides,
  };
}

function runtimeStub(): DurableObjectStub<TestStorageDO> {
  sequence += 1;
  return env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`context-composer-sqlite-${sequence}`));
}

function envelope(principal_ref: string, tenant_ref = TENANT) {
  const accepted = acceptTrustedInvocation({
    admission_source: 'authenticated_ingress',
    verified_authority: {
      principal_ref,
      tenant_ref,
      verification_ref: 'ver_33333333333333333333333333333333',
    },
    input_refs: [
      {
        input_ref: 'inp_44444444444444444444444444444444',
        content_digest: 'sha256:ffc0a4eea17202ad7968e590d5ea7bbe791c0fd671e9145b84855c14eabdfcdf',
      },
    ],
    intent: { kind: 'respond_to_user' },
    occurrence: {
      occurrence_ref: 'occ_55555555555555555555555555555555',
      occurred_at: SNAPSHOT_AT - 1_000,
    },
    idempotency_ref: 'idem_66666666666666666666666666666666',
    accepted_at: SNAPSHOT_AT,
  });
  if (!accepted.ok) throw new Error('trusted SQLite envelope fixture must be accepted');
  return accepted.value;
}

function systemSkill(overrides: Partial<SkillRow> = {}): SkillRow {
  return skillRowSchema.parse({
    name: 'sqlite-afternoon-plan',
    version: 1,
    provenance: 'system',
    identity_locked: true,
    provisional: false,
    trigger_types: ['user_message'],
    trigger_condition: 'the user asks for a practical plan',
    required_tools: ['get_tasks'],
    required_connectors: [],
    effectiveness: 0.9,
    invocations: 2,
    last_used: null,
    body_markdown: 'Keep the next action concrete.',
    created_at: '2026-07-15T08:00:00.000Z',
    created_by: 'founder-curated',
    status: 'active',
    pinned: false,
    last_curated_at: '2026-07-15T08:00:00.000Z',
    archived_at: null,
    ...overrides,
  });
}

function seedSkill(sql: SqlStorage, row: SkillRow): void {
  sql.exec(
    `INSERT INTO skills (
      name, version, provenance, identity_locked, provisional, trigger_types_json,
      trigger_condition, required_tools_json, required_connectors_json, effectiveness,
      invocations, last_used, body_markdown, created_at, created_by, status, pinned,
      last_curated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.name,
    row.version,
    row.provenance,
    row.identity_locked ? 1 : 0,
    row.provisional ? 1 : 0,
    JSON.stringify(row.trigger_types),
    row.trigger_condition,
    JSON.stringify(row.required_tools),
    JSON.stringify(row.required_connectors),
    row.effectiveness,
    row.invocations,
    row.last_used,
    row.body_markdown,
    row.created_at,
    row.created_by,
    row.status,
    row.pinned ? 1 : 0,
    row.last_curated_at,
    row.archived_at,
  );
}

function dependencies(sql: SqlStorage): ContextComposerDependencies {
  return {
    staged_inputs: {
      async resolve(request) {
        return {
          inputs: [
            {
              input_ref: 'inp_44444444444444444444444444444444',
              content_digest:
                'sha256:ffc0a4eea17202ad7968e590d5ea7bbe791c0fd671e9145b84855c14eabdfcdf',
              principal_ref: request.principal_ref,
              tenant_ref: request.tenant_ref,
              text: 'Could you help me plan my afternoon?',
              source: source('sqlite-staged-input', { source_kind: 'invocation_input', scope: 'invocation' }),
            },
          ],
          snapshot: attestation(request, REVISION.staged),
          source: source('sqlite-staged-input-snapshot', {
            source_kind: 'runtime_metadata',
            scope: 'invocation',
          }),
        };
      },
    },
    materials: {
      async load(request) {
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          snapshot: attestation(request, REVISION.materials),
          identity: {
            text: 'The verified principal is asking for a practical response.',
            source: source('sqlite-identity', { scope: 'principal' }),
          },
          trigger_behaviour: { text: 'Help choose a feasible next sequence.', source: source('sqlite-behaviour') },
          zone_modifier: { text: 'Prefer a calm, concrete pace.', source: source('sqlite-zone') },
          mode_template: { text: 'Use concise planning language.', source: source('sqlite-mode') },
          soul_base: { text: 'Be warm, direct, and avoid medical claims.', source: source('sqlite-soul') },
          safety_rules: { text: 'Respect privacy and require approved actions.', source: source('sqlite-safety') },
          health: null,
          workspace: [],
          tool_outputs: [],
        };
      },
    },
    owner_binding: new HeadlessLocalOwnerBindingResolver([
      { principal_ref: PRINCIPAL_A, tenant_ref: TENANT, local_user_ref: OWNER_A },
      { principal_ref: PRINCIPAL_B, tenant_ref: TENANT, local_user_ref: OWNER_B },
      { principal_ref: PRINCIPAL_B, tenant_ref: TENANT_B, local_user_ref: OWNER_B_TENANT_B },
    ], REVISION.owner),
    system_skills: new SqliteSystemSkillRepository(sql, REVISION.skills),
    system_skill_state: {
      async load(request) {
        return {
          principal_ref: request.principal_ref,
          tenant_ref: request.tenant_ref,
          snapshot: attestation(request, REVISION.skillState),
          source: source('sqlite-headless-skill-state', { scope: 'principal' }),
          connected_connectors: [],
          dismissed_today: [],
          provisional_reverted: [],
          identity_drift: [],
          priority_pinned: [],
        };
      },
    },
    skill_budget: exactTestSkillBudget,
    // Owner recall is not wired through this composer (as in the owner turn); it answers unavailable.
    recall: {
      async recall(request) {
        return {
          principal_ref: request.owner.principal_ref,
          tenant_ref: request.owner.tenant_ref,
          snapshot: attestation(request, REVISION.recall),
          status: 'failed',
          result: recallResultSchema.parse({ memory_hits: [], episode_hits: [], evolution_hits: [], query_used: 'Owner temporal recall unavailable', duration_ms: 0 }),
          source: null,
          capability: 'owner_bound_local_temporal_snapshot',
        };
      },
    },
  };
}

describe('ContextComposer current-DO SQLite adapters', () => {
  it('rejects one legacy local user id bound to multiple trusted authorities', () => {
    expect(
      () =>
        new HeadlessLocalOwnerBindingResolver([
          { principal_ref: PRINCIPAL_A, tenant_ref: TENANT, local_user_ref: 'shared-owner' },
          { principal_ref: PRINCIPAL_B, tenant_ref: TENANT, local_user_ref: 'shared-owner' },
        ], REVISION.owner),
    ).toThrow('non-unique headless owner binding');

    expect(
      () =>
        new HeadlessLocalOwnerBindingResolver([
          { principal_ref: PRINCIPAL_A, tenant_ref: TENANT, local_user_ref: 'shared-owner' },
          { principal_ref: PRINCIPAL_B, tenant_ref: TENANT_B, local_user_ref: 'shared-owner' },
        ], REVISION.owner),
    ).toThrow('non-unique headless owner binding');
  });

  it('fails closed at the public seam when a trusted authority has no bounded local owner mapping', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      let recallCalls = 0;
      return createContextComposer({
        ...dependencies(state.storage.sql),
        recall: {
          async recall() {
            recallCalls += 1;
            throw new Error('recall must not run without an owner binding');
          },
        },
      }).compose(envelope(PRINCIPAL_UNMAPPED), RUNTIME_INPUTS).then((composition) => ({
        composition,
        recallCalls,
      }));
    });

    expect(result.composition).toEqual({ ok: false, failure: { code: 'owner_binding_mismatch' } });
    expect(result.recallCalls).toBe(0);
    expect('prompt' in result.composition).toBe(false);
  });

  it('reads active, identity-locked system skills only', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedSkill(
        sql,
        skillRowSchema.parse({
          ...systemSkill(),
          name: 'foreign-user-skill',
          provenance: 'user',
          identity_locked: false,
        }),
      );
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });

    expect(result.ok, result.ok ? undefined : result.failure.code).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.skills.selected).toEqual(['sqlite-afternoon-plan']);
    expect(result.prompt).not.toContain('foreign-user-skill');
    expect(JSON.stringify(result)).not.toContain('foreign-user-skill');
  });

  it('fails closed rather than silently truncating an oversized active system-skill snapshot', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      for (let index = 0; index < 25; index += 1) {
        const suffix = String(index).padStart(2, '0');
        seedSkill(sql, systemSkill({
          name: `bounded-system-${suffix}`,
          trigger_condition: `bounded deterministic skill ${suffix}`,
        }));
      }
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });

    expect(result).toEqual({ ok: false, failure: { code: 'skill_snapshot_invalid' } });
    expect('prompt' in result).toBe(false);
  });

  it('fails closed before decoding oversized active SQLite skill body or JSON fields', async () => {
    const oversizedBodyRuntime = runtimeStub();
    const oversizedBody = await runInDurableObject(oversizedBodyRuntime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      sql.exec(
        'UPDATE skills SET body_markdown = ? WHERE name = ?',
        'x'.repeat(2_401),
        'sqlite-afternoon-plan',
      );
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });
    expect(oversizedBody).toEqual({ ok: false, failure: { code: 'skill_snapshot_invalid' } });

    const oversizedJsonRuntime = runtimeStub();
    const oversizedJson = await runInDurableObject(oversizedJsonRuntime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      sql.exec(
        'UPDATE skills SET required_tools_json = ? WHERE name = ?',
        JSON.stringify(Array.from({ length: 512 }, () => 'get_tasks')),
        'sqlite-afternoon-plan',
      );
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });
    expect(oversizedJson).toEqual({ ok: false, failure: { code: 'skill_snapshot_invalid' } });
  });

  it('halts NUL-bearing oversized SQLite text before a skill row is materialised', async () => {
    const skillRuntime = runtimeStub();
    const unsafeSkill = await runInDurableObject(skillRuntime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      sql.exec(
        'UPDATE skills SET body_markdown = ? WHERE name = ?',
        `\0${'x'.repeat(2_401)}`,
        'sqlite-afternoon-plan',
      );
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });
    expect(unsafeSkill).toEqual({ ok: false, failure: { code: 'skill_snapshot_invalid' } });
    expect('prompt' in unsafeSkill).toBe(false);
  });

  it('fails closed for an active system row whose identity lock is corrupt', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      sql.exec('UPDATE skills SET identity_locked = 0 WHERE name = ?', 'sqlite-afternoon-plan');
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });

    expect(result).toEqual({ ok: false, failure: { code: 'skill_snapshot_invalid' } });
    expect('prompt' in result).toBe(false);
  });

  it('releases a completed failed SQLite capture so a later run can safely recapture', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, async (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      sql.exec(
        'UPDATE skills SET body_markdown = ? WHERE name = ?',
        'x'.repeat(2_401),
        'sqlite-afternoon-plan',
      );
      const deps = dependencies(sql);
      const rejected = await createContextComposer(deps).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
      sql.exec(
        'UPDATE skills SET body_markdown = ? WHERE name = ?',
        'Keep the next action concrete.',
        'sqlite-afternoon-plan',
      );
      const retried = await createContextComposer(deps).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
      return { rejected, retried };
    });

    expect(result.rejected).toEqual({ ok: false, failure: { code: 'skill_snapshot_invalid' } });
    expect(result.retried.ok, result.retried.ok ? undefined : result.retried.failure.code).toBe(true);
  });

  it('rejects replay drift after a completed local capture instead of retaining a permanent cache', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, async (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      const deps = dependencies(sql);
      const first = await createContextComposer(deps).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
      if (!first.ok) throw new Error(`initial frozen capture failed: ${first.failure.code}`);
      const independentlyReplayed = await createContextComposer(dependencies(sql)).compose(
        envelope(PRINCIPAL_A),
        { ...RUNTIME_INPUTS, replay_context_ref: first.checkpoint.context_ref },
      );

      sql.exec(
        'UPDATE skills SET body_markdown = ? WHERE name = ?',
        'Mutated skill text must not enter an already-captured snapshot.',
        'sqlite-afternoon-plan',
      );
      const replay = await createContextComposer(deps).compose(
        envelope(PRINCIPAL_A),
        { ...RUNTIME_INPUTS, replay_context_ref: first.checkpoint.context_ref },
      );
      const mutatedFreshReplay = await createContextComposer(dependencies(sql)).compose(
        envelope(PRINCIPAL_A),
        { ...RUNTIME_INPUTS, replay_context_ref: first.checkpoint.context_ref },
      );
      return { first, independentlyReplayed, replay, mutatedFreshReplay };
    });

    expect(result.first.ok).toBe(true);
    expect(
      result.independentlyReplayed.ok,
      result.independentlyReplayed.ok ? undefined : result.independentlyReplayed.failure.code,
    ).toBe(true);
    if (!result.first.ok || !result.independentlyReplayed.ok) return;
    expect(result.independentlyReplayed.prompt).toBe(result.first.prompt);
    expect(result.independentlyReplayed.checkpoint).toEqual(result.first.checkpoint);
    expect(result.replay).toEqual({ ok: false, failure: { code: 'provenance_invalid' } });
    expect('prompt' in result.replay).toBe(false);
    expect(result.mutatedFreshReplay).toEqual({ ok: false, failure: { code: 'provenance_invalid' } });
    expect('prompt' in result.mutatedFreshReplay).toBe(false);
  });

  it('releases completed snapshot state so the 65th sequential public composition succeeds', async () => {
    const runtime = runtimeStub();
    const results = await runInDurableObject(runtime, async (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      const composer = createContextComposer(dependencies(sql));
      const composed = [];
      for (let index = 1; index <= 65; index += 1) {
        composed.push(await composer.compose(envelope(PRINCIPAL_A), {
          ...RUNTIME_INPUTS,
          snapshot_ref: `snp_${index.toString(16).padStart(32, '0')}`,
        }));
      }
      return composed;
    });

    expect(results).toHaveLength(65);
    for (const result of results) {
      expect(result.ok, result.ok ? undefined : result.failure.code).toBe(true);
    }
  });
});
