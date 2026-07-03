#!/usr/bin/env node
// guard-adr-status — CI wall guard.
//
// Grounding: adr-lint asserts that code satisfies the ADRs it cites. An ADR
// citation whose recorded status is not accepted/active signals unresolved
// design work and creates false architecture confidence.
//
// Catch rule: any reference of the form ADR-NNNN in CODE under packages/ or
// scripts/ whose status in the committed snapshot at
// docs/foundation/accepted-adrs.json is neither "accepted" nor "active".
// Scope is code-only by design: ADR-0053 targets *code* citing a non-live ADR.
// Prose docs (foundation plans, this repo's own reports) legitimately discuss
// superseded/proposed ADRs as history and must not be flagged.
//
// Resolution is snapshot-driven and lenient by design:
//   - no snapshot committed        -> nothing to resolve against -> clean
//   - reference absent from snapshot -> a dead-link, owned by a separate check
//   - reference present, bad status -> violation
// The snapshot is the single source of truth for ADR status during the build.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DISPOSITION = "block";

const NAME = "guard-adr-status";
const SCAN_DIRS = ["packages", "scripts"];
const SNAPSHOT_REL = join("docs", "foundation", "accepted-adrs.json");
const LIVE_STATUSES = new Set(["accepted", "active"]);
const ADR_REF = /ADR-\d{4}/g;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
// Reading text as UTF-8 is safe for the scan set; the snapshot is JSON and the
// code/doc tree is source. Only .json/.ts/.tsx/.js/.mjs/.md-style text matters,
// but we scan all regular files uniformly and let the regex find nothing in
// anything without a citation.

function parseRootArg(argv) {
  const i = argv.indexOf("--root");
  if (i === -1) return process.cwd();
  const value = argv[i + 1];
  if (!value) {
    process.stderr.write(`${NAME}: --root requires a directory\n`);
    process.exit(1);
  }
  return value;
}

// number -> status, lowercased. Missing/unreadable snapshot yields an empty map
// (lenient: nothing resolves, nothing flags).
function loadStatusIndex(root) {
  const path = join(root, SNAPSHOT_REL);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`${relative(root, path) || SNAPSHOT_REL}: unparseable ADR snapshot JSON\n`);
    process.exit(1);
  }
  const index = new Map();
  // Only record entries with a known lifecycle status. A malformed source entry
  // (status "unknown", or an id that is really a date like 2026) must never
  // become an authoritative key that could false-flag code — treat it as absent.
  const KNOWN = new Set(["accepted", "active", "proposed", "superseded", "rejected", "deprecated"]);
  const record = (numberLike, status) => {
    if (typeof status !== "string") return;
    const s = status.toLowerCase();
    if (!KNOWN.has(s)) return;
    const n = String(numberLike).match(/\d{4}/)?.[0];
    if (n) index.set(`ADR-${n}`, s);
  };
  // Tolerate both shapes: array of entries, or object keyed by ADR id/number.
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === "object") record(entry.number ?? entry.id ?? entry.adr, entry.status);
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === "object") record(key, value.status);
      else record(key, value);
    }
  }
  return index;
}

function* walk(dir, snapshotAbs) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // absent scan dir is not an error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, snapshotAbs);
    } else if (entry.isFile()) {
      if (full === snapshotAbs) continue; // the snapshot's own keys aren't citations
      yield full;
    }
  }
}

function scanFile(file, index, root, findings) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!text.includes("ADR-")) return;
  const rel = relative(root, file) || file;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(ADR_REF);
    if (!matches) continue;
    for (const ref of new Set(matches)) {
      const status = index.get(ref);
      if (status === undefined) continue; // absent = dead-link, not this guard's job
      if (LIVE_STATUSES.has(status)) continue;
      findings.push(`${rel}:${i + 1}: ${ref} status is "${status}" (not accepted/active) — code must not cite non-live ADRs`);
    }
  }
}

function main() {
  const root = parseRootArg(process.argv.slice(2));
  const index = loadStatusIndex(root);
  if (index === null || index.size === 0) {
    // No snapshot (or empty): no status resolves, nothing to flag. Clean.
    process.stdout.write(`${NAME}: ok\n`);
    process.exit(0);
  }
  const snapshotAbs = join(root, SNAPSHOT_REL);
  const findings = [];
  for (const relDir of SCAN_DIRS) {
    const abs = join(root, relDir);
    let ok = true;
    try {
      ok = statSync(abs).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) continue;
    for (const file of walk(abs, snapshotAbs)) scanFile(file, index, root, findings);
  }
  if (findings.length > 0) {
    findings.sort();
    process.stderr.write(findings.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(`${NAME}: ok\n`);
  process.exit(0);
}

main();
