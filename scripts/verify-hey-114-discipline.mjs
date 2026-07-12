import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Keep the migration inventory single-owned by the existing HEY-134 verifier.
run(process.execPath, ['scripts/verify-supabase-migrations.mjs']);

const documentPaths = [
  '../docs/foundation/HEY-114-ENVIRONMENT-MIGRATION-DISCIPLINE.md',
  '../docs/foundation/HEY-114-ARCH-LOCAL-PROOF-INSTRUCTIONS.md',
];
const document = documentPaths
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
const normalizedDocument = document.toLowerCase();

const required = [
  'Arch local',
  'Project Woof',
  'production: unknown',
  'Waldo-MVP',
  'fresh reset',
  'pgTAP',
  'migration-history/idempotency',
  'statement_timeout',
  'GitHub Actions is unavailable',
  'No secrets contract',
  'No staging/prod migration',
  '${SUPABASE[@]}',
  'sanitized, allowlisted evidence summary',
];

for (const phrase of required) {
  if (!normalizedDocument.includes(phrase.toLowerCase())) {
    throw new Error(`HEY-114 discipline is missing required phrase: ${phrase}`);
  }
}

if (/\b13\s+migrations?\b/i.test(document)) {
  throw new Error('HEY-114 discipline must not describe a stale 13-migration chain');
}

const secretPatterns = [
  /postgres(?:ql)?:\/\/[^\s`]+/i,
  /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  /\b(?:SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL)\s*=\s*[^\s`]/,
];

for (const pattern of secretPatterns) {
  if (pattern.test(document)) throw new Error(`HEY-114 discipline contains possible secret material: ${pattern}`);
}

const codeBlocks = [...document.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)].map((match) => match[1]);
for (const block of codeBlocks) {
  if (/^\s*supabase\s+/m.test(block)) {
    throw new Error('HEY-114 runbook commands must use the pinned ${SUPABASE[@]} array, never a bare CLI');
  }
  if (/--linked\b|--db-url\b|\b(?:db push|migration repair|supabase link)\b|\btee\b/i.test(block)) {
    throw new Error('HEY-114 executable blocks must not contain shared-environment or raw-transcript commands');
  }
}

console.log('HEY-114 environment and migration discipline verified (static, no shared-environment access)');
