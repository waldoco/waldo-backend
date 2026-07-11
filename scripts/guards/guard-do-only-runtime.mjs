#!/usr/bin/env node
// guard-do-only-runtime — Worker and Durable Object runtime code must stay on the
// in-process DO execution path. The retired L1 invocation route is forbidden.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';

export const DISPOSITION = 'block';

const NAME = 'guard-do-only-runtime';
const PACKAGES = ['packages'];
const ROOT_SOURCE = ['src'];
const RUNTIME_PACKAGE = ['packages', 'runtime'];
const SUPABASE_FUNCTIONS = ['supabase', 'functions'];
const RETIRED_SUPABASE_FUNCTION = ['supabase', 'functions', 'invoke-agent'];
const RUNTIME_WRANGLER_CONFIGS = [
  ['packages', 'runtime', 'wrangler.toml'],
  ['packages', 'runtime', 'wrangler.json'],
  ['packages', 'runtime', 'wrangler.jsonc'],
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRS = new Set([
  '.git',
  'build',
  'coverage',
  'dist',
  'docs',
  'node_modules',
  'test',
  'tests',
  '__tests__',
]);
const TEST_FILE = /(?:\.|_)(?:spec|test)\.[^.]+$/i;
const DOCUMENTATION_FILE = /\.(?:md|mdx|txt)$/i;
const FORBIDDEN_RUNTIME_REFERENCE = /\binvoke-agent\b|\binvokeAgent\b/;
const FORBIDDEN_SERVICE_ROLE_BINDING = /\bSUPABASE_SERVICE_ROLE_KEY\b/;

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index !== -1) {
    const value = argv[index + 1];
    if (!value) {
      process.stderr.write(`${NAME}: --root requires a directory argument\n`);
      process.exit(2);
    }
    return resolve(value);
  }
  return fileURLToPath(new URL('../../', import.meta.url));
}

function extensionOf(file) {
  return file.slice(file.lastIndexOf('.'));
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function walk(dir, files, include = isScannableSource) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(file, files, include);
    } else if (entry.isFile() && include(entry.name)) {
      files.push(file);
    }
  }
}

function isScannableSource(name) {
  return SOURCE_EXTENSIONS.has(extensionOf(name)) && isNonTestFile(name);
}

function isNonTestFile(name) {
  return !TEST_FILE.test(name);
}

function sourceFilesUnder(dir) {
  const files = [];
  if (isDirectory(dir)) walk(dir, files);
  return files;
}

function allFilesUnder(dir, include = isNonTestFile) {
  const files = [];
  if (isDirectory(dir)) walk(dir, files, include);
  return files;
}

function isScannableProductionFile(name) {
  return isNonTestFile(name) && !DOCUMENTATION_FILE.test(name);
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const violations = new Set();

  for (const file of allFilesUnder(join(root, ...PACKAGES), isScannableProductionFile)) {
    if (FORBIDDEN_RUNTIME_REFERENCE.test(readFileSync(file, 'utf8'))) {
      violations.add(relative(root, file).split(sep).join('/'));
    }
  }

  for (const file of allFilesUnder(join(root, ...ROOT_SOURCE), isScannableProductionFile)) {
    if (FORBIDDEN_RUNTIME_REFERENCE.test(readFileSync(file, 'utf8'))) {
      violations.add(relative(root, file).split(sep).join('/'));
    }
  }

  const runtimePackage = join(root, ...RUNTIME_PACKAGE);
  for (const file of allFilesUnder(runtimePackage, isScannableProductionFile)) {
    if (FORBIDDEN_SERVICE_ROLE_BINDING.test(readFileSync(file, 'utf8'))) {
      violations.add(relative(root, file).split(sep).join('/'));
    }
  }

  const retiredSupabaseFunction = join(root, ...RETIRED_SUPABASE_FUNCTION);
  for (const file of allFilesUnder(retiredSupabaseFunction)) {
    violations.add(relative(root, file).split(sep).join('/'));
  }

  const supabaseFunctions = join(root, ...SUPABASE_FUNCTIONS);
  for (const file of sourceFilesUnder(supabaseFunctions)) {
    if (FORBIDDEN_RUNTIME_REFERENCE.test(readFileSync(file, 'utf8'))) {
      violations.add(relative(root, file).split(sep).join('/'));
    }
  }

  for (const segments of RUNTIME_WRANGLER_CONFIGS) {
    const config = join(root, ...segments);
    if (isFile(config) && FORBIDDEN_SERVICE_ROLE_BINDING.test(readFileSync(config, 'utf8'))) {
      violations.add(relative(root, config).split(sep).join('/'));
    }
  }

  if (violations.size > 0) {
    for (const violation of [...violations].sort()) process.stderr.write(`${violation}\n`);
    process.exit(1);
  }

  process.stdout.write(`${NAME}: ok\n`);
}

main();
