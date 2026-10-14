#!/usr/bin/env node
// Guard: every wake the owner object keeps is a persisted due key the alarm arbiter reads.
// The owner object has one alarm slot (ADR-0065). rearmSharedAlarm arms the earliest of the due keys listed in
// WAKE_DUE_KEYS (packages/runtime/src/scheduler/alarm-slot.ts); a wake armed without a listed key is dropped by the
// next re-arm, which is how a missed brief after an app message happened before. Two findings:
//   1. a `*_due_vN` key written in the runtime but missing from WAKE_DUE_KEYS;
//   2. a runtime file that calls armAlarm but names no listed key, so its wake is not one the arbiter reads.
// Durable Objects with their own alarm slot are outside the owner object's arbiter and are listed below.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

export const DISPOSITION = 'block';
const NAME = 'guard-wake-due-keys';
const RUNTIME_SRC = ['packages', 'runtime', 'src'];
const ALARM_SLOT = 'scheduler/alarm-slot.ts';
// Each of these files is its own Durable Object (or a test probe) with its own alarm slot.
const OTHER_ALARM_OWNERS = new Set(['channels/imessage/bridge-do.ts', 'devices/device-bridge-do.ts', 'index.ts']);
const DUE_KEY = /'([a-z0-9_]+_due_v\d+)'/g;
const CONST_STRING = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'/g;
const ARMS = /\barmAlarm\s*\(/;

const root = (() => {
  const i = process.argv.indexOf('--root');
  return i === -1 ? fileURLToPath(new URL('../../', import.meta.url)) : process.argv[i + 1];
})();
const srcRoot = join(root, ...RUNTIME_SRC);

const walk = (dir, files = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, files); }
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
};

let slot;
try { slot = readFileSync(join(srcRoot, ALARM_SLOT), 'utf8'); } catch {
  process.stderr.write(`${NAME}: ${ALARM_SLOT} is missing under ${srcRoot}\n`);
  process.exit(1);
}
const files = walk(srcRoot).map(file => ({ rel: relative(srcRoot, file).split(sep).join('/'), text: readFileSync(file, 'utf8') }));

// Constant names resolve to their string values anywhere in the runtime, so a list entry or a lane may name a key either way.
const constants = new Map();
for (const { text } of files) for (const [, name, value] of text.matchAll(CONST_STRING)) constants.set(name, value);

const declared = /export\s+const\s+WAKE_DUE_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(slot);
if (!declared) {
  process.stderr.write(`${NAME}: ${ALARM_SLOT} does not export the WAKE_DUE_KEYS list\n`);
  process.exit(1);
}
const listed = new Set();
const listedNames = new Set();
for (const token of declared[1].split(',').map(part => part.trim()).filter(Boolean)) {
  const literal = /^'([^']*)'$/.exec(token);
  if (literal) { listed.add(literal[1]); continue; }
  const value = constants.get(token);
  if (value === undefined) {
    process.stderr.write(`${NAME}: WAKE_DUE_KEYS entry ${token} does not resolve to a string constant\n`);
    process.exit(1);
  }
  listed.add(value);
  listedNames.add(token);
}
for (const [name, value] of constants) if (listed.has(value)) listedNames.add(name);

const findings = [];
for (const { rel, text } of files) {
  if (OTHER_ALARM_OWNERS.has(rel)) continue;
  for (const [, key] of text.matchAll(DUE_KEY)) {
    if (!listed.has(key)) findings.push(`packages/runtime/src/${rel}: due key '${key}' is written but WAKE_DUE_KEYS does not list it, so the arbiter never arms it`);
  }
  if (rel === ALARM_SLOT || !ARMS.test(text)) continue;
  const names = [...listed].some(key => text.includes(`'${key}'`)) || [...listedNames].some(name => new RegExp(`\\b${name}\\b`).test(text));
  if (!names) findings.push(`packages/runtime/src/${rel}: arms the owner alarm without naming a WAKE_DUE_KEYS key, so the next re-arm drops its wake`);
}

if (findings.length) {
  for (const finding of [...new Set(findings)]) process.stderr.write(`${finding}\n`);
  process.exit(DISPOSITION === 'block' ? 1 : 0);
}
process.stdout.write(`${NAME}: ok (${listed.size} wake keys)\n`);
