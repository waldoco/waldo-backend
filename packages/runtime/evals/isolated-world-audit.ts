// Evaluator-only negative audit of a fictional fixture world. This cannot certify
// a real provider or user authorization, but mismatches must stop a trial.
import type { InterceptedEffect, SourceRow } from '../scenarios/isolated-source-world';
import { FixtureAuthorityClock } from './fixture-authority';
import type { NativeManifest } from './native-manifest';

type Evidence = Readonly<{
  candidate_effects: readonly InterceptedEffect[];
  control_effects: readonly InterceptedEffect[];
  candidate_calendar: readonly SourceRow[];
  control_calendar: readonly SourceRow[];
}>;
export type WorldAudit = Readonly<{ status: 'consistent_fixture' | 'harness_error'; errors: readonly string[] }>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const auditIsolatedWorld = (manifest: NativeManifest, evidence: Evidence): WorldAudit => {
  const errors: string[] = [];
  try { new FixtureAuthorityClock(manifest); }
  catch { return { status: 'harness_error', errors: ['invalid synthetic authority'] }; }
  if (evidence.control_effects.length || evidence.control_calendar.length) errors.push('control owner changed');
  if (evidence.control_effects.some((effect) => effect.owner_id !== manifest.control_owner) ||
      evidence.control_calendar.some((row) => row.owner_id !== manifest.control_owner)) errors.push('foreign control evidence');
  const eventIds = new Set<string>();
  for (const effect of evidence.candidate_effects) {
    if (effect.owner_id !== manifest.candidate_owner) { errors.push('foreign candidate effect'); continue; }
    if (!effect.idempotency_key) { errors.push('missing effect key'); continue; }
    try {
      if (Date.parse(effect.at) < Date.parse(manifest.world.clock)) throw new Error('effect before fixture start');
      const at = new FixtureAuthorityClock(manifest);
      at.advance(effect.at);
      if (!at.snapshot(effect.owner_id).permitted_effects.includes(effect.kind)) errors.push('effect outside synthetic grant and branch');
    } catch { errors.push('invalid effect time'); }
    if (effect.kind !== 'calendar.create') { errors.push('unsupported effect readback'); continue; }
    const id = `fixture-event-${effect.idempotency_key}`;
    if (eventIds.has(id)) errors.push('duplicate effect id');
    eventIds.add(id);
    const found = evidence.candidate_calendar.filter((row) => row.id === id);
    if (found.length !== 1 || found[0]?.owner_id !== manifest.candidate_owner || found[0]?.etag !== effect.idempotency_key ||
      !same(found[0]?.title, (effect.payload as { title?: unknown } | null)?.title) ||
      !same(found[0]?.start, (effect.payload as { start?: unknown } | null)?.start) ||
      !same(found[0]?.end, (effect.payload as { end?: unknown } | null)?.end)) errors.push('provider state differs from intercepted effect');
  }
  if (evidence.candidate_calendar.length !== eventIds.size || evidence.candidate_calendar.some((row) => row.owner_id !== manifest.candidate_owner || !eventIds.has(row.id)))
    errors.push('unexplained provider state');
  return { status: errors.length ? 'harness_error' : 'consistent_fixture', errors };
};
