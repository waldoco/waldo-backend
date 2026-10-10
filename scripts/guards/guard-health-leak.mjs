#!/usr/bin/env node
// guard-health-leak — Waldo backend CI wall.
// Flags raw physiological values assigned, logged, prompt-interpolated, or used as
// metric labels in non-test code. Health values (HRV, HR, SpO2, sleep hours, weight,
// blood pressure, calorie burn, derived zone indicators) belong only in RLS-protected
// Postgres or explicitly consented volatile model/owner delivery — never in agent_logs, DO SQLite, R2,
// application logs, OTel spans, Sentry breadcrumbs, traces, or eval fixtures.
// Stable string IDs (zone=peak) are permitted; a health-variable name paired with a
// raw numeric literal, or logged/interpolated/metric-labelled, is not.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
// Reuse the repository's pinned compiler; missing dependencies fail the guard.
const ts = createRequire(new URL('../../packages/runtime/package.json', import.meta.url))('typescript');

const NAME = 'guard-health-leak';
// block: a raw-health finding fails the CI wall — an Art-9 leak into agent_logs / DO SQLite / R2 /
// ordinary persistence / traces is a high-cost violation. The detectors are bounded (a health token paired with a
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
  'bp[_\\s-]?sys(?:tolic)?',
  'bp[_\\s-]?dia(?:stolic)?',
  'systolic',
  'diastolic',
  'calorie[_\\s-]?burn',
  'calories[_\\s-]?burned',
  'active[_\\s-]?energy',
  'hr[_\\s-]?zone',
  'heart[_\\s-]?rate[_\\s-]?zone',
];

// A raw numeric literal: integer or decimal, standalone (not part of an identifier).
const NUM = '(?<![\\w.])[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';

// Bare `bp` is ambiguous with basis points, so it is not in HEALTH_TOKENS. It only trips on
// blood-pressure-shaped values: a systolic/diastolic ratio or an mmHg unit.
const BP_VALUE = `${NUM}\\s*\\/\\s*${NUM}|${NUM}\\s*mmhg\\b`;

// Units that appear glued to a key as a suffix (hrv_ms, weight_kg, systolicMmHg). Mirrors the
// sanitiser RAW_SENSOR vocabulary so committed code carrying a unit-suffixed health key is caught.
const UNIT = 'ms|millisec|bpm|beats|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|percent|pct|hours?|hrs?|mins?|minutes?';

