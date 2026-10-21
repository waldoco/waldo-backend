#!/usr/bin/env node
// guard-actions-pinned — every action and reusable workflow a workflow runs is pinned to
// an immutable commit SHA, and every docker:// image to a sha256 digest, so moving a tag
// upstream cannot change what CI executes. Workflows are read as YAML data, not text, so
// aliases, merge keys and escaped keys cannot hide a floating ref.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const DISPOSITION = 'block';

const NAME = 'guard-actions-pinned';
const COMMIT_PINNED = /^[^\s@]+@[0-9a-f]{40}$/;
const DIGEST_PINNED = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/;

const dir = process.argv[2] ?? fileURLToPath(new URL('../../.github/workflows', import.meta.url));

function isPinned(ref) {
  if (typeof ref !== 'string') return false;
  if (ref.startsWith('./')) return true;
  if (ref.startsWith('docker://')) return DIGEST_PINNED.test(ref);
  return COMMIT_PINNED.test(ref);
}

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// GitHub honours `uses:` only on a job (reusable workflow) and on a step (action).
// Any other shape is unreadable, so it fails rather than passing unchecked.
function usesSites(workflow) {
  if (!isMapping(workflow) || !isMapping(workflow.jobs)) return null;
  const sites = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!isMapping(job)) return null;
    if ('uses' in job) sites.push([`jobs.${jobId}.uses`, job.uses]);
    if (job.steps === undefined) continue;
    if (!Array.isArray(job.steps)) return null;
    for (const [index, step] of job.steps.entries()) {
      if (!isMapping(step)) return null;
      if ('uses' in step) sites.push([`jobs.${jobId}.steps[${index}].uses`, step.uses]);
    }
  }
  return sites;
}

function readWorkflow(file) {
  try {
    const doc = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true, merge: true });
    return doc.errors.length ? undefined : doc.toJS({ maxAliasCount: 100 });
  } catch {
    return undefined;
  }
}

let names = [];
try {
  names = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
} catch {
  // A missing directory is reported below as having nothing to check.
}

const problems = [];
let checked = 0;
if (names.length === 0) problems.push(`no workflow files in ${relative(process.cwd(), dir) || '.'}`);
for (const name of names) {
  const file = join(dir, name);
  const where = relative(process.cwd(), file);
  const sites = usesSites(readWorkflow(file));
  if (!sites) {
    problems.push(`${where} is not a readable workflow`);
    continue;
  }
  for (const [path, ref] of sites) {
    checked += 1;
    if (!isPinned(ref)) problems.push(`${where} ${path} ${JSON.stringify(ref)} is not pinned to a full commit SHA`);
  }
}

if (problems.length) {
  for (const problem of problems) process.stderr.write(`${NAME}: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(`${NAME}: ok (${names.length} workflows, ${checked} uses)\n`);
