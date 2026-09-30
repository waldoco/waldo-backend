import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const guard = resolve('scripts/guards/guard-runtime-preview-config.mjs');
const raw = readFileSync('packages/runtime/wrangler.jsonc', 'utf8');
const cfg = JSON.parse(raw.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1'));
const wrapper = readFileSync('scripts/deploy-runtime-preview.sh', 'utf8');
const dir = mkdtempSync(resolve(tmpdir(), 'waldo-preview-guard-'));
try {
 mkdirSync(resolve(dir,'packages/runtime'),{recursive:true}); mkdirSync(resolve(dir,'scripts'),{recursive:true});
 const check = (config,command=wrapper) => {
  writeFileSync(resolve(dir,'packages/runtime/wrangler.jsonc'),JSON.stringify(config));
  writeFileSync(resolve(dir,'scripts/deploy-runtime-preview.sh'),command);
  return spawnSync(process.execPath,[guard],{cwd:dir,encoding:'utf8'}).status;
 };
 assert.equal(check(cfg),0);
 const attacks = [
  c=>{delete c.previews;},
  c=>{c.previews.vars.WALDO_OWNER_TELEGRAM_ID='owner';},
  c=>{c.previews.vars.WALDO_EGRESS_ALLOWLIST='private.example';},
  c=>{c.previews.vars.LANGFUSE_CAPTURE_TEXT='true';},
  c=>{c.previews.durable_objects.bindings[0].script_name='waldo-runtime-staging';},
  c=>{c.previews.ratelimits[0].namespace_id=c.ratelimits[0].namespace_id;},
  c=>{c.previews.r2_buckets=[{binding:'ARTIFACTS',bucket_name:'waldo-artifacts'}];},
  c=>{c.previews.ai={binding:'AI'};},
  c=>{c.previews.services=[{binding:'SHARED',service:'owner-worker'}];},
  c=>{c.previews.observability.logs.invocation_logs=true;},
  c=>{c.previews.observability.traces.enabled=true;},
 ];
 for(const attack of attacks){const changed=structuredClone(cfg);attack(changed);assert.notEqual(check(changed),0);}
 assert.notEqual(check(cfg,wrapper.replace('--ignore-base-config','')),0);
 assert.notEqual(check(cfg,wrapper.replace('wrangler preview','wrangler deploy')),0);
 assert.notEqual(check(cfg,wrapper.replace('--worker-name waldo-runtime-staging','--worker-name waldo-runtime')),0);
 console.log('runtime-preview-config adversarial: 15 checks passed');
} finally {rmSync(dir,{recursive:true,force:true});}
