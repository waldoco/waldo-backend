#!/usr/bin/env node
// Static wall guard: the verify gate is pnpm-version-sensitive (a newer pnpm
// major changes install semantics such as minimumReleaseAge, which fails the
// wall before tests even run). This guard refuses to proceed when the pnpm
// running the gate does not match the pinned major, so a version mismatch fails
// loud and early instead of surfacing as a confusing downstream install error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NAME = "guard-package-manager";
export const DISPOSITION = "block";

// package.json lives two levels up from scripts/guards/. Resolve from this
// file, not process.cwd(), so the guard reads the same pin regardless of where
// the gate is invoked.
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(HERE, "..", "..", "package.json");

function pinnedMajor() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
  const pin = pkg.packageManager; // e.g. "pnpm@10.34.4"
  const match = /^pnpm@(\d+)\./.exec(pin ?? "");
  if (!match) {
    process.stderr.write(`${NAME}: packageManager pin is missing or not pnpm@<version> (got ${JSON.stringify(pin)})\n`);
    process.exit(DISPOSITION === "warn" ? 0 : 1);
  }
  return match[1];
}

// pnpm sets npm_config_user_agent to "pnpm/<version> npm/? node/<v> ...".
// Absent means the guard was invoked directly via node (not under pnpm), so
// there is no running-pnpm major to check — pass with a clear notice.
function runningMajor() {
  const ua = process.env.npm_config_user_agent;
  if (!ua) return null;
  return /pnpm\/(\d+)\./.exec(ua)?.[1] ?? null;
}

const pinned = pinnedMajor();
const running = runningMajor();

if (running === null) {
  process.stdout.write(`${NAME}: ok (not run under pnpm; no version check enforced)\n`);
  process.exit(0);
}

if (running !== pinned) {
  process.stderr.write(
    `${NAME}: pnpm major mismatch — running pnpm ${running}.x but package.json pins pnpm@${pinned}.x. ` +
      `Prefix commands with 'npx -y pnpm@10.34.4 ...' or install the pinned pnpm.\n`,
  );
  process.exit(DISPOSITION === "warn" ? 0 : 1);
}

process.stdout.write(`${NAME}: ok\n`);
process.exit(0);
