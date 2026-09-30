import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
export function prepareCheckout(root){
 const dir=mkdtempSync(join(tmpdir(),'waldo-reviewed-migrations-'));
 cpSync(new URL('supabase/',root),join(dir,'supabase'),{recursive:true});
 // Never inherit a cached linked target or CLI authentication from source.
 rmSync(join(dir,'supabase','.temp'),{recursive:true,force:true});
 return dir;
}
export async function main({env=process.env,run=execFileSync,fetcher=fetch,manifest=localManifest,read=readFileSync,prepare=prepareCheckout,cleanup=rmSync}={}){
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
 const isolated=manifest(new URL('supabase/migrations/',new URL(`file://${workdir}/`)));
 if(pendingDigest(isolated)!==pendingDigest(local)){cleanup(workdir,{recursive:true,force:true});throw Error('isolated_bytes_mismatch');}
 try {
 const cli=args=>run('pnpm',['dlx','supabase@2.109.1',...args],{cwd:workdir,env,stdio:'pipe',timeout:180000});
 // Password stays in the process environment, never argv, output or receipt.
 cli(['link','--project-ref',PROJECT]);
 const linked=read(join(workdir,'supabase','.temp','project-ref'),'utf8').trim();
 if(linked!==PROJECT)throw Error('linked_target_mismatch');
 cli(['db','push','--linked','--dry-run']);
 // Re-read authoritative history immediately before the write. Drift cancels the run.
 validateApply({source:run('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),expectedSource,dirty:run('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}),project,expectedPending,local:manifest(new URL('supabase/migrations/',root)),remote:await readHistory(env.SUPABASE_ACCESS_TOKEN,project,fetcher)});
 if(pendingDigest(manifest(new URL('supabase/migrations/',new URL(`file://${workdir}/`))))!==pendingDigest(local))throw Error('isolated_bytes_mismatch');
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
