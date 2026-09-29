// Evaluator-side fixture readiness. A benchmark spec's prose is not executable source
// data or a grant. Missing typed source rows and branch/effect scripts must be blocked.
import { createHash } from 'node:crypto';
import { loadNativeSuite } from './waldo-native-suite';
import type { WorldFixture } from '../scenarios/isolated-source-world';
import { FixtureAuthorityClock } from './fixture-authority';

export type NativeManifest = Readonly<{
  case_id: string;
  candidate_owner: string;
  control_owner: string;
  visible_prompt: string;
  world: WorldFixture;
  grants: readonly Readonly<{ owner_id: string; purpose: string; scope: string; effective_at: string; expires_at: string }> [];
  branches: readonly Readonly<{ id: string; trigger_at: string; owner_id: string; permitted_effects: readonly string[] }> [];
  supported_tools: readonly string[];
  source_digest: string;
}>;
export type ManifestCheck = Readonly<{status: 'ready_for_isolated_trial' | 'blocked_fixture'; missing: readonly string[]}>;
const requiredSources: Readonly<Record<string, readonly string[]>> = {
  W01: ['calendar'], W02: ['calendar','files'], W04: ['mail','files'], W20: ['mail'], W23: ['calendar','priorities'],
  R25: ['project_a','messages'], R27: ['mail'], R28: ['cart'], R33: ['tariff','research_sources'], R35: ['refund'],
};
const requiredBranches = new Set(['W01','W20','W22','W24','R33']);
const canonical = (value: unknown): string => JSON.stringify(value);
export const inspectNativeManifest = (manifest: NativeManifest): ManifestCheck => {
  const spec = loadNativeSuite().find((item) => item.id === manifest.case_id);
  if (!spec) return { status:'blocked_fixture', missing:['unknown native case'] };
  const missing: string[] = [];
  if (!manifest.candidate_owner || !manifest.control_owner || manifest.candidate_owner === manifest.control_owner ||
    manifest.world.owners.length !== 2 || !manifest.world.owners.some((row) => row.id === manifest.candidate_owner) ||
    !manifest.world.owners.some((row) => row.id === manifest.control_owner)) missing.push('two distinct owner stores');
  if (manifest.visible_prompt !== spec.user_prompt) missing.push('visible owner prompt diverges from pinned case');
  if (manifest.world.clock !== spec.fixture.now || !Number.isFinite(Date.parse(manifest.world.clock))) missing.push('fixture clock diverges from pinned case');
  if (manifest.world.owners.length !== 2 || new Set(manifest.world.owners.map((owner) => owner.id)).size !== 2) missing.push('duplicate fixture owner');
  for (const [source, rows] of Object.entries(manifest.world.sources)) {
    if (rows.some((row) => !manifest.world.owners.some((owner) => owner.id === row.owner_id) || !row.id) ||
      new Set(rows.map((row) => `${row.owner_id}:${row.id}`)).size !== rows.length) missing.push(`invalid ${source} identity`);
  }
  for (const source of requiredSources[spec.id] ?? []) {
    const rows = manifest.world.sources[source];
    if (!rows?.some((row) => row.owner_id === manifest.candidate_owner && row.id)) missing.push(`missing candidate-owner ${source} rows`);
  }
  if (!manifest.grants.some((grant) => grant.owner_id === manifest.candidate_owner && grant.purpose && grant.scope &&
    Date.parse(grant.effective_at) <= Date.parse(manifest.world.clock) && Date.parse(grant.expires_at) > Date.parse(manifest.world.clock)))
    missing.push('current typed synthetic grant');
  try { new FixtureAuthorityClock(manifest); }
  catch { missing.push('invalid synthetic authority clock or owner scope'); }
  if (requiredBranches.has(spec.id) && !manifest.branches.some((branch) => branch.id && branch.owner_id === manifest.candidate_owner &&
    Number.isFinite(Date.parse(branch.trigger_at)) && Date.parse(branch.trigger_at) >= Date.parse(manifest.world.clock) &&
    manifest.grants.some((grant) => grant.owner_id === manifest.candidate_owner && Date.parse(grant.effective_at) <= Date.parse(branch.trigger_at) &&
      Date.parse(branch.trigger_at) < Date.parse(grant.expires_at)))) missing.push('typed owner branch under current grant');
  if (!manifest.supported_tools.length) missing.push('supported tool inventory');
  if (manifest.source_digest !== `sha256:${createHash('sha256').update(canonical(manifest.world.sources)).digest('hex')}`)
    missing.push('source manifest digest mismatch');
  if (spec.id === 'R33') missing.push('R33 tariff table, research question, source snapshots and deterministic error schedule not pinned');
  return { status:missing.length ? 'blocked_fixture':'ready_for_isolated_trial', missing };
};
