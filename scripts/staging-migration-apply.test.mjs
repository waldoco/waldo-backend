import {test} from 'node:test';
import assert from 'node:assert/strict';
import {main,pendingDigest,validateApply} from './staging-migration-apply.mjs';
const local=[{version:'20260930060000',filename:'20260930060000_first.sql',sha256:'a'.repeat(64),byteLength:1},{version:'20260930070000',filename:'20260930070000_second.sql',sha256:'b'.repeat(64),byteLength:2}];
const args={source:'c'.repeat(40),expectedSource:'c'.repeat(40),dirty:'',project:'togdshayyxycitzckpqv',expectedPending:pendingDigest(local.slice(1)),local,remote:[{version:local[0].version}]};
test('exact source target canonical prefix and byte digest required',()=>assert.deepEqual(validateApply(args).pending,local.slice(1)));
for(const [name,change] of Object.entries({source:{source:'d'.repeat(40)},target:{project:'production'},dirty:{dirty:'?? secret.env'},missingDigest:{expectedPending:''},wrongDigest:{expectedPending:'0'.repeat(64)},foreign:{remote:[{version:'20250101000000'}]},gap:{remote:[{version:local[1].version}]},duplicate:{remote:[{version:local[0].version},{version:local[0].version}]},alreadyApplied:{remote:local}}))test(name+' stops',()=>assert.throws(()=>validateApply({...args,...change})));
test('SQL-byte manifest drift and file rename invalidate review',()=>{
 for(const localChanged of [[local[0],{...local[1],sha256:'e'.repeat(64)}],[local[0],{...local[1],filename:'20260930070000_renamed.sql'}]])assert.throws(()=>validateApply({...args,local:localChanged}),/pending_digest_mismatch/);
});
test('bad source/target/digest and untracked file stop before provider or CLI',async()=>{
 for(const change of [{EXPECTED_SOURCE_SHA:'d'.repeat(40)},{SUPABASE_PROJECT_ID:'production'},{REVIEWED_PENDING_SHA256:''},{dirty:'?? payload.sql'}]){
 const calls=[];const env={EXPECTED_SOURCE_SHA:'c'.repeat(40),SUPABASE_PROJECT_ID:'togdshayyxycitzckpqv',REVIEWED_PENDING_SHA256:args.expectedPending,...change};
 await assert.rejects(main({env,run:(cmd,argv)=>{calls.push([cmd,argv]);return argv[0]==='rev-parse'?'c'.repeat(40):change.dirty??'';},fetcher:()=>{throw Error('must_not_fetch');}}));
 assert.ok(calls.every(([cmd])=>cmd==='git'));
 }
});
const fixture=(options={})=>{
 const calls=[];let historyCalls=0;
 const env={EXPECTED_SOURCE_SHA:args.source,SUPABASE_PROJECT_ID:args.project,REVIEWED_PENDING_SHA256:args.expectedPending,SUPABASE_ACCESS_TOKEN:'fictional-fixture-token',SUPABASE_DB_PASSWORD:'fictional-fixture-password'};
 const run=(cmd,argv,opts)=>{
  calls.push({cmd,argv,opts});
  if(cmd==='git')return argv[0]==='rev-parse'?args.source:'';
  if(cmd==='pnpm'&&argv.includes('--yes')&&options.failWrite)throw Error('sensitive fixture-provider stderr');
  return '';
 };
 const fetcher=async()=>{
  historyCalls++;
  const rows=historyCalls===3?local:historyCalls===2&&options.drift?local:args.remote;
  return new Response(JSON.stringify(rows));
 };
 return {calls,options:{env,run,fetcher,manifest:()=>local,read:()=>options.wrongLink?'production':args.project,prepare:()=>'/fictional-isolated-workdir',cleanup:()=>{},configDigest:()=> 'stable-fixture-config'}};
};
test('happy path: pinned CLI env-only password, dry-run before write and post-read',async()=>{
 const f=fixture();await main(f.options);
 const cli=f.calls.filter(c=>c.cmd==='pnpm');assert.equal(cli.length,3);
 assert.deepEqual(cli.map(c=>c.argv),[['dlx','supabase@2.109.1','link','--project-ref',args.project],['dlx','supabase@2.109.1','db','push','--linked','--dry-run'],['dlx','supabase@2.109.1','db','push','--linked','--yes']]);
 assert.ok(cli.every(c=>c.opts.stdio==='pipe'&&!c.argv.includes(f.options.env.SUPABASE_DB_PASSWORD)));
});
test('linked target mismatch stops before dry-run/write',async()=>{const f=fixture({wrongLink:true});await assert.rejects(main(f.options),/linked_target_mismatch/);assert.equal(f.calls.filter(c=>c.cmd==='pnpm').length,1);});
test('history drift after dry-run stops before write',async()=>{const f=fixture({drift:true});await assert.rejects(main(f.options),/nothing_pending/);assert.ok(!f.calls.some(c=>c.argv.includes('--yes')));});
test('write error never retries or prints provider content',async()=>{const f=fixture({failWrite:true});await assert.rejects(main(f.options));assert.equal(f.calls.filter(c=>c.argv.includes('--yes')).length,1);});

test('write runs from isolated workdir, not repository linked cache',async()=>{const f=fixture();await main(f.options);assert.ok(f.calls.filter(c=>c.cmd==='pnpm').every(c=>c.opts.cwd==='/fictional-isolated-workdir'));});
test('copied SQL digest drift cancels before any CLI',async()=>{const f=fixture();let reads=0;f.options.manifest=()=>++reads===1?local:[local[0],{...local[1],sha256:'f'.repeat(64)}];await assert.rejects(main(f.options),/isolated_bytes_mismatch/);assert.ok(!f.calls.some(c=>c.cmd==='pnpm'));});
test('CLI rejects ambient database-target/config overrides',async()=>{
 const f=fixture();Object.assign(f.options.env,{PGHOST:'other',DATABASE_URL:'postgres://other',SUPABASE_DB_URL:'postgres://other',SUPABASE_CONFIG:'bad',SUPABASE_PROJECT_ID:'togdshayyxycitzckpqv'});
 await main(f.options);for(const c of f.calls.filter(c=>c.cmd==='pnpm')){
 assert.equal(c.opts.env.PGHOST,undefined);assert.equal(c.opts.env.DATABASE_URL,undefined);assert.equal(c.opts.env.SUPABASE_DB_URL,undefined);assert.equal(c.opts.env.SUPABASE_CONFIG,undefined);assert.equal(c.opts.env.SUPABASE_PROJECT_ID,undefined);
 assert.equal(c.opts.env.SUPABASE_DB_PASSWORD,'fictional-fixture-password');}
});
test('copied byte read failure cleans up and never calls CLI',async()=>{const f=fixture();let reads=0,cleaned=0;f.options.manifest=()=>{if(++reads>1)throw Error('bad copy');return local;};f.options.cleanup=()=>cleaned++;await assert.rejects(main(f.options));assert.equal(cleaned,1);assert.ok(!f.calls.some(c=>c.cmd==='pnpm'));});
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareCheckout} from './staging-migration-apply.mjs';
import {localManifest} from './staging-migration-preflight.mjs';
test('real filesystem: migration and config symlinks cannot enter isolated checkout',()=>{
 const dir=mkdtempSync(join(tmpdir(),'waldo-symlink-test-'));
 try {
 mkdirSync(join(dir,'supabase','migrations'),{recursive:true});writeFileSync(join(dir,'outside.sql'),'SELECT 1;');writeFileSync(join(dir,'outside.toml'),'project_id="fictional"');
 symlinkSync(join(dir,'outside.sql'),join(dir,'supabase','migrations','20260930060000_link.sql'));
 const root=pathToFileURL(dir+'/');
 assert.throws(()=>localManifest(new URL('supabase/migrations/',root)),/local_not_regular/);
 assert.throws(()=>prepareCheckout(root),/local_not_regular/);
 rmSync(join(dir,'supabase','migrations','20260930060000_link.sql'));writeFileSync(join(dir,'supabase','migrations','20260930060000_regular.sql'),'SELECT 1;');
 symlinkSync(join(dir,'outside.toml'),join(dir,'supabase','config.toml'));
 assert.throws(()=>prepareCheckout(root),/local_not_regular/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('real filesystem: ignored nested env cannot bypass CLI environment allowlist',()=>{
 const dir=mkdtempSync(join(tmpdir(),'waldo-env-test-'));let copy;
 try{
 mkdirSync(join(dir,'supabase','migrations'),{recursive:true});writeFileSync(join(dir,'supabase','migrations','20260930060000_regular.sql'),'SELECT 1;');
 writeFileSync(join(dir,'supabase','config.toml'),'project_id="other"');
 writeFileSync(join(dir,'supabase','.env'),'PGHOST=untrusted-target');
 assert.throws(()=>prepareCheckout(pathToFileURL(dir+'/')),/local_forbidden_input/);
 rmSync(join(dir,'supabase','.env'));mkdirSync(join(dir,'supabase','nested'));writeFileSync(join(dir,'supabase','nested','.env.local'),'PGHOST=other');
 assert.throws(()=>prepareCheckout(pathToFileURL(dir+'/')),/local_forbidden_input/);
 rmSync(join(dir,'supabase','nested'),{recursive:true});
 copy=prepareCheckout(pathToFileURL(dir+'/'));
 assert.equal(readFileSync(join(copy,'supabase','config.toml'),'utf8'),'project_id = "waldo-reviewed-staging"\n');
 assert.deepEqual(readdirSync(join(copy,'supabase')).sort(),['config.toml','migrations']);
 }finally{if(copy)rmSync(copy,{recursive:true,force:true});rmSync(dir,{recursive:true,force:true});}
});
import {readFileSync,readdirSync} from 'node:fs';

test('effective linked config drift stops write',async()=>{const f=fixture();let reads=0;f.options.configDigest=()=>++reads===1?'before':'after';await assert.rejects(main(f.options),/effective_config_drift/);assert.ok(!f.calls.some(c=>c.argv.includes('--yes')));});
