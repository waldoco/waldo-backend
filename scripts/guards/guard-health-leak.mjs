#!/usr/bin/env node
// guard-health-leak — Waldo backend CI wall.
// Flags raw physiological values assigned, logged, prompt-interpolated, or used as
// metric labels in non-test code. Health values (HRV, HR, SpO2, sleep hours, weight,
// blood pressure, calorie burn, derived zone indicators) belong only in RLS-protected
// Postgres or device SQLCipher — never in agent_logs, DO SQLite, R2, LLM prompts,
// application logs, OTel spans, Sentry breadcrumbs, traces, or eval fixtures.
// Stable string IDs (zone=peak) are permitted; a health-variable name paired with a
// raw numeric literal, or logged/interpolated/metric-labelled, is not.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const NAME = 'guard-health-leak';
// block: a raw-health finding fails the CI wall — an Art-9 leak into agent_logs / DO SQLite / R2 /
// prompts / traces is a high-cost violation. The detectors are bounded (a health token paired with a
// raw number in an assignment / label / template / log-sink position; tests, guards, and non-code
// files are skipped), and the tree is clean, so the wall blocks without false positives.
export const DISPOSITION = 'block';

const REPO_ROOT = join(process.cwd());
const DEFAULT_ROOTS = ['packages', 'scripts', '.github'];

const SCANNABLE = /\.(m?[jt]sx?|c[jt]s|json|ya?ml|toml|sql)$/;
const TEST_FILE = /(\.|_)(test|spec)\.[^.]+$|(^|[\\/])__tests__[\\/]/;

// Health-variable tokens. Acronyms match on word boundaries so substrings like
// "threshold", "thread", "chrome" (which contain "hr") never match. Multi-word and
// snake/camel forms are covered by the alternation.
const HEALTH_TOKENS = [
  'hrv',
  'heart[_\\s-]?rate[_\\s-]?variability',
  'hr',
  'heart[_\\s-]?rate',
  'resting[_\\s-]?heart[_\\s-]?rate',
  'spo2',
  'blood[_\\s-]?oxygen',
  'sleep[_\\s-]?(?:hours?|duration|minutes?|mins?)',
  'weight',
  'body[_\\s-]?weight',
  'blood[_\\s-]?pressure',
  'systolic',
  'diastolic',
  'calorie[_\\s-]?burn',
  'calories[_\\s-]?burned',
  'active[_\\s-]?energy',
  'hr[_\\s-]?zone',
  'heart[_\\s-]?rate[_\\s-]?zone',
];

// A raw numeric literal: integer or decimal, standalone (not part of an identifier).
const NUM = '(?<![\\w.])\\d+(?:\\.\\d+)?';

// Case-insensitive, word-boundary-anchored health-token alternation.
const TOKEN = `\\b(?:${HEALTH_TOKENS.join('|')})\\b`;

// Detectors. Each returns a human-readable reason when it matches a health token
// paired with a raw number (in assignment/interpolation/label position) or emitted
// through a logging/prompt sink. A stable string label (zone=peak, "high") never
// carries a raw number, so it is not matched.
//
// All detectors run against the WHOLE file text with `g`, not line-by-line: a statement split
// across lines (`hrv =\n  42`) must not escape the scan. Proximity is kept meaningful with
// bounded gap windows instead of same-line anchors.
const DETECTORS = [
  {
    // Assignment / object property to a raw number:  hrv = 42 · sleepHours:\n  7.5 · "spo2": 95
    reason: 'health value assigned to a raw numeric literal',
    re: new RegExp(
      `${TOKEN}\\s*["'\`]?\\s*[:=]\\s*${NUM}`,
      'gi',
    ),
  },
  {
    // Reverse order used in metric-label / tag strings; catches label-style
    // { name: 'hrv', value: 42 } pairs, including across a line break.
    reason: 'health value paired with a raw numeric literal on a label/value pair',
    re: new RegExp(
      `${TOKEN}[\\s\\S]{0,60}?\\bvalue\\b\\s*[:=]\\s*${NUM}`,
      'gi',
    ),
  },
  {
    // Template-string interpolation of a health token with a numeric literal inside the same
    // backtick string, including multi-line templates:  `HR ${88} bpm` · `hrv is\n ${42}`.
    reason: 'health value interpolated with a raw numeric literal in a template string',
    re: new RegExp(
      `\`[^\`]{0,200}?${TOKEN}[^\`]{0,200}?\\$\\{[^}]{0,80}?${NUM}[^}]{0,80}?\\}`,
      'gi',
    ),
  },
  {
    // Logging / prompt / metric-label sink carrying a health token + a raw number in the
    // same call, including a call spread over lines:  console.log(\n 'hrv',\n 42).
    reason: 'health value emitted through a log/prompt/metric sink with a raw numeric literal',
    re: new RegExp(
      `\\b(?:console|log(?:ger)?|info|warn|error|debug|trace|span|breadcrumb|metric|gauge|counter|histogram|label|prompt|append|push|emit)\\b[\\s\\S]{0,160}?${TOKEN}[\\s\\S]{0,80}?${NUM}`,
      'gi',
    ),
  },
];

function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing dir (e.g. .github absent) — skip gracefully
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isSkipped(file) {
  const rel = relative(REPO_ROOT, file);
  const parts = rel.split(sep);
  // Guard sources legitimately carry the forbidden token patterns as detectors.
  if (parts.includes('guards')) return true;
  if (!SCANNABLE.test(file)) return true;
  if (TEST_FILE.test(file)) return true;
  return false;
}

function scanFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const findings = [];
  const seenLines = new Set();
  for (const detector of DETECTORS) {
    for (const m of text.matchAll(detector.re)) {
      const line = text.slice(0, m.index).split('\n').length;
      if (seenLines.has(line)) continue; // one finding per line is enough signal
      seenLines.add(line);
      findings.push({ line, reason: detector.reason });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function main() {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf('--root');
  let roots;
  if (rootIdx !== -1 && argv[rootIdx + 1]) {
    roots = [argv[rootIdx + 1]];
  } else {
    roots = DEFAULT_ROOTS.map((r) => join(REPO_ROOT, r));
  }

  const files = [];
  for (const root of roots) {
    let isDir = false;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      continue; // missing root — skip
    }
    if (isDir) files.push(...listFiles(root));
  }

  const violations = [];
  for (const file of files) {
    if (isSkipped(file)) continue;
    for (const f of scanFile(file)) {
      violations.push(`${relative(REPO_ROOT, file)}:${f.line}: ${f.reason}`);
    }
  }

  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`${v}\n`);
    // Honor the declared disposition: warn prints findings but does not fail the
    // wall (the agreed warn-then-block start); block would fail it.
    process.exit(DISPOSITION === 'block' ? 1 : 0);
  }

  process.stdout.write(`${NAME}: ok\n`);
  process.exit(0);
}

main();
