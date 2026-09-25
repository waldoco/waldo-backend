// assert-canonical-migration-history.sql drifted from verify-supabase-migrations.mjs twice after the
// drift bug was already logged (bug log 2026-09-25): the mjs file-list check runs in gates.sh but the
// SQL fixture only runs Mac-side against a live-local database, so fixture drift is invisible in the
// sandbox gates. The two canonical lists must name the same migration versions; compare them here so
// drift fails before push, not on the Mac.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'guard-migration-fixture-sync';
const root = new URL('../../', import.meta.url);
const mjs = readFileSync(fileURLToPath(new URL('scripts/verify-supabase-migrations.mjs', root)), 'utf8');
const fixture = readFileSync(fileURLToPath(new URL('supabase/fixtures/assert-canonical-migration-history.sql', root)), 'utf8');

const mjsVersions = [...mjs.matchAll(/'(\d{14})_[^']+\.sql'/g)].map((match) => match[1]).sort();
const fixtureVersions = [...fixture.matchAll(/'(\d{14})'/g)].map((match) => match[1]).sort();

const problems = [];
if (mjsVersions.length === 0) problems.push('no migration versions parsed from verify-supabase-migrations.mjs');
if (fixtureVersions.length === 0) problems.push('no migration versions parsed from assert-canonical-migration-history.sql');
if (JSON.stringify(mjsVersions) !== JSON.stringify(fixtureVersions)) {
  problems.push(`canonical lists diverged: only in mjs [${mjsVersions.filter((v) => !fixtureVersions.includes(v))}], only in fixture [${fixtureVersions.filter((v) => !mjsVersions.includes(v))}]`);
}

if (problems.length > 0) {
  process.stderr.write(`${NAME}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`${NAME}: ok (${mjsVersions.length} migrations in sync)`);
