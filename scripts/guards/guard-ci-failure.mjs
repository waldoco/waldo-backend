// Verification failures must remain failures after YAML keys, aliases and
// expressions have been decoded. Read the document as data, not source text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const target = process.argv[2] ?? fileURLToPath(new URL('../../.github/workflows/verify.yml', import.meta.url));
const problems = [];
try {
  const doc = parseDocument(readFileSync(target, 'utf8'), { uniqueKeys: true, merge: true });
  if (doc.errors.length) throw new Error('invalid YAML');
  const workflow = doc.toJS({ maxAliasCount: 100 });
  if (!workflow || typeof workflow !== 'object' || !workflow.jobs || typeof workflow.jobs !== 'object') throw new Error('missing jobs');
  const seen = new Set();
  const walk = (node, path) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'continue-on-error' && value !== false) problems.push(`${path}.${key} must be literal false or absent`);
      walk(value, `${path}.${key}`);
    }
  };
  walk(workflow.jobs, 'jobs');
} catch {
  // Provider/file text is never needed to explain a malformed guard input.
  problems.push('verification workflow cannot be parsed safely');
}
if (problems.length) {
  process.stderr.write(`guard-ci-failure: ${problems.join('; ')}\n`);
  process.exit(1);
}
process.stdout.write('guard-ci-failure: ok\n');
