import type {
  RuntimeContextCheckpoint,
  RuntimeContextSource,
  TrustedInvocationEnvelope,
} from '@waldo/contracts';
import { compareCodeUnits, sha256Hex, stableJson } from './canonical';
import { FailClosed } from './faults';
import type { PromptReplayIdentity } from './prompt';
import type {
  ContextSource,
  ContextSourceKind,
  ContextSourceScope,
  RuntimeOwnedContextInputs,
} from './types';

export const SOURCE_KEY = /^[a-z0-9][a-z0-9:_-]{0,255}$/;
export const REVISION_REF = /^rev_[a-f0-9]{32}$/;

export function isSourceKind(value: unknown): value is ContextSourceKind {
  return (
    value === 'invocation_input' ||
    value === 'recall' ||
    value === 'skill' ||
    value === 'derived_health_view' ||
    value === 'connector_snapshot' ||
    value === 'workspace_snapshot' ||
    value === 'tool_result' ||
    value === 'runtime_metadata'
  );
}

export function isSourceScope(value: unknown): value is ContextSourceScope {
  return value === 'invocation' || value === 'principal' || value === 'tenant' || value === 'thread' || value === 'system';
}

type StoredProvenanceSource = Readonly<{
  source: ContextSource;
  fingerprint: string;
  revision_ref: string;
}>;

export class ProvenanceCollector {
  readonly #sources = new Map<string, StoredProvenanceSource>();
  readonly #revisions = new Map<string, string>();

  constructor(
    private readonly invocation: TrustedInvocationEnvelope,
    private readonly inputs: RuntimeOwnedContextInputs,
  ) {}

  add(
    source: ContextSource,
    expected: Partial<Pick<ContextSource, 'source_kind' | 'scope' | 'source_taint'>> = {},
    fingerprint = '',
    revisionRef = 'rev_00000000000000000000000000000000',
  ): void {
    if (
      source === null ||
      typeof source !== 'object' ||
      typeof source.source_key !== 'string' ||
      !SOURCE_KEY.test(source.source_key) ||
      !isSourceKind(source.source_kind) ||
      !isSourceScope(source.scope) ||
      (source.source_taint !== null && source.source_taint !== 'external') ||
      !Number.isSafeInteger(source.produced_at) ||
      source.produced_at < 0 ||
      source.produced_at > this.inputs.snapshot_at ||
      (expected.source_kind !== undefined && source.source_kind !== expected.source_kind) ||
      (expected.scope !== undefined && source.scope !== expected.scope) ||
      (expected.source_taint !== undefined && source.source_taint !== expected.source_taint) ||
      ((source.source_kind === 'connector_snapshot' || source.source_kind === 'workspace_snapshot') &&
        source.source_taint !== 'external') ||
      (source.source_kind === 'derived_health_view' &&
        source.scope !== 'invocation' &&
        source.scope !== 'principal') ||
      !REVISION_REF.test(revisionRef)
    ) {
      throw new FailClosed('provenance_invalid');
    }

    const sourceKey = sourceIdentity(source, this.invocation);
    const existing = this.#sources.get(sourceKey);
    if (existing !== undefined) {
      if (
        existing.source.source_kind !== source.source_kind ||
        existing.source.scope !== source.scope ||
        existing.source.source_taint !== source.source_taint ||
        existing.source.produced_at !== source.produced_at ||
        existing.fingerprint !== fingerprint ||
        existing.revision_ref !== revisionRef
      ) {
        throw new FailClosed('provenance_invalid');
      }
      return;
    }
    this.#sources.set(sourceKey, Object.freeze({
      source: Object.freeze({ ...source }),
      fingerprint,
      revision_ref: revisionRef,
    }));
  }

  attest(label: string, revisionRef: string): void {
    if (!/^[a-z_]{1,64}$/.test(label) || !REVISION_REF.test(revisionRef)) {
      throw new FailClosed('provenance_invalid');
    }
    const existing = this.#revisions.get(label);
    if (existing !== undefined && existing !== revisionRef) throw new FailClosed('provenance_invalid');
    this.#revisions.set(label, revisionRef);
  }

  async checkpoint(promptIdentity: PromptReplayIdentity): Promise<RuntimeContextCheckpoint> {
    if (
      !/^[a-z][a-z0-9._-]{0,127}$/.test(promptIdentity.serializer_revision) ||
      !/^sha256:[a-f0-9]{64}$/.test(promptIdentity.prompt_digest)
    ) {
      throw new FailClosed('provenance_invalid');
    }
    const sourceStamps = [...this.#sources.values()];
    if (sourceStamps.length === 0 || sourceStamps.length > 32) throw new FailClosed('provenance_invalid');
    const stampedSources = await Promise.all(sourceStamps.map(async (stamp) => ({
      stamp,
      source_ref: `src_${(await sha256Hex(sourceRefSeed(stamp, this.invocation))).slice(0, 32)}`,
    })));
    stampedSources.sort((left, right) => compareCodeUnits(left.source_ref, right.source_ref));
    const sources: RuntimeContextSource[] = [];
    const refs = new Set<string>();
    for (const { stamp, source_ref } of stampedSources) {
      if (refs.has(source_ref)) throw new FailClosed('provenance_invalid');
      refs.add(source_ref);
      sources.push({
        source_ref,
        source_kind: stamp.source.source_kind,
        scope: stamp.source.scope,
        source_taint: stamp.source.source_taint,
        produced_at: stamp.source.produced_at,
      });
    }
    const sourceTaint = sources.some((source) => source.source_taint === 'external') ? 'external' : null;
    const contextRef = `ctx_${(
      await sha256Hex(
        contextSeed(
          this.invocation,
          this.inputs,
          promptIdentity,
          [...this.#revisions.entries()].sort(([left], [right]) => compareCodeUnits(left, right)),
          sources.map((source) => source.source_ref),
        ),
      )
    ).slice(0, 32)}`;
    return {
      context_version: 2,
      context_ref: contextRef,
      principal_ref: this.invocation.verified_authority.principal_ref,
      tenant_ref: this.invocation.verified_authority.tenant_ref,
      invocation_idempotency_ref: this.invocation.idempotency.key_ref,
      produced_at: this.inputs.snapshot_at,
      source_taint: sourceTaint,
      sanitisation: 'passed',
      sources,
    };
  }
}

