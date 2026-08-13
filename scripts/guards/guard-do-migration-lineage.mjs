#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireRuntimeDependency = createRequire(
  new URL('../../packages/runtime/package.json', import.meta.url),
);
const ts = requireRuntimeDependency('typescript');

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

function parseBaseRef(argv) {
  const index = argv.indexOf('--base-ref');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) {
    process.stderr.write(`${NAME}: --base-ref requires a git revision argument\n`);
    process.exit(2);
  }
  return value;
}

function runGit(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function resolveGitRef(root, ref) {
  const result = runGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function requireGitRef(root, ref) {
  const resolved = resolveGitRef(root, ref);
  if (!resolved) {
    process.stderr.write(`${NAME}: migration base ref ${JSON.stringify(ref)} is unavailable\n`);
    process.exit(1);
  }
  return resolved;
}

function requireStrictHistoricalBase(root, baseRef) {
  const head = requireGitRef(root, 'HEAD');
  const ancestor = runGit(root, ['merge-base', '--is-ancestor', baseRef, head]);
  if (baseRef === head || ancestor.status !== 0) {
    process.stderr.write(
      `${NAME}: migration base ${JSON.stringify(baseRef)} must be a strict ancestor of HEAD\n`,
    );
    process.exit(1);
  }
  return baseRef;
}

function resolveBaseRef(root, argv) {
  const explicit = parseBaseRef(argv) ?? process.env.WALDO_DO_MIGRATION_BASE_REF;
  if (explicit) {
    return requireStrictHistoricalBase(root, requireGitRef(root, explicit));
  }

  const githubBase = process.env.GITHUB_BASE_REF;
  if (githubBase) {
    const remoteRef = resolveGitRef(root, `origin/${githubBase}`);
    const localRef = resolveGitRef(root, githubBase);
    if (!remoteRef && !localRef) {
      process.stderr.write(
        `${NAME}: GitHub base ${JSON.stringify(githubBase)} is unavailable; fetch full history\n`,
      );
      process.exit(1);
    }
    return requireStrictHistoricalBase(root, remoteRef ?? localRef);
  }

  const repository = runGit(root, ['rev-parse', '--show-toplevel']);
  if (repository.status !== 0) {
    if (argv.includes('--allow-unversioned-fixture')) return undefined;
    process.stderr.write(
      `${NAME}: migration history is unavailable; unversioned mode is test-only and must be explicit\n`,
    );
    process.exit(1);
  }

  const head = requireGitRef(root, 'HEAD');
  const main = resolveGitRef(root, 'origin/main');
  if (!main) {
    process.stderr.write(
      `${NAME}: set WALDO_DO_MIGRATION_BASE_REF when origin/main is unavailable\n`,
    );
    process.exit(1);
  }
  if (head === main) {
    const parent = resolveGitRef(root, 'HEAD^');
    if (!parent) {
      process.stderr.write(`${NAME}: HEAD has no strict historical migration base\n`);
      process.exit(1);
    }
    return requireStrictHistoricalBase(root, parent);
  }

  const mergeBase = runGit(root, ['merge-base', head, main]);
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    process.stderr.write(`${NAME}: cannot resolve migration merge-base against origin/main\n`);
    process.exit(1);
  }
  return requireStrictHistoricalBase(root, mergeBase.stdout.trim());
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

function readAtRef(root, ref, path) {
  const result = runGit(root, ['show', `${ref}:${path}`]);
  if (result.status !== 0) {
    process.stderr.write(`${path}: cannot read historical migration input at ${ref}\n`);
    process.exit(1);
  }
  return result.stdout;
}

function readOptionalAtRef(root, ref, path) {
  const result = runGit(root, ['show', `${ref}:${path}`]);
  return result.status === 0 ? result.stdout : undefined;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isExportedConst(statement) {
  return (
    ts.isVariableStatement(statement) &&
    (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
  );
}

function isDoMigrationType(type) {
  return (
    type &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === 'DoMigration'
  );
}

function propertyName(property) {
  if (!property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return undefined;
}

function parseMigrationDeclaration(symbol, declaration, findings) {
  if (!declaration.initializer) {
    findings.push(`${SOURCE_PATH}: ${symbol} has no migration initializer`);
    return undefined;
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (!ts.isObjectLiteralExpression(initializer)) {
    findings.push(`${SOURCE_PATH}: ${symbol} migration initializer must be an object literal`);
    return undefined;
  }
  const properties = new Map();
  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      findings.push(`${SOURCE_PATH}: ${symbol} migration properties must be explicit assignments`);
      continue;
    }
    const name = propertyName(property);
    if (!name) {
      findings.push(`${SOURCE_PATH}: ${symbol} migration property names must be static`);
      continue;
    }
    if (properties.has(name)) {
      findings.push(
        `${SOURCE_PATH}: ${symbol} migration property ${JSON.stringify(name)} is duplicated`,
      );
      continue;
    }
    properties.set(name, property.initializer);
  }
  const versionNode = properties.get('version');
  const nameNode = properties.get('name');
  if (!versionNode || !ts.isNumericLiteral(versionNode)) {
    findings.push(`${SOURCE_PATH}: ${symbol} migration version must be an integer literal`);
    return undefined;
  }
  if (!nameNode || !ts.isStringLiteral(nameNode)) {
    findings.push(`${SOURCE_PATH}: ${symbol} migration name must be a string literal`);
    return undefined;
  }
  const version = Number(versionNode.text);
  if (!Number.isSafeInteger(version)) {
    findings.push(`${SOURCE_PATH}: ${symbol} migration version must be a safe integer`);
    return undefined;
  }
  return {
    version,
    name: nameNode.text,
  };
}

function parseSource(source, findings) {
  const sourceFile = ts.createSourceFile(
    SOURCE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    findings.push(`${SOURCE_PATH}: TypeScript parse failed`);
    return [];
  }

  const declarations = new Map();
  const typedMigrationSymbols = new Set();
  for (const statement of sourceFile.statements) {
    if (!isExportedConst(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const symbol = declaration.name.text;
      if (declarations.has(symbol)) {
        findings.push(`${SOURCE_PATH}: exported const ${symbol} is duplicated`);
        continue;
      }
      declarations.set(symbol, declaration);
      if (isDoMigrationType(declaration.type)) typedMigrationSymbols.add(symbol);
    }
  }

  const chainDeclaration = declarations.get('DO_SCHEMA_MIGRATIONS');
  if (!chainDeclaration?.initializer) {
    findings.push(`${SOURCE_PATH}: cannot parse DO_SCHEMA_MIGRATIONS`);
    return [];
  }
  const chainInitializer = unwrapExpression(chainDeclaration.initializer);
  if (!ts.isArrayLiteralExpression(chainInitializer)) {
    findings.push(`${SOURCE_PATH}: DO_SCHEMA_MIGRATIONS must be an array literal`);
    return [];
  }

  const symbols = [];
  for (const element of chainInitializer.elements) {
    if (!ts.isIdentifier(element)) {
      findings.push(`${SOURCE_PATH}: DO_SCHEMA_MIGRATIONS entries must be migration constants`);
      continue;
    }
    symbols.push(element.text);
  }
  const seenSymbols = new Set();
  const migrations = [];

  for (const symbol of symbols) {
    if (seenSymbols.has(symbol)) {
      findings.push(`${SOURCE_PATH}: ${symbol} appears more than once in DO_SCHEMA_MIGRATIONS`);
      continue;
    }
    seenSymbols.add(symbol);
    const declaration = declarations.get(symbol);
    if (!declaration) {
      findings.push(`${SOURCE_PATH}: ${symbol} has no exported migration declaration`);
      continue;
    }
    const migration = parseMigrationDeclaration(symbol, declaration, findings);
    if (!migration) continue;
    migrations.push(migration);
  }

  for (const symbol of typedMigrationSymbols) {
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

function compareHistoricalPrefix(baseMigrations, migrations, findings) {
  for (const [index, baseMigration] of baseMigrations.entries()) {
    const migration = migrations[index];
    if (
      !migration ||
      migration.version !== baseMigration.version ||
      migration.name !== baseMigration.name
    ) {
      findings.push(`${SOURCE_PATH}: historical migration ${baseMigration.version} changed`);
    }
  }
}

function compareHistoricalReservations(baseReservations, reservations, findings) {
  for (const [index, baseReservation] of baseReservations.entries()) {
    const reservation = reservations[index];
    if (
      !reservation ||
      reservation.version !== baseReservation.version ||
      reservation.name !== baseReservation.name
    ) {
      findings.push(
        `${RESERVATION_PATH}: historical reservation ${baseReservation.version} changed`,
      );
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const root = parseRoot(argv);
  const baseRef = resolveBaseRef(root, argv);
  const findings = [];
  const sourceMigrations = parseSource(readRequired(root, SOURCE_PATH), findings);
  const reservations = parseReservations(readRequired(root, RESERVATION_PATH), findings);

  validateSequence(sourceMigrations, SOURCE_PATH, findings);
  validateSequence(reservations, RESERVATION_PATH, findings);
  compareReservations(sourceMigrations, reservations, findings);

  if (baseRef) {
    const baseMigrations = parseSource(readAtRef(root, baseRef, SOURCE_PATH), findings);
    const baseReservationsRaw = readOptionalAtRef(root, baseRef, RESERVATION_PATH);
    const baseReservations = baseReservationsRaw
      ? parseReservations(baseReservationsRaw, findings)
      : baseMigrations.map(({ version, name }) => ({ version, name }));
    validateSequence(baseMigrations, `${baseRef}:${SOURCE_PATH}`, findings);
    validateSequence(baseReservations, `${baseRef}:${RESERVATION_PATH}`, findings);
    if (baseReservationsRaw) {
      compareReservations(baseMigrations, baseReservations, findings);
    }
    compareHistoricalPrefix(baseMigrations, sourceMigrations, findings);
    compareHistoricalReservations(baseReservations, reservations, findings);
  }

  if (findings.length > 0) {
    process.stderr.write(`${[...new Set(findings)].sort().join('\n')}\n`);
    process.exit(1);
  }

  process.stdout.write(`${NAME}: ok (${reservations.length} reserved migrations)\n`);
}

main();
