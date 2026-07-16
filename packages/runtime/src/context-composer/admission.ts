import {
  canaryTokensSchema,
  type CanaryTokens,
  type DerivedHealthDestinationView,
  type InvocationInputReference,
  type NarrativeContext,
  type TrustedInvocationEnvelope,
} from '@waldo/contracts';
import { compareCodeUnits } from './canonical';
import {
  ContextSourceRejectedError,
  ContextSourceUnavailableError,
  FailClosed,
} from './faults';
import { isSourceKind, isSourceScope, ProvenanceCollector, REVISION_REF } from './provenance';
import type {
  ContextCompositionFailureCode,
  ContextHealthMaterial,
  ContextSnapshotAttestation,
  ContextSource,
  ResolvedInvocationInput,
  RuntimeOwnedContextInputs,
} from './types';

const MAX_SNAPSHOT_TIME = 253_402_300_799_999;
const MAX_SNAPSHOT_STRING_CHARS = 8_192;
const SNAPSHOT_REF = /^snp_[a-f0-9]{32}$/;
const RESERVED_SNAPSHOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Expected source faults are distinguished from implementation defects here. Unexpected throws
// deliberately escape to ContextComposer's injected internal observer.
export async function loadExpectedSource<T>(
  load: () => Promise<T>,
  failure: ContextCompositionFailureCode,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ContextSourceUnavailableError) throw new FailClosed(failure);
    if (error instanceof ContextSourceRejectedError && error.failure === failure) {
      throw new FailClosed(failure);
    }
    // Error objects cross an adapter boundary at runtime, so a TypeScript annotation on
    // `failure` is not authority to publish it. A rejected source can only select the
    // fail-closed outcome assigned to this stage; any other value remains an unexpected fault.
    throw error;
  }
}

export function snapshotAdapterPayload(value: unknown, failure: ContextCompositionFailureCode): unknown {
  try {
    return snapshotData(value);
  } catch {
    // This branch only admits an already-returned hostile payload. It never classifies an
    // adapter/programmer throw; those pass through loadExpectedSource to the observer.
    throw new FailClosed(failure);
  }
}

export function validateRuntimeInputs(
  value: RuntimeOwnedContextInputs,
  invocation: TrustedInvocationEnvelope,
): RuntimeOwnedContextInputs {
  let snapshot: unknown;
  try {
    snapshot = snapshotData(value);
  } catch {
    throw new FailClosed('invalid_runtime_inputs');
  }
  if (!isStrictRuntimeInputs(snapshot)) throw new FailClosed('invalid_runtime_inputs');
  const snapshotRef = typeof snapshot.snapshot_ref === 'string' ? snapshot.snapshot_ref : '';
  const snapshotAt = snapshot.snapshot_at;
  const replayContextRef = snapshot.replay_context_ref;
  const canaries = canaryTokensSchema.safeParse(snapshot.canary_tokens);
  if (
    !SNAPSHOT_REF.test(snapshotRef) ||
    !Number.isSafeInteger(snapshotAt) ||
    snapshotAt < invocation.accepted_at ||
    snapshotAt > MAX_SNAPSHOT_TIME ||
    (replayContextRef !== null &&
      (typeof replayContextRef !== 'string' || !/^ctx_[a-f0-9]{32}$/.test(replayContextRef))) ||
    !canaries.success
  ) {
    throw new FailClosed('invalid_runtime_inputs');
  }
  return Object.freeze({
    snapshot_ref: snapshotRef,
    snapshot_at: snapshotAt,
    canary_tokens: Object.freeze([...canaries.data]) as unknown as CanaryTokens,
    replay_context_ref: replayContextRef,
  });
}

function isStrictRuntimeInputs(value: unknown): value is RuntimeOwnedContextInputs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  const keys = Object.getOwnPropertyNames(value).sort(compareCodeUnits);
  if (
    keys.length !== 4 ||
    keys[0] !== 'canary_tokens' ||
    keys[1] !== 'replay_context_ref' ||
    keys[2] !== 'snapshot_at' ||
    keys[3] !== 'snapshot_ref'
  ) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.get === undefined && descriptor.set === undefined,
  );
}

