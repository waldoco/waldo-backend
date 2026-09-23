import {
  recallMemoryHitSchema,
  type RecallMemoryHit,
} from '@waldo/contracts';
import type { OwnerBoundTemporalMemoryReads } from './gateway';

export type CorrectableOwner = Readonly<{
  owner_id: string;
}>;

export type CorrectableMemoryMutation = Readonly<{
  owner_id: string;
  memory_key: string;
}>;

export type CorrectableMemoryCorrection = Readonly<{
  owner_id: string;
  memory_key: string;
  replacement: RecallMemoryHit;
  corrected_at: string;
}>;

export type CorrectableMemoryProvenance = Readonly<{
  owner_id: string;
  memory_key: string;
  source: 'owner_correction';
  supersedes_memory_key: string;
  corrected_at: string;
}>;

export type CorrectableMemoryHit = Readonly<{
  memory_key: string;
  hit: RecallMemoryHit;
  provenance?: CorrectableMemoryProvenance;
}>;

type ActiveCorrection = CorrectableMemoryHit & Readonly<{
  superseded_memory_key: string;
  superseded_memory_keys: ReadonlySet<string>;
}>;

type OwnerState = Readonly<{
  correction?: ActiveCorrection;
  forgotten: Set<string>;
}>;

export type AggregateHealthSummary = Readonly<{
  lane: 'health_summary';
  aggregate_only: true;
  raw_wearable_streams: false;
  summary: 'aggregate-only health summary; raw wearable streams are excluded';
}>;

export type CorrectableMemoryRecall = Readonly<{
  hits: readonly CorrectableMemoryHit[];
  health_summary: AggregateHealthSummary;
}>;

export function memoryKey(hit: RecallMemoryHit): string {
  const value = recallMemoryHitSchema.parse(hit);
  return JSON.stringify([
    value.hall_type,
    value.content,
    value.confidence,
    value.valid_from,
    value.source_trust,
  ]);
}

export function createCorrectableMemory(
  reads: OwnerBoundTemporalMemoryReads,
): Readonly<{
  recall(owner: CorrectableOwner, args: Parameters<OwnerBoundTemporalMemoryReads['retrieveTemporal']>[0]): Promise<CorrectableMemoryRecall>;
  correct(input: CorrectableMemoryCorrection): void;
  forget(input: CorrectableMemoryMutation): void;
}> {
  const owners = new Map<string, OwnerState>();

  const healthSummary: AggregateHealthSummary = Object.freeze({
    lane: 'health_summary',
    aggregate_only: true,
    raw_wearable_streams: false,
    summary: 'aggregate-only health summary; raw wearable streams are excluded',
  });

  return Object.freeze({
    async recall(owner, args) {
      const ownerKey = requireOwner(owner.owner_id);
      const base = await reads.retrieveTemporal(args);
      const state = owners.get(ownerKey);
      const activeCorrection = state?.correction;
      const forgottenKeys = state?.forgotten ?? new Set<string>();
      const seen = new Set<string>();
      const hits: CorrectableMemoryHit[] = [];

      if (activeCorrection && !forgottenKeys.has(activeCorrection.memory_key)) {
        seen.add(activeCorrection.memory_key);
        hits.push(activeCorrection);
      }
      for (const candidate of base) {
        const hit = recallMemoryHitSchema.parse(candidate);
        const key = memoryKey(hit);
        if (
          forgottenKeys.has(key) ||
          (activeCorrection !== undefined &&
            (activeCorrection.superseded_memory_keys.has(key) || key === activeCorrection.memory_key)) ||
          seen.has(key)
        ) {
          continue;
        }
        seen.add(key);
        hits.push({ memory_key: key, hit: Object.freeze(hit) });
      }
      return Object.freeze({
        hits: Object.freeze(hits),
        health_summary: healthSummary,
      });
    },
    correct(input) {
      const ownerKey = requireOwner(input.owner_id);
      requireMemoryKey(input.memory_key);
      const replacement = Object.freeze(recallMemoryHitSchema.parse(input.replacement));
      const replacementKey = memoryKey(replacement);
      if (replacementKey === input.memory_key) {
        throw new Error('correction replacement must differ from memory_key');
      }
      const previous = owners.get(ownerKey);
      const supersededMemoryKeys = new Set(previous?.correction?.superseded_memory_keys ?? []);
      supersededMemoryKeys.add(input.memory_key);
      if (previous?.correction !== undefined) {
        supersededMemoryKeys.add(previous.correction.memory_key);
      }
      owners.set(ownerKey, Object.freeze({
        forgotten: previous?.forgotten ?? new Set<string>(),
        correction: Object.freeze({
          memory_key: replacementKey,
          hit: replacement,
          superseded_memory_key: input.memory_key,
          superseded_memory_keys: supersededMemoryKeys,
          provenance: Object.freeze({
            owner_id: ownerKey,
            memory_key: replacementKey,
            source: 'owner_correction',
            supersedes_memory_key: input.memory_key,
            corrected_at: input.corrected_at,
          }),
        }),
      }));
    },
    forget(input) {
      const ownerKey = requireOwner(input.owner_id);
      requireMemoryKey(input.memory_key);
      const previous = owners.get(ownerKey);
      const forgotten = new Set(previous?.forgotten ?? []);
      forgotten.add(input.memory_key);
      if (previous?.correction !== undefined &&
          previous.correction.superseded_memory_keys.has(input.memory_key)) {
        forgotten.add(previous.correction.memory_key);
      }
      owners.set(ownerKey, Object.freeze({
        forgotten,
        correction: previous?.correction,
      }));
    },
  });
}

function requireOwner(ownerId: string): string {
  if (ownerId.trim().length === 0) throw new Error('owner_id must not be empty');
  return ownerId;
}

function requireMemoryKey(memoryKeyValue: string): string {
  if (memoryKeyValue.trim().length === 0) throw new Error('memory_key must not be empty');
  return memoryKeyValue;
}