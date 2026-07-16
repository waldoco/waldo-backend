import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import {
  acceptTrustedInvocation,
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
  type HeadlessLegacyMemoryTaintProof,
  HeadlessLocalOwnerBindingResolver,
  SqliteSystemSkillRepository,
  SqliteTemporalRecallGateway,
} from '../src/context-composer/sqlite';
import { provisionDoSchema } from '../src/do-schema';
import type { RuntimeProbeDO } from '../src/index';
import type { ResolvedSkillBudget } from '../src/skills/budget';

const SNAPSHOT_AT = Date.parse('2026-07-15T12:00:00.000Z');
const PRINCIPAL_A = 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRINCIPAL_B = 'prn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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

function runtimeStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`context-composer-sqlite-${sequence}`));
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

function seedMemory(
  sql: SqlStorage,
  values: Readonly<{ id: string; user_id: string; content: string; valid_from: string; valid_to?: string | null }>,
): void {
  sql.exec(
    `INSERT INTO memory_blocks (
      id, user_id, hall_type, content, confidence, created_at, valid_from, valid_to,
      source_trust
    ) VALUES (?, ?, 'preferences', ?, 0.9, ?, ?, ?, 'user_stated')`,
    values.id,
    values.user_id,
    values.content,
    values.valid_from,
    values.valid_from,
    values.valid_to ?? null,
  );
}

function seedEpisode(
  sql: SqlStorage,
  values: Readonly<{ id: string; user_id: string; summary: string; occurred_at: string }>,
): void {
  sql.exec(
    `INSERT INTO episodes (id, user_id, occurred_at, summary, source, source_ref, created_at)
     VALUES (?, ?, ?, ?, 'headless_local', NULL, ?)`,
    values.id,
    values.user_id,
    values.occurred_at,
    values.summary,
    values.occurred_at,
  );
}

const TEST_ONLY_LOCAL_MEMORY_TAINT_PROOF: HeadlessLegacyMemoryTaintProof = {
  taintForMemoryRow: () => null,
};

