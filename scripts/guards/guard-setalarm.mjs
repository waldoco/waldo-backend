#!/usr/bin/env node
// Guard: ban direct Durable Object alarm registration outside the alarm-slot seam.
// Grounding: ADR-0065 (DO alarm multiplexer — single alarm slot). A DO has one
// alarm slot; scattered setAlarm calls silently overwrite each other. All alarm
// registration MUST flow through the reserved alarm-slot seam so occurrence-key
// idempotency, DST/jitter, and liveness tracking have a single enforcement point.
// The seam is the single file packages/runtime/src/scheduler/alarm-slot.ts, which
// owns the one raw setAlarm call; any direct setAlarm call elsewhere is a violation.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

export const DISPOSITION = 'block';

const NAME = 'guard-setalarm';

// Matches `.setAlarm(` on any receiver expression, tolerant of whitespace
// between the member access, the name, and the opening paren. The leading dot is
// the discriminator: `storage.setAlarm`, `state.storage.setAlarm`, and any other
// receiver all fall out of a single pattern.
const SETALARM = /\.\s*setAlarm\s*\(/;

// Directories never walked, matched as exact path segments.
const SKIP_DIRS = new Set(['node_modules', '.git']);

// This guard's own source contains the literal pattern text in a doc comment, so
// its home is exempt to avoid self-flagging. Matched as consecutive path segments
// (not substring) so a fixture dir literally named "guard-setalarm" is not
// accidentally exempted.
const GUARD_HOME_SEGMENTS = ['scripts', 'guards'];

// The single alarm-slot seam is the sole file allowed to call setAlarm directly.
// Matched by EXACT full-segment equality — not a directory glob and not a segment
// run — so a spoofed path (a fixture dir named "scheduler", a nested alarm-slot.ts,
// or extra leading segments) cannot inherit the exemption. A whole-dir exemption
// would be attacker-spoofable, which the attack pass proved; exact-path equality
// closes that hole.
const ALARM_SLOT_SEGMENTS = ['packages', 'runtime', 'src', 'scheduler', 'alarm-slot.ts'];

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

function parseRoot(argv) {
  const i = argv.indexOf('--root');
  if (i !== -1) {
    const value = argv[i + 1];
    if (!value) {
      process.stderr.write(`${NAME}: --root requires a directory argument\n`);
      process.exit(2);
    }
    return { root: value, roots: [value] };
  }
  // Guard lives at <repo>/scripts/guards/<name>.mjs — repo root is two levels up.
  // Derived from import.meta.url so the scan targets this repo regardless of cwd.
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  return {
    root: repoRoot,
    roots: [join(repoRoot, 'packages'), join(repoRoot, 'scripts'), join(repoRoot, '.github')],
  };
}

function segmentsOf(relativePath) {
  return relativePath.split(sep).filter(Boolean);
}

function containsSegmentRun(segments, run) {
  for (let i = 0; i + run.length <= segments.length; i++) {
    let match = true;
    for (let j = 0; j < run.length; j++) {
      if (segments[i + j] !== run[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function segmentsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isExempt(relativePath) {
  const segments = segmentsOf(relativePath);
  return (
    containsSegmentRun(segments, GUARD_HOME_SEGMENTS) ||
    segmentsEqual(segments, ALARM_SLOT_SEGMENTS)
  );
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return; // scan root may be absent (e.g. no .github)
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, files);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(extensionOf(entry.name))) {
      files.push(full);
    }
  }
}

function collectFiles(roots) {
  const files = [];
  for (const root of roots) {
    let stat;
    try {
      stat = statSync(root);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isDirectory()) walk(root, files);
    else if (stat.isFile() && SCANNED_EXTENSIONS.has(extensionOf(root))) files.push(root);
  }
  return files;
}

function main() {
  const { root, roots } = parseRoot(process.argv.slice(2));
  const files = collectFiles(roots);
  const findings = [];

  for (const file of files) {
    const rel = relative(root, file) || file;
    if (isExempt(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let n = 0; n < lines.length; n++) {
      if (SETALARM.test(lines[n])) {
        findings.push(
          `${rel}:${n + 1}: direct setAlarm call is banned outside the alarm-slot seam ` +
            `(packages/runtime/src/scheduler/alarm-slot.ts); all DO alarm registration must ` +
            `flow through that seam (ADR-0065, one-alarm-slot).`,
        );
      }
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    process.exit(DISPOSITION === 'block' ? 1 : 0);
  }

  process.stdout.write(`${NAME}: ok\n`);
  process.exit(0);
}

main();
