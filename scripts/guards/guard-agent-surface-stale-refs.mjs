#!/usr/bin/env node
// guard-agent-surface-stale-refs — blocks obsolete operational references in agent-facing guidance.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'guard-agent-surface-stale-refs';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const retiredContractPackage = ['@waldo', 'types'].join('/');

const checks = [
  {
    id: 'missing-docs-context',
    pattern: /Docs\/CONTEXT\.md/,
    message: 'use .claude/rules/INDEX.md, docs/foundation/*, accepted ADRs, or relevant Waldo Brain source pages',
  },
  {
    id: 'missing-docs-adapter-ecosystem',
    pattern: /Docs\/WALDO_ADAPTER_ECOSYSTEM\.md/,
    message: 'use docs/foundation/*, accepted ADRs, and packages/contracts/src/adapters/*',
  },
  {
    id: 'missing-docs-handoffs',
    pattern: /Docs\/handoffs\b/,
    message: 'use the bounded workstream handoff named by the current session entrypoint',
  },
  {
    id: 'missing-foundation-handover',
    pattern: /docs\/foundation\/FOUNDATION-HANDOVER\.md/,
    message: 'use docs/foundation/NEXT-SESSION-PLAN.md and the August architecture lock',
  },
  {
    id: 'superseded-demo-day-anchors',
    pattern: /9 Demo Day backend patterns|4 Demo Day pillars|Morning Wag|Fetch Alert/,
    message: 'use the whole-product Outcome/OpenLoop architecture and current capability matrix',
  },
  {
    id: 'retired-rule-file',
    pattern: /\.claude\/rules\/(?:architecture|coding-standards|phase-orchestration)\.md/,
    message: 'use .claude/rules/INDEX.md and the six mirrored universal rule files',
  },
  {
    id: 'retired-contract-package',
    pattern: new RegExp(`${retiredContractPackage.replace('/', '\\/')}(?:\\/|\\b)`),
    message: 'use local packages/contracts workspace modules',
  },
  {
    id: 'retired-contract-path',
    pattern: /\.\.\/waldo-types\b|\bwaldo-types\b/,
    message: 'use local packages/contracts workspace modules',
  },
  {
    id: 'retired-check-command',
    pattern: /\bnpm run check\b/,
    message: 'use npx -y pnpm@10.34.4 verify plus git diff --check',
  },
  {
    id: 'retired-worker-path',
    pattern: /cloudflare\/waldo-worker/,
    message: 'use current packages/runtime Worker and Durable Object paths',
  },
  {
    id: 'legacy-adapter-runtime-tree',
    pattern: /(^|[^A-Za-z0-9_/-])src\/adapters(?:\/|\*|\b)/,
    message: 'use packages/contracts/src/adapters/* for adapter contracts',
    allowLine: (line) => line.includes('packages/contracts/src/adapters'),
  },
  {
    id: 'raw-eval-suite-path',
    pattern: /tools\/eval\/run-suite\.ts/,
    message: 'only /run-eval may probe the future eval suite path; other skills should call /run-eval',
    allowFile: (file) => file.endsWith('.claude/skills/run-eval/SKILL.md') || file.endsWith('.agents/skills/run-eval/SKILL.md'),
  },
];

const roots = [
  'README.md',
  '.claude/skills',
  '.agents/skills',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/foundation/NEXT-SESSION-PLAN.md',
  'docs/foundation/CONTRIBUTOR-ONBOARDING.md',
  'docs/foundation/AGENT-OPERATING-WORKFLOW.md',
  'docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md',
  'docs/planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md',
  'docs/planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md',
];

const scannedExt = new Set(['.md', '.yaml', '.yml', '.json']);

function* walk(path) {
  if (!existsSync(path)) return;
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && scannedExt.has(extname(entry.name))) {
      yield full;
    }
  }
}

function filesForRoot(root) {
  const full = join(repoRoot, root);
  if (!existsSync(full)) return [];
  const statEntries = readdirSync(dirname(full), { withFileTypes: true });
  const entry = statEntries.find((item) => item.name === full.split('/').at(-1));
  if (!entry) return [];
  if (entry.isFile()) return [full];
  return [...walk(full)];
}

const violations = [];

for (const root of roots) {
  for (const file of filesForRoot(root)) {
    const rel = relative(repoRoot, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const check of checks) {
        if (!check.pattern.test(line)) continue;
        if (check.allowFile?.(rel)) continue;
        if (check.allowLine?.(line)) continue;
        violations.push({
          file: rel,
          line: index + 1,
          id: check.id,
          message: check.message,
        });
      }
    });
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}: ${violation.id} — ${violation.message}\n`,
    );
  }
  process.exit(1);
}

process.stdout.write(`${NAME}: ok\n`);