function dependencies(
  sql: SqlStorage,
  taintProof: HeadlessLegacyMemoryTaintProof | null = TEST_ONLY_LOCAL_MEMORY_TAINT_PROOF,
): ContextComposerDependencies {
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
    // Explicit test-only proof: production legacy rows do not retain source taint and default
    // to external/empty recall until a real source-provenance adapter exists.
    recall: taintProof === null
      ? SqliteTemporalRecallGateway.create(sql, REVISION.recall)
      : SqliteTemporalRecallGateway.forHeadlessTest(sql, REVISION.recall, taintProof),
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

  it('reads active system skills and point-in-time owner-bound memory without cross-owner leakage or fabricated episode ranks', async () => {
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
      seedMemory(sql, {
        id: 'memory-a-old',
        user_id: OWNER_A,
        content: 'Owner A earlier memory.',
        valid_from: '2026-07-14T08:00:00.000Z',
      });
      seedMemory(sql, {
        id: 'memory-a-new',
        user_id: OWNER_A,
        content: 'Owner A latest memory.',
        valid_from: '2026-07-14T09:00:00.000Z',
      });
      seedMemory(sql, {
        // 11:59Z: lexicographically after the 12:00Z snapshot but instant-eligible.
        id: 'memory-a-offset-eligible',
        user_id: OWNER_A,
        content: 'Owner A offset-shaped eligible memory.',
        valid_from: '2026-07-15T17:29:00+05:30',
      });
      seedMemory(sql, {
        // 12:01Z: must remain absent despite the same offset representation.
        id: 'memory-a-offset-future',
        user_id: OWNER_A,
        content: 'Owner A offset-shaped future memory must remain absent.',
        valid_from: '2026-07-15T17:31:00+05:30',
      });
      seedMemory(sql, {
        id: 'memory-a-superseded',
        user_id: OWNER_A,
        content: 'Superseded owner A memory must remain absent.',
        valid_from: '2026-07-10T09:00:00.000Z',
        valid_to: '2026-07-14T10:00:00.000Z',
      });
      seedMemory(sql, {
        id: 'memory-b',
        user_id: OWNER_B,
        content: 'Foreign owner B memory must remain absent.',
        valid_from: '2026-07-14T11:00:00.000Z',
      });
      seedEpisode(sql, {
        id: 'episode-a',
        user_id: OWNER_A,
        summary: 'Owner A local episode.',
        occurred_at: '2026-07-14T12:00:00.000Z',
      });
      seedEpisode(sql, {
        id: 'episode-b',
        user_id: OWNER_B,
        summary: 'Foreign owner B episode must remain absent.',
        occurred_at: '2026-07-14T12:00:00.000Z',
      });

      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });

    expect(result.ok, result.ok ? undefined : result.failure.code).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.skills.selected).toEqual(['sqlite-afternoon-plan']);
    expect(result.evidence.recall.status).toBe('partial');
    expect(result.prompt).toContain('Owner A offset-shaped eligible memory.');
    expect(result.prompt).toContain('Owner A latest memory.');
    expect(result.prompt).toContain('Owner A earlier memory.');
    expect(result.prompt.indexOf('Owner A offset-shaped eligible memory.')).toBeLessThan(
      result.prompt.indexOf('Owner A latest memory.'),
    );
    expect(result.prompt.indexOf('Owner A latest memory.')).toBeLessThan(
      result.prompt.indexOf('Owner A earlier memory.'),
    );
    for (const absent of [
      'Foreign owner B memory must remain absent.',
      'Owner A local episode.',
      'Foreign owner B episode must remain absent.',
      'Superseded owner A memory must remain absent.',
      'Owner A offset-shaped future memory must remain absent.',
      'foreign-user-skill',
    ]) {
      expect(result.prompt).not.toContain(absent);
      expect(JSON.stringify(result)).not.toContain(absent);
    }
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

  it('halts NUL-bearing oversized SQLite text before a skill or memory row is materialised', async () => {
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

    const memoryRuntime = runtimeStub();
    const unsafeMemory = await runInDurableObject(memoryRuntime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedMemory(sql, {
        id: 'nul-prefixed-memory',
        user_id: OWNER_A,
        content: 'safe placeholder',
        valid_from: '2026-07-14T09:00:00.000Z',
      });
      sql.exec(
        'UPDATE memory_blocks SET content = ? WHERE id = ?',
        `x\0${'m'.repeat(2_001)}`,
        'nul-prefixed-memory',
      );
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });
    expect(unsafeMemory).toEqual({ ok: false, failure: { code: 'recall_integrity' } });
    expect('prompt' in unsafeMemory).toBe(false);

    const validToRuntime = runtimeStub();
    const unsafeValidTo = await runInDurableObject(validToRuntime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedMemory(sql, {
        id: 'nul-bearing-valid-to',
        user_id: OWNER_A,
        content: 'safe placeholder',
        valid_from: '2026-07-14T09:00:00.000Z',
        valid_to: '9999-12-31T00:00:00.000Z',
      });
      sql.exec(
        'UPDATE memory_blocks SET valid_to = ? WHERE id = ?',
        `9999-12-31T00:00:00.000Z\0${'v'.repeat(100)}`,
        'nul-bearing-valid-to',
      );
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });
    expect(unsafeValidTo).toEqual({ ok: false, failure: { code: 'recall_integrity' } });
    expect('prompt' in unsafeValidTo).toBe(false);
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

  it('halts before an oversized eligible SQLite memory row can reach recall parsing', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedMemory(sql, {
        id: 'oversized-memory',
        user_id: OWNER_A,
        content: 'm'.repeat(2_001),
        valid_from: '2026-07-14T09:00:00.000Z',
      });
      return createContextComposer(dependencies(sql)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });

    expect(result).toEqual({ ok: false, failure: { code: 'recall_integrity' } });
    expect('prompt' in result).toBe(false);
  });

  it('keeps a rejected SQLite source capture fail-closed after the live row is repaired', async () => {
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
    expect(result.retried).toEqual(result.rejected);
  });

  it('holds one headless SQLite source capture across a database mutation for the same snapshot refs', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, async (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedMemory(sql, {
        id: 'frozen-memory',
        user_id: OWNER_A,
        content: 'Original frozen owner memory.',
        valid_from: '2026-07-14T09:00:00.000Z',
      });
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
      sql.exec(
        'UPDATE memory_blocks SET content = ? WHERE id = ?',
        'Mutated memory text must not enter an already-captured snapshot.',
        'frozen-memory',
      );
      const replay = await createContextComposer(deps).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
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
    expect(result.replay.ok, result.replay.ok ? undefined : result.replay.failure.code).toBe(true);
    if (!result.first.ok || !result.independentlyReplayed.ok || !result.replay.ok) return;
    expect(result.independentlyReplayed.prompt).toBe(result.first.prompt);
    expect(result.independentlyReplayed.checkpoint).toEqual(result.first.checkpoint);
    expect(result.replay.prompt).toBe(result.first.prompt);
    expect(result.replay.checkpoint).toEqual(result.first.checkpoint);
    expect(result.replay.prompt).toContain('Original frozen owner memory.');
    expect(JSON.stringify(result.replay)).not.toContain('Mutated memory text');
    expect(JSON.stringify(result.replay)).not.toContain('Mutated skill text');
    expect(result.mutatedFreshReplay).toEqual({ ok: false, failure: { code: 'provenance_invalid' } });
    expect('prompt' in result.mutatedFreshReplay).toBe(false);
  });

  it('keeps unproven legacy local memory out of the prompt instead of claiming a live trusted source', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedMemory(sql, {
        id: 'memory-unproven',
        user_id: OWNER_A,
        content: 'Unproven legacy memory must not be admitted.',
        valid_from: '2026-07-14T09:00:00.000Z',
      });
      return createContextComposer(dependencies(sql, null)).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });

    expect(result.ok, result.ok ? undefined : result.failure.code).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.recall.status).toBe('partial');
    expect(result.prompt).toContain('No relevant memory or history surfaced for this context.');
    expect(JSON.stringify(result)).not.toContain('Unproven legacy memory must not be admitted.');
  });

  it('partitions the bounded legacy owner mapping and recall query by tenant as well as principal', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedMemory(sql, {
        id: 'memory-principal-b-tenant-a',
        user_id: OWNER_B,
        content: 'Same principal in tenant A must remain absent.',
        valid_from: '2026-07-14T09:00:00.000Z',
      });
      seedMemory(sql, {
        id: 'memory-principal-b-tenant-b',
        user_id: OWNER_B_TENANT_B,
        content: 'Tenant B principal-scoped local memory.',
        valid_from: '2026-07-14T10:00:00.000Z',
      });
      return createContextComposer(dependencies(sql)).compose(
        envelope(PRINCIPAL_B, TENANT_B),
        RUNTIME_INPUTS,
      );
    });

    expect(result.ok, result.ok ? undefined : result.failure.code).toBe(true);
    if (!result.ok) return;
    expect(result.checkpoint).toMatchObject({ principal_ref: PRINCIPAL_B, tenant_ref: TENANT_B });
    expect(result.prompt).toContain('Tenant B principal-scoped local memory.');
    expect(JSON.stringify(result)).not.toContain('Same principal in tenant A must remain absent.');
  });

  it('fails closed when the explicit headless local-taint proof cannot prove a memory row', async () => {
    const runtime = runtimeStub();
    const result = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedSkill(sql, systemSkill());
      seedMemory(sql, {
        id: 'memory-proof-error',
        user_id: OWNER_A,
        content: 'A taint-proof error must not become fail-open recall.',
        valid_from: '2026-07-14T09:00:00.000Z',
      });
      return createContextComposer(dependencies(sql, {
        taintForMemoryRow: () => {
          throw new Error('proof source unavailable');
        },
      })).compose(envelope(PRINCIPAL_A), RUNTIME_INPUTS);
    });

    expect(result).toEqual({ ok: false, failure: { code: 'recall_integrity' } });
    expect('prompt' in result).toBe(false);
  });
});
