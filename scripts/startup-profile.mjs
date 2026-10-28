#!/usr/bin/env node
// Reports where Worker startup CPU goes, per package, for the staging bundle: the evidence behind
// Cloudflare error 10021 (startup CPU limit). Read-only: builds locally, never deploys.
//   node scripts/startup-profile.mjs [--runs 7] [--env staging]
// One run is not a measurement - the same bundle ranged 3-4x between runs on a busy machine - so
// this prints median and min over --runs, plus each package's median share of sampled startup time.
// Shares move far less with load than milliseconds do. It exits 0 on every outcome, saying so
// when the profiler cannot run: a timing budget needs numbers from the CI runner first, and the
// blocking wall is guard-startup-lazy-sdks.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1]; };
const runs = Number(arg('runs', 7));
const env = arg('env', 'staging');
const runtime = resolve('packages/runtime');
const dir = mkdtempSync(resolve(tmpdir(), 'waldo-startup-profile-'));
const bundlePath = resolve(dir, 'worker.js');
const profilePath = resolve(dir, 'worker.cpuprofile');
const wrangler = (args) => execFileSync('pnpm', ['exec', 'wrangler', ...args], { cwd: runtime, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  execFileSync('pnpm', ['--filter', '@waldo/dashboard-app', 'build'], { encoding: 'utf8', timeout: 120000, stdio: 'ignore' });
  wrangler(['deploy', '--dry-run', '--env', env, '--outfile', bundlePath]);

  // esbuild marks each source file in the bundle with a "// path" line; a profile frame belongs to
  // the last marker above its line.
  const marks = [];
  readFileSync(bundlePath, 'utf8').split('\n').forEach((line, index) => { if (/^\/\/ (src\/|\.\.\/|node-built-in)/.test(line)) marks.push([index, line.slice(3).trim()]); });
  const packageOf = (line) => {
    let low = 0, high = marks.length - 1, hit = -1;
    while (low <= high) { const mid = (low + high) >> 1; if (marks[mid][0] <= line) { hit = mid; low = mid + 1; } else high = mid - 1; }
    if (hit < 0) return 'bundler helpers';
    const file = marks[hit][1];
    const dependency = /node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/.exec(file);
    return dependency ? dependency[1] : file.startsWith('../contracts') ? '@waldo/contracts' : file.startsWith('src/') ? 'runtime src' : file;
  };

  const active = [], gc = [], shares = [];
  for (let run = 0; run < runs; run += 1) {
    const out = wrangler(['check', 'startup', '--env', env, '--workerBundle', bundlePath, '--outfile', profilePath]);
    active.push(Number(/Active: ([\d.]+) ms/.exec(out)[1]));
    gc.push(Number(/including ([\d.]+) ms garbage/.exec(out)[1]));
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const time = new Map();
    profile.samples.forEach((id, index) => {
      const frame = nodes.get(id).callFrame;
      if (frame.functionName === '(idle)') return;
      const key = frame.lineNumber < 0 ? frame.functionName || 'native' : packageOf(frame.lineNumber);
      time.set(key, (time.get(key) ?? 0) + (profile.timeDeltas[index + 1] ?? 0));
    });
    const total = [...time.values()].reduce((sum, value) => sum + value, 0);
    shares.push(new Map([...time].map(([key, value]) => [key, value / total])));
  }

  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const names = new Set(shares.flatMap((share) => [...share.keys()]));
  const rows = [...names].map((name) => [name, median(shares.map((share) => share.get(name) ?? 0))]).sort((a, b) => b[1] - a[1]).slice(0, 12);
  process.stdout.write(`startup profile, ${env}, ${runs} runs (local CPU, not Cloudflare's clock)\n`);
  process.stdout.write(`active ms: median ${median(active)}  min ${Math.min(...active)}  max ${Math.max(...active)}; gc median ${median(gc)}\n`);
  for (const [name, share] of rows) process.stdout.write(`${(share * 100).toFixed(1).padStart(5)}%  ${name}\n`);
} catch (error) {
  process.stdout.write(`startup profile unavailable: ${String(error.message).split('\n')[0]}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
