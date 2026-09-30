import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,copyFileSync,rmSync,lstatSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareHistory,localManifest,readHistory} from './staging-migration-preflight.mjs';
const PROJECT='togdshayyxycitzckpqv';
export const pendingDigest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export function validateApply({source,expectedSource,dirty,project,expectedPending,local,remote}){
 if(!/^[a-f0-9]{40}$/.test(expectedSource??'')||source!==expectedSource)throw Error('source_sha_mismatch');
 if(dirty.trim())throw Error('tracked_tree_dirty');
 if(project!==PROJECT)throw Error('target_not_allowed');
 if(!/^[a-f0-9]{64}$/.test(expectedPending??''))throw Error('reviewed_pending_digest_required');
 const result=compareHistory(local,remote);
 if(!result.pending.length)throw Error('nothing_pending');
 if(pendingDigest(result.pending)!==expectedPending)throw Error('pending_digest_mismatch');
 return result;
}
export function effectiveConfigDigest(workdir){
 const rows=[];
 // Go dotenv discovery includes the project parent and can reach enclosing paths.
 let parent=resolve(workdir);
 while(true){
  if(readdirSync(parent).some(name=>name.startsWith('.env')))throw Error('local_forbidden_input');
  const next=dirname(parent);if(next===parent)break;parent=next;
 }
 const scan=(dir,relative='')=>{
  if(!lstatSync(dir).isDirectory())throw Error('local_not_regular');
  for(const name of readdirSync(dir).sort()){
   if(name.startsWith('.env')||['.branches','.cache'].includes(name))throw Error('local_forbidden_input');
   const path=join(dir,name),stat=lstatSync(path),label=relative+name;
   if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw Error('local_not_regular');
   if(stat.isDirectory())scan(path,label+'/');else rows.push([label,createHash('sha256').update(readFileSync(path)).digest('hex')]);
  }
 };
 scan(join(workdir,'supabase'));return pendingDigest(rows);
}
export function prepareCheckout(root){
 const inputs=new URL('supabase/',root);
 const scan=dir=>{
  if(!lstatSync(dir).isDirectory())throw Error('local_not_regular');
  for(const name of readdirSync(dir)){
   if(name.startsWith('.env')||['.temp','.branches','.cache'].includes(name))throw Error('local_forbidden_input');
   const path=new URL(name,dir),stat=lstatSync(path);
   if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw Error('local_not_regular');
   if(stat.isDirectory())scan(new URL(name+'/',dir));
  }
 };
 scan(inputs);
 const rows=localManifest(new URL('migrations/',inputs));
 const dir=mkdtempSync(join(tmpdir(),'waldo-reviewed-migrations-'));
 try {
  mkdirSync(join(dir,'supabase','migrations'),{recursive:true});
  // Ignore repository configuration, seed paths and arbitrary CLI dotenv/cache state.
  writeFileSync(join(dir,'supabase','config.toml'),'project_id = "waldo-reviewed-staging"\n');
  for(const row of rows)copyFileSync(new URL('migrations/'+row.filename,inputs),join(dir,'supabase','migrations',row.filename));
  return dir;
 }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
}
export async function main({env=process.env,run=execFileSync,fetcher=fetch,manifest=localManifest,read=readFileSync,prepare=prepareCheckout,cleanup=rmSync,configDigest=effectiveConfigDigest,makeDir=mkdirSync}={}){
 const root=new URL('../',import.meta.url);
 const source=run('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const dirty=run('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'});
 // Reject wrong target/source/digest before retrieving credentials or provider history.
 const expectedSource=env.EXPECTED_SOURCE_SHA,expectedPending=env.REVIEWED_PENDING_SHA256,project=env.SUPABASE_PROJECT_ID;
 if(!/^[a-f0-9]{40}$/.test(expectedSource??'')||source!==expectedSource)throw Error('source_sha_mismatch');
 if(dirty.trim())throw Error('tracked_tree_dirty');
 if(project!==PROJECT)throw Error('target_not_allowed');
 if(!/^[a-f0-9]{64}$/.test(expectedPending??''))throw Error('reviewed_pending_digest_required');
 run(process.execPath,['scripts/verify-supabase-migrations.mjs'],{cwd:root,stdio:'pipe'});
 const local=manifest(new URL('supabase/migrations/',root));
 const remote=await readHistory(env.SUPABASE_ACCESS_TOKEN,project,fetcher);
 const result=validateApply({source,expectedSource,dirty,project,expectedPending,local,remote});
 if(!env.SUPABASE_DB_PASSWORD)throw Error('db_auth_missing');
 const workdir=prepare(root);
 try {
 const isolated=manifest(new URL('supabase/migrations/',new URL(`file://${workdir}/`)));
 if(pendingDigest(isolated)!==pendingDigest(local))throw Error('isolated_bytes_mismatch');
 const cliEnv=Object.fromEntries(['PATH','CI','SUPABASE_ACCESS_TOKEN','SUPABASE_DB_PASSWORD'].filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
 const home=join(workdir,'.isolated-home');
 makeDir(home,{recursive:true});
 Object.assign(cliEnv,{HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_CACHE_HOME:join(home,'cache'),XDG_DATA_HOME:join(home,'data'),TMPDIR:join(home,'tmp')});
 makeDir(cliEnv.TMPDIR,{recursive:true});
 const cli=args=>run('pnpm',['dlx','supabase@2.109.1',...args,'--profile','supabase'],{cwd:workdir,env:cliEnv,stdio:'pipe',timeout:180000});
 // Password stays in the process environment, never argv, output or receipt.
 cli(['link','--project-ref',PROJECT]);
 const linked=read(join(workdir,'supabase','.temp','project-ref'),'utf8').trim();
 if(linked!==PROJECT)throw Error('linked_target_mismatch');
 const effectiveConfig=configDigest(workdir);
 cli(['db','push','--linked','--dry-run']);
 // Re-read authoritative history immediately before the write. Drift cancels the run.
 validateApply({source:run('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),expectedSource,dirty:run('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}),project,expectedPending,local:manifest(new URL('supabase/migrations/',root)),remote:await readHistory(env.SUPABASE_ACCESS_TOKEN,project,fetcher)});
 if(pendingDigest(manifest(new URL('supabase/migrations/',new URL(`file://${workdir}/`))))!==pendingDigest(local))throw Error('isolated_bytes_mismatch');
 if(configDigest(workdir)!==effectiveConfig)throw Error('effective_config_drift');
 if(read(join(workdir,'supabase','.temp','project-ref'),'utf8').trim()!==PROJECT)throw Error('linked_target_mismatch');
 // No seed, roles, include-all or history repair. CLI maintains canonical version history.
 cli(['db','push','--linked','--yes']);
 const after=compareHistory(local,await readHistory(env.SUPABASE_ACCESS_TOKEN,project,fetcher));
 if(after.pending.length)throw Error('post_apply_history_incomplete');
 console.log(JSON.stringify({kind:'staging_migration_apply_history_receipt',sourceSha:source,projectRef:PROJECT,pendingManifestSha256:expectedPending,appliedVersions:result.pending.map(x=>x.version),historyComplete:true,appliedSqlDigestsVerified:false,workerDeploy:false}));
 } finally {cleanup(workdir,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{
 const reason=/^[a-z0-9_]+$/.test(error.message)?error.message:'execution_failed_or_unconfirmed';
 console.error(`Apply stopped: ${reason}. Do not retry a write without checking hosted history.`);process.exitCode=1;
});