export function snapshotData(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const copy = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 4_096 || depth > 32) throw new Error('snapshot too complex');
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (current.length > MAX_SNAPSHOT_STRING_CHARS) throw new Error('snapshot string oversize');
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('invalid number');
      return current;
    }
    if (typeof current !== 'object' || seen.has(current)) throw new Error('invalid object graph');
    seen.add(current);
    if (Array.isArray(current)) {
      const length = Object.getOwnPropertyDescriptor(current, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 256) throw new Error('invalid array');
      const values: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !('value' in descriptor)) throw new Error('array accessor');
        values.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(values);
    }
    if (Object.getPrototypeOf(current) !== Object.prototype || Object.getOwnPropertySymbols(current).length > 0) {
      throw new Error('invalid record');
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors).sort(compareCodeUnits)) {
      if (RESERVED_SNAPSHOT_KEYS.has(key)) throw new Error('reserved record key');
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new Error('record accessor');
      }
      // Defining a data property avoids inherited setters when copying hostile object keys.
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(result);
  };
  return copy(value, 0);
}

export function snapshotArray(value: unknown): readonly unknown[] | null {
  try {
    const copied = snapshotData(value);
    return Array.isArray(copied) ? copied : null;
  } catch {
    return null;
  }
}

export function recordWithKeys(
  value: unknown,
  keys: readonly string[],
  failure: ContextCompositionFailureCode,
): Readonly<Record<string, unknown>> {
  let copied: unknown;
  try {
    copied = snapshotData(value);
  } catch {
    throw new FailClosed(failure);
  }
  if (
    typeof copied !== 'object' ||
    copied === null ||
    Array.isArray(copied) ||
    Object.getPrototypeOf(copied) !== Object.prototype
  ) {
    throw new FailClosed(failure);
  }
  const actual = Object.keys(copied).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new FailClosed(failure);
  }
  return copied as Readonly<Record<string, unknown>>;
}

export function snapshotContextSource(
  value: unknown,
  failure: ContextCompositionFailureCode,
): ContextSource {
  const source = recordWithKeys(
    value,
    ['source_key', 'source_kind', 'scope', 'source_taint', 'produced_at'],
    failure,
  );
  if (
    typeof source.source_key !== 'string' ||
    !isSourceKind(source.source_kind) ||
    !isSourceScope(source.scope) ||
    (source.source_taint !== null && source.source_taint !== 'external') ||
    !Number.isSafeInteger(source.produced_at)
  ) {
    throw new FailClosed(failure);
  }
  const producedAt = source.produced_at;
  return Object.freeze({
    source_key: source.source_key,
    source_kind: source.source_kind,
    scope: source.scope,
    source_taint: source.source_taint,
    produced_at: producedAt as number,
  });
}

export function attestSnapshot(
  value: unknown,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
  label: string,
  failure: ContextCompositionFailureCode,
): ContextSnapshotAttestation {
  const snapshot = recordWithKeys(value, ['snapshot_ref', 'snapshot_at', 'revision_ref'], failure);
  if (
    snapshot.snapshot_ref !== inputs.snapshot_ref ||
    snapshot.snapshot_at !== inputs.snapshot_at ||
    typeof snapshot.revision_ref !== 'string' ||
    !REVISION_REF.test(snapshot.revision_ref)
  ) {
    throw new FailClosed(failure);
  }
  provenance.attest(label, snapshot.revision_ref);
  return Object.freeze({
    snapshot_ref: inputs.snapshot_ref,
    snapshot_at: inputs.snapshot_at,
    revision_ref: snapshot.revision_ref,
  });
}

export function snapshotResolvedInput(value: unknown): ResolvedInvocationInput {
  const input = recordWithKeys(
    value,
    ['input_ref', 'content_digest', 'principal_ref', 'tenant_ref', 'text', 'source'],
    'input_integrity',
  );
  if (
    typeof input.input_ref !== 'string' ||
    typeof input.content_digest !== 'string' ||
    typeof input.principal_ref !== 'string' ||
    typeof input.tenant_ref !== 'string' ||
    typeof input.text !== 'string'
  ) {
    throw new FailClosed('input_integrity');
  }
  return Object.freeze({
    input_ref: input.input_ref as InvocationInputReference['input_ref'],
    content_digest: input.content_digest as InvocationInputReference['content_digest'],
    principal_ref: input.principal_ref,
    tenant_ref: input.tenant_ref,
    text: input.text,
    source: snapshotContextSource(input.source, 'input_integrity'),
  });
}

export function snapshotHealthMaterial(
  value: unknown,
  failure: ContextCompositionFailureCode,
): ContextHealthMaterial | null {
  if (value === null) return null;
  const health = recordWithKeys(value, ['view', 'narrative', 'source'], failure);
  return Object.freeze({
    view: snapshotData(health.view) as DerivedHealthDestinationView,
    narrative: snapshotData(health.narrative) as NarrativeContext,
    source: snapshotContextSource(health.source, failure),
  });
}
