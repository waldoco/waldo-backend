// CI is an exit proof, not a best-effort diagnostic. No job or step in the
// verification workflow may turn a nonzero exit into a successful run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] ?? fileURLToPath(new URL('../../.github/workflows/verify.yml', import.meta.url));
const text = readFileSync(target, 'utf8');
const softFailures = text.split('\n').flatMap((line, index) => {
  if (/^\s*#/.test(line) || !line.includes('continue-on-error')) return [];
  // Reject quoted/inline keys and expressions too. Only the canonical literal
  // false form is allowed; unusual syntax must be made explicit before use.
  return /^\s*continue-on-error\s*:\s*false\s*(?:#.*)?$/.test(line) ? [] : [index + 1];
});
if (softFailures.length) {
  process.stderr.write(`guard-ci-failure: ${target}:${softFailures.join(',')} allows a failed verification to report success\n`);
  process.exit(1);
}
process.stdout.write('guard-ci-failure: ok\n');