function sourceIdentity(source: ContextSource, invocation: TrustedInvocationEnvelope): string {
  return stableJson({
    source_key: source.source_key,
    source_kind: source.source_kind,
    scope: source.scope,
    scope_qualifier: scopeQualifier(source.scope, invocation),
  });
}

function sourceRefSeed(stamp: StoredProvenanceSource, invocation: TrustedInvocationEnvelope): string {
  return stableJson({
    source: sourceIdentity(stamp.source, invocation),
    source_taint: stamp.source.source_taint,
    produced_at: stamp.source.produced_at,
    fingerprint: stamp.fingerprint,
    revision_ref: stamp.revision_ref,
  });
}

function scopeQualifier(scope: ContextSourceScope, invocation: TrustedInvocationEnvelope): string {
  const { principal_ref, tenant_ref } = invocation.verified_authority;
  switch (scope) {
    case 'system':
      return 'system';
    case 'tenant':
      return tenant_ref;
    case 'principal':
      return `${tenant_ref}:${principal_ref}`;
    case 'invocation':
    case 'thread':
      return `${tenant_ref}:${principal_ref}:${invocation.idempotency.key_ref}`;
  }
}

function contextSeed(
  invocation: TrustedInvocationEnvelope,
  inputs: RuntimeOwnedContextInputs,
  promptIdentity: PromptReplayIdentity,
  revisions: readonly (readonly [string, string])[],
  sourceRefs: readonly string[],
): string {
  return [
    'context-v2',
    invocation.verified_authority.principal_ref,
    invocation.verified_authority.tenant_ref,
    invocation.idempotency.key_ref,
    invocation.runtime_binding.trigger,
    invocation.runtime_binding.variant ?? '',
    inputs.snapshot_ref,
    String(inputs.snapshot_at),
    promptIdentity.serializer_revision,
    promptIdentity.prompt_digest,
    ...invocation.input_refs.flatMap((reference) => [reference.input_ref, reference.content_digest]),
    ...revisions.flatMap(([label, revision]) => [label, revision]),
    ...sourceRefs,
  ].join('\n');
}

export type FrozenSnapshotReplayLease = Readonly<{
  assertStable(promptDigest: string, checkpoint: RuntimeContextCheckpoint): void;
  release(): void;
}>;

type FrozenSnapshotReplayRun = {
  active: number;
  proof: string | undefined;
};

export class FrozenSnapshotReplayGuard {
  readonly #runs = new Map<string, FrozenSnapshotReplayRun>();

  begin(
    invocation: TrustedInvocationEnvelope,
    inputs: RuntimeOwnedContextInputs,
  ): FrozenSnapshotReplayLease {
    const key = [
      invocation.verified_authority.tenant_ref,
      invocation.verified_authority.principal_ref,
      invocation.idempotency.key_ref,
      inputs.snapshot_ref,
      String(inputs.snapshot_at),
    ].join(':');
    const run = this.#runs.get(key) ?? { active: 0, proof: undefined };
    if (!this.#runs.has(key)) this.#runs.set(key, run);
    run.active += 1;
    let released = false;
    return Object.freeze({
      assertStable: (promptDigest, checkpoint) => {
        const proof = stableJson({
          prompt_digest: promptDigest,
          context_ref: checkpoint.context_ref,
          sources: checkpoint.sources.map((source) => source.source_ref),
        });
        if (run.proof !== undefined && run.proof !== proof) {
          throw new FailClosed('provenance_invalid');
        }
        run.proof = proof;
      },
      release: () => {
        if (released) return;
        released = true;
        run.active -= 1;
        if (run.active === 0 && this.#runs.get(key) === run) this.#runs.delete(key);
      },
    });
  }
}
