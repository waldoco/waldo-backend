import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
const workflow=parse(readFileSync(new URL('../.github/workflows/deploy-staging.yml',import.meta.url),'utf8'));
test('default deploy stays deploy; explicit apply operation only',()=>{
 assert.equal(workflow.on.workflow_dispatch.inputs.operation.default,'deploy');
 assert.equal(workflow.jobs['migration-apply'].if,"inputs.operation == 'migration-apply'");
 assert.equal(workflow.jobs.deploy.if,"inputs.operation == 'deploy'");
 assert.equal(workflow.jobs['migration-preflight'].if,"inputs.operation == 'preflight'");
});
test('no combined database write in deploy; legacy input fails closed',()=>{
 const steps=workflow.jobs.deploy.steps;
 assert.ok(!steps.some(s=>/db push|supabase.*link/.test(s.run??'')));
 assert.ok(steps.some(s=>s.if==='inputs.run_migrations'&&/exit 1/.test(s.run)));
});
test('apply serialization staging scope and pinned target; no worker',()=>{
 const job=workflow.jobs['migration-apply'];assert.equal(job.environment,'staging');assert.equal(job.concurrency['cancel-in-progress'],false);
 const step=job.steps.find(s=>s.run==='node scripts/staging-migration-apply.mjs');
 assert.equal(step.env.SUPABASE_PROJECT_ID,'togdshayyxycitzckpqv');assert.equal(step.env.REVIEWED_PENDING_SHA256,'${{ inputs.reviewed_pending_sha256 }}');
 assert.ok(!job.steps.some(s=>/wrangler|deploy-runtime/.test(s.run??'')));
});
