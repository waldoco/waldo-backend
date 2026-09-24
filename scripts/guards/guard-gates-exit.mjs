// gates.sh is the pre-push gate. It once printed "GUARDS fail" yet exited 0, so a push went
// out with failing guards (bug log 2026-09-24). Every failed step must fail the run's exit code.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'guard-gates-exit';
const target = process.argv[2] ?? fileURLToPath(new URL('../gates.sh', import.meta.url));
const script = readFileSync(target, 'utf8');
const problems = [];
if (!/set -o pipefail/.test(script)) problems.push('missing pipefail: a piped test run can hide a failure');
for (const branch of script.match(/\|\| \{[^}]*\}/g) ?? []) {
  if (/fail/.test(branch) && !/FAIL=1/.test(branch)) problems.push(`failure branch never fails the run: ${branch.slice(0, 80)}`);
}
if (!/exit \$FAIL/.test(script)) problems.push('script never exits with $FAIL');
if (problems.length > 0) {
  process.stderr.write(`${NAME}: ${target}\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${NAME}: ok\n`);
