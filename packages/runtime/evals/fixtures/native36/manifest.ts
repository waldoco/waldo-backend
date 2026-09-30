import { readFileSync } from 'node:fs';
import { fixtures } from './w01-w06';
import { createTrial } from './adapters';
import { fixtureDigest, validateFixture } from './schema';

export type ManifestEntry = { case_id: string; status: 'ready_fixture' | 'blocked_fixture'; fixture_file: string | null; adapter_file: string | null; fixture_digest: string | null; missing: string[] };
export const manifest = JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8')) as { schema_version: 1; suite_hash: string; baseline_head: string; fixture_base_head: string; readiness_scope: string; cases: ManifestEntry[] };
/** Fixture-only inspection. Does not call or change core readiness, admission or grading. */
export const inspectFixture = (case_id: string): Pick<ManifestEntry,'status' | 'missing'> => {
  const entry = manifest.cases.find(e => e.case_id === case_id);
  const fixture = fixtures.find(f => f.case_id === case_id);
  if (!entry) return { status:'blocked_fixture',missing:['Unknown case'] };
  if (!fixture || entry.status === 'blocked_fixture') return { status:'blocked_fixture',missing:[...entry.missing] };
  const missing: string[] = [];
  try {
    validateFixture(fixture);
    if (entry.fixture_digest !== fixtureDigest(fixture)) missing.push('Fixture digest differs from reviewed manifest');
    if (fixture.suite_hash !== manifest.suite_hash || fixture.baseline_head !== manifest.baseline_head) missing.push('Fixture source pin differs from manifest');
    for (const branch of fixture.branches) {
      const trial = createTrial(case_id,'readiness-check',branch.id);
      const rows = trial.sources.list();
      if (rows.length !== fixture.permitted_source_ids.length) missing.push('Incomplete permitted source adapter');
      for (const row of rows) trial.sources.read(row.id);
      for (const effect of ['calendar','mail','watches','artifacts','project','investment']) trial.readback(effect);
    }
  } catch (cause) { missing.push(cause instanceof Error ? cause.message : 'Invalid typed world or adapter'); }
  return { status:missing.length ? 'blocked_fixture':'ready_fixture',missing };
};
