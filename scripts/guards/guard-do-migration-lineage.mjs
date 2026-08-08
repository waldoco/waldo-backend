#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DISPOSITION = 'block';

const NAME = 'guard-do-migration-lineage';
const SOURCE_PATH = 'packages/runtime/src/do-schema.ts';
const RESERVATION_PATH = 'packages/runtime/do-migration-reservations.json';
const ALLOCATION_POLICY = 'rebase_then_append';

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index === -1) return fileURLToPath(new URL('../../', import.meta.url));
  const value = argv[index + 1];
  if (!value) {
    process.stderr.write(`${NAME}: --root requires a directory argument\n`);
    process.exit(2);
  }
  return resolve(value);
}

function readRequired(root, path) {
  const absolutePath = resolve(root, path);
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stderr.write(`${path}: required by ${NAME}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function parseSource(source, findings) {
  const declarations = new Map();
  const declarationPattern =
    /export const\s+([A-Z0-9_]+)\s*:\s*DoMigration\s*=\s*\{\s*version:\s*(\d+)\s*,\s*name:\s*'([^']+)'\s*,/g;

  for (const match of source.matchAll(declarationPattern)) {
    const [, symbol, versionText, name] = match;
    declarations.set(symbol, { version: Number(versionText), name });
  }

  const chainMatch =
    /export const DO_SCHEMA_MIGRATIONS\s*=\s*\[([\s\S]*?)\]\s*as const;/.exec(source);
  if (!chainMatch) {
    findings.push(`${SOURCE_PATH}: cannot parse DO_SCHEMA_MIGRATIONS`);
    return [];
  }

  const symbols = chainMatch[1]
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const seenSymbols = new Set();
  const migrations = [];

  for (const symbol of symbols) {
    if (seenSymbols.has(symbol)) {
      findings.push(`${SOURCE_PATH}: ${symbol} appears more than once in DO_SCHEMA_MIGRATIONS`);
      continue;
    }
    seenSymbols.add(symbol);
    const migration = declarations.get(symbol);
    if (!migration) {
      findings.push(`${SOURCE_PATH}: ${symbol} has no parseable DoMigration declaration`);
      continue;
    }
    migrations.push(migration);
  }

  for (const symbol of declarations.keys()) {
    if (!seenSymbols.has(symbol)) {
      findings.push(`${SOURCE_PATH}: ${symbol} is declared but absent from DO_SCHEMA_MIGRATIONS`);
    }
  }

  return migrations;
}

function parseReservations(raw, findings) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    findings.push(`${RESERVATION_PATH}: invalid JSON`);
    return [];
  }

  if (parsed?.allocation !== ALLOCATION_POLICY) {
    findings.push(
      `${RESERVATION_PATH}: allocation must be ${JSON.stringify(ALLOCATION_POLICY)}`,
    );
  }
  if (!Array.isArray(parsed?.migrations)) {
    findings.push(`${RESERVATION_PATH}: migrations must be an array`);
    return [];
  }

  return parsed.migrations.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !Number.isInteger(entry.version) ||
      typeof entry.name !== 'string'
    ) {
      findings.push(`${RESERVATION_PATH}: migration ${index + 1} is malformed`);
      return { version: Number.NaN, name: '' };
    }
    return { version: entry.version, name: entry.name };
  });
}

function validateSequence(migrations, path, findings) {
  const seenVersions = new Set();
  const seenNames = new Set();

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (seenVersions.has(migration.version)) {
      findings.push(`${path}: migration version ${migration.version} is duplicated`);
    }
    if (seenNames.has(migration.name)) {
      findings.push(`${path}: migration name ${JSON.stringify(migration.name)} is duplicated`);
    }
    if (migration.version !== expectedVersion) {
      findings.push(
        `${path}: migration ${JSON.stringify(migration.name)} has version ${migration.version}; ` +
          `rebase onto current main and reserve version ${expectedVersion}`,
      );
    }
    if (migration.name.length === 0) {
      findings.push(`${path}: migration ${expectedVersion} has an empty name`);
    }
    seenVersions.add(migration.version);
    seenNames.add(migration.name);
  }
}

function compareReservations(sourceMigrations, reservations, findings) {
  const count = Math.max(sourceMigrations.length, reservations.length);
  for (let index = 0; index < count; index += 1) {
    const source = sourceMigrations[index];
    const reservation = reservations[index];
    if (!reservation && source) {
      findings.push(
        `${SOURCE_PATH}: migration ${source.version} ${JSON.stringify(source.name)} is unreserved`,
      );
      continue;
    }
    if (!source && reservation) {
      findings.push(
        `${RESERVATION_PATH}: reservation ${reservation.version} ${JSON.stringify(reservation.name)} has no migration`,
      );
      continue;
    }
    if (source.version !== reservation.version || source.name !== reservation.name) {
      findings.push(
        `${SOURCE_PATH}: migration ${source.version} ${JSON.stringify(source.name)} does not match ` +
          `reservation ${reservation.version} ${JSON.stringify(reservation.name)}`,
      );
    }
  }
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const findings = [];
  const sourceMigrations = parseSource(readRequired(root, SOURCE_PATH), findings);
  const reservations = parseReservations(readRequired(root, RESERVATION_PATH), findings);

  validateSequence(sourceMigrations, SOURCE_PATH, findings);
  validateSequence(reservations, RESERVATION_PATH, findings);
  compareReservations(sourceMigrations, reservations, findings);

  if (findings.length > 0) {
    process.stderr.write(`${[...new Set(findings)].sort().join('\n')}\n`);
    process.exit(1);
  }

  process.stdout.write(`${NAME}: ok (${reservations.length} reserved migrations)\n`);
}

main();