// Case-insensitive health-token alternation with an OPTIONAL glued unit suffix, so a snake/camelCase
// key like `hrv_ms` / `weightKg` is matched. The trailing \b is dropped because the detector's
// separator (or unit) follows the token; a bounded unit list keeps the suffix from over-consuming.
const TOKEN = `\\b(?:${HEALTH_TOKENS.join('|')})(?:[_\\s-]?(?:${UNIT}))?`;

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
    // Bare BP abbreviation: catch blood-pressure-shaped values without turning basis-points deltas
    // (`bp: 3`) into CI noise.
    reason: 'blood pressure value assigned to a raw numeric literal',
    re: new RegExp(
      `\\bbp\\s*["'\`]?\\s*[:=]\\s*["'\`]?\\s*(?:${BP_VALUE})`,
      'gi',
    ),
  },
  {
    // Assignment / object property to a raw number, incl. QUOTED values (`hrv: "42"`, `"spo2":"96"`)
    // — the optional quote on either side of [:=] catches the serialized-payload shape, not only
    // prose:  hrv = 42 · sleepHours:\n  7.5 · "spo2": 95 · body_weight: "82"
    reason: 'health value assigned to a raw numeric literal',
    re: new RegExp(
      `${TOKEN}\\s*["'\`]?\\s*[:=]\\s*["'\`]?\\s*${NUM}`,
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
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue; // generated bundles are checked at their source
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
  // Build tooling paths can contain 'console', 'hr' and numeric asset hashes; source
  // application code remains scanned, but tooling and generated output do not.
  if (parts.includes('dashboard-app') && parts.includes('scripts')) return true;
  if (!SCANNABLE.test(file)) return true;
  if (TEST_FILE.test(file)) return true;
  return false;
}

const HEALTH_NAME = new RegExp(`^(?:${HEALTH_TOKENS.join('|')})(?:[_\\s-]?(?:${UNIT}))?(?:[_-]?(?:value|reading))?$`, 'i');
const HEALTH_TEXT = new RegExp(TOKEN, 'i');
const RAW_DIGITS = /\d/;
const CANONICAL_HEALTH_METRICS = new Set(['sleep_duration', 'sleep_efficiency', 'overnight_hrv', 'resting_heart_rate', 'sleep_midpoint', 'daylight_duration', 'movement_duration', 'perceived_stress', 'physical_load', 'recovery', 'form', 'sleep_debt']);
const healthLabel = node => ts.isStringLiteral(node) && (HEALTH_TEXT.test(node.text) || CANONICAL_HEALTH_METRICS.has(node.text));
const SINK_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'breadcrumb', 'setAttribute', 'setAttributes', 'addEvent', 'record', 'metric', 'gauge', 'counter', 'histogram', 'label', 'enqueue', 'offload']);
const PERSIST_METHODS = new Set(['put', 'save', 'write', 'append', 'push', 'emit']);
const PERSIST_RECEIVER = /(?:storage|outbox|journal|audit|checkpoint|ledger|trace|logger|analytics|telemetry|bucket|r2|offload)/i;
const metadataNames = new Set(['count', 'bytes', 'ms', 'epoch', 'version', 'attempt', 'offset', 'sequence', 'sample_count']);
export function scanSource(text, file = 'fixture.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [], seenLines = new Set();
  const add = (position, reason) => { const line = source.getLineAndCharacterOfPosition(position).line + 1; if (!seenLines.has(line)) { seenLines.add(line); findings.push({ line, reason }); } };
  // Only this reviewed coefficient declaration is dimensionless math. Other
  // assignments and every sink inside the same source remain scanned.
  const coefficientRanges = [];
  const catalog = relative(REPO_ROOT, file).split(sep).join('/') === 'packages/runtime/src/health/calculations.ts';
  const visitCatalog = node => {
    if (catalog && ts.isVariableDeclaration(node) && node.name.getText(source) === 'CANDIDATE_WEIGHTS' && node.initializer) {
      let valid = true;
      const check = value => { if (ts.isNumericLiteral(value) && !(Number(value.text) >= 0 && Number(value.text) <= 1)) valid = false; if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) valid = false; ts.forEachChild(value, check); };
      check(node.initializer); if (valid) coefficientRanges.push([node.initializer.getStart(source), node.initializer.end]);
    }
    ts.forEachChild(node, visitCatalog);
  };
  visitCatalog(source);
  for (const detector of DETECTORS) for (const match of text.matchAll(detector.re)) {
    if (coefficientRanges.some(([from, to]) => match.index >= from && match.index < to)) continue;
    add(match.index, detector.reason);
  }
  const numeric = node => ts.isNumericLiteral(node) || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));
  const rawArgument = node => {
    if (ts.isIdentifier(node)) return HEALTH_NAME.test(node.text);
    if (ts.isPropertyAccessExpression(node) && HEALTH_NAME.test(node.name.text)) return true;
    if (ts.isTemplateExpression(node) && HEALTH_TEXT.test(node.getText(source))) return true;
    if (ts.isStringLiteral(node)) return HEALTH_TEXT.test(node.text) && RAW_DIGITS.test(node.text);
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      if (props.some(prop => HEALTH_NAME.test(prop.name.getText(source).replace(/["']/g, '')) && !(ts.isStringLiteral(prop.initializer) && !RAW_DIGITS.test(prop.initializer.text)))) return true;
      const hasHealthLabel = props.some(prop => ['name', 'metric', 'label'].includes(prop.name.getText(source).replace(/["']/g, '')) && healthLabel(prop.initializer));
      if (hasHealthLabel && props.some(prop => prop.name.getText(source).replace(/["']/g, '') === 'value')) return true;
      return props.some(prop => !metadataNames.has(prop.name.getText(source).replace(/["']/g, '')) && rawArgument(prop.initializer));
    }
    let raw = false; ts.forEachChild(node, child => { raw ||= rawArgument(child); }); return raw;
  };
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : '';
      const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText(source) : '';
      const sink = SINK_METHODS.has(method) || (PERSIST_METHODS.has(method) && PERSIST_RECEIVER.test(receiver));
      const label = node.arguments.some(healthLabel);
      if (sink && (node.arguments.some(rawArgument) || (label && node.arguments.some(arg => numeric(arg) || ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg) || ts.isCallExpression(arg))))) add(node.getStart(source), 'health value emitted through a logging/telemetry/persistence sink');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings.sort((a, b) => a.line - b.line);
}
function scanFile(file) {
  try { return scanSource(readFileSync(file, 'utf8'), file); } catch (error) { throw new Error(`health guard could not parse ${file}`, { cause: error }); }
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
