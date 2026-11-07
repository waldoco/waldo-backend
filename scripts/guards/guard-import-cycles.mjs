#!/usr/bin/env node
// guard-import-cycles — an import cycle in packages/runtime/src runs a module before the module it reads has finished
// loading, so a constant it imports is still undefined (CONSOLE_PATH in twelve unrelated tests, #1496). Typecheck cannot see
// it. Every load-time import (a static import or a re-export, never `import type` or a dynamic import()) is read with the
// TypeScript parser, and each strongly connected set of modules is held to the committed baseline: a new cycle, or a cycle
// that takes in another module, fails; a baselined cycle that shrank or went away fails until its baseline entry follows.
// `--write-baseline` writes the cycles as they stand.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const DISPOSITION = 'block';

const NAME = 'guard-import-cycles';
const SCAN_ROOT = ['packages', 'runtime', 'src'];
const BASELINE = ['scripts', 'guards', 'guard-import-cycles.baseline.json'];
const TEST_FILE = /(?:\.|_)(?:spec|test)\.[^.]+$/i;
const ts = createRequire(new URL('../../packages/runtime/package.json', import.meta.url))('typescript');

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const root = argValue('--root') ? resolve(argValue('--root')) : fileURLToPath(new URL('../../', import.meta.url));
const scanRoot = join(root, ...SCAN_ROOT);
const posix = (path) => relative(root, path).split(sep).join('/');

const sources = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
  return /\.(?:ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts') && !TEST_FILE.test(name) ? [path] : [];
});

const resolveImport = (from, specifier, files) => {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.(?:js|mjs|ts|mts)$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, 'index.ts')].find((candidate) => files.has(candidate));
};

// Load-time edges only: an import with no type-only clause, or a re-export that is not type-only.
const loadTimeImports = (path, files) => {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false);
  const edges = new Set();
  for (const statement of source.statements) {
    const loads = ts.isImportDeclaration(statement) ? !statement.importClause?.isTypeOnly
      : ts.isExportDeclaration(statement) ? !statement.isTypeOnly && statement.moduleSpecifier !== undefined : false;
    if (!loads || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveImport(path, statement.moduleSpecifier.text, files);
    if (target !== undefined) edges.add(target);
  }
  return edges;
};

// Tarjan's strongly connected components, iterative so a deep import chain cannot overflow the stack.
const cycles = (graph) => {
  let next = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], found = [];
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work = [[start, [...graph.get(start)]]];
    index.set(start, next); low.set(start, next); next += 1; stack.push(start); onStack.add(start);
    while (work.length > 0) {
      const [node, pending] = work.at(-1);
      if (pending.length > 0) {
        const child = pending.pop();
        if (!index.has(child)) {
          index.set(child, next); low.set(child, next); next += 1; stack.push(child); onStack.add(child);
          work.push([child, [...graph.get(child)]]);
        } else if (onStack.has(child)) low.set(node, Math.min(low.get(node), index.get(child)));
        continue;
      }
      work.pop();
      if (work.length > 0) { const parent = work.at(-1)[0]; low.set(parent, Math.min(low.get(parent), low.get(node))); }
      if (low.get(node) !== index.get(node)) continue;
      const members = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); members.push(member); } while (member !== node);
      if (members.length > 1 || graph.get(node).has(node)) found.push(members.map(posix).sort());
    }
  }
  return found.sort((a, b) => a[0].localeCompare(b[0]));
};

// One concrete loop through a cycle's modules, to name in the failure.
const loopThrough = (graph, members) => {
  const inside = new Set(members.map((member) => join(root, member)));
  const [start] = inside;
  const previous = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const child of graph.get(node)) {
      if (child === start) {
        const path = [node];
        while (previous.get(path[0]) !== null) path.unshift(previous.get(path[0]));
        return [...path, start].map(posix).join(' -> ');
      }
      if (inside.has(child) && !previous.has(child)) { previous.set(child, node); queue.push(child); }
    }
  }
  return members.join(', ');
};

const files = new Set(sources(scanRoot));
const graph = new Map([...files].map((file) => [file, loadTimeImports(file, files)]));
const current = cycles(graph);
const baselinePath = join(root, ...BASELINE);

if (process.argv.includes('--write-baseline')) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  process.stdout.write(`${NAME}: wrote ${current.length} cycles to ${posix(baselinePath)}\n`);
  process.exit(0);
}

let baseline;
try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch (error) {
  process.stderr.write(`${NAME}: cannot read the baseline ${posix(baselinePath)}: ${error.message}\n`);
  process.exit(2);
}
const key = (members) => members.join('\n');
const known = new Set(baseline.map(key));
const now = new Set(current.map(key));
const findings = [];
for (const members of current) {
  if (known.has(key(members))) continue;
  const grew = baseline.some((held) => held.every((member) => members.includes(member)));
  findings.push(`${grew ? 'a baselined import cycle took in more modules' : 'new import cycle'} (${members.length} modules): ${loopThrough(graph, members)}`);
}
for (const members of baseline) {
  if (now.has(key(members))) continue;
  findings.push(`baselined import cycle is gone or smaller, so its baseline entry must follow (run with --write-baseline): ${members.join(', ')}`);
}
if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${NAME}: ${finding}\n`);
  process.stderr.write(`${NAME}: break a new cycle by moving what both modules need into a module neither imports back, or by a lazy import() at the call site\n`);
  process.exit(1);
}
process.stdout.write(`${NAME}: ok (${files.size} modules, ${current.length} baselined cycles)\n`);
