import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../skills/', import.meta.url);
const files = readdirSync(root).sort().map(name => `${name}/SKILL.md`);
const output = '// Generated from skills/*/SKILL.md by scripts/bundle-skills.mjs.\nexport const BUNDLED_SKILL_FILES = Object.freeze(' + JSON.stringify(files.map(path => readFileSync(new URL(path, root), 'utf8')), null, 2) + ');\n';
const target = new URL('../src/skills/bundled-text.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('bundled_skill_files_stale');
} else writeFileSync(fileURLToPath(target), output);
