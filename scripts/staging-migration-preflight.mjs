import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const PROJECT='togdshayyxycitzckpqv';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function compareHistory(local,remote){
  if(!Array.isArray(remote))throw new Error('history_shape');
  const versions=remote.map(row=>{
    if(!row||typeof row.version!=='string'||!/^\d{14}$/.test(row.version))throw new Error('history_shape');
    return row.version;
  });
  if(new Set(versions).size!==versions.length)throw new Error('history_duplicate');
  versions.sort();
  const expected=local.map(row=>row.version);
  if(versions.length>expected.length||versions.some((v,i)=>v!==expected[i]))throw new Error('history_not_canonical_prefix');
  return {appliedVersions:versions,pending:local.slice(versions.length)};
}
export function localManifest(dir){
  const rows=readdirSync(dir).filter(name=>name.endsWith('.sql')).sort().map(name=>{
    if(!/^\d{14}_[a-z0-9_]+\.sql$/.test(name))throw new Error('local_filename');
    const bytes=readFileSync(new URL(name,dir));
    return {version:name.slice(0,14),filename:name,byteLength:bytes.length,sha256:sha(bytes)};
  });
  if(!rows.length||new Set(rows.map(r=>r.version)).size!==rows.length)throw new Error('local_history');
  return rows;
}
export async function readHistory(token,project,fetcher=fetch){
  if(project!==PROJECT)throw new Error('target_not_allowed');
  if(!token||token.length<10)throw new Error('auth_missing');
  const response=await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/database/migrations`,{
    method:'GET',redirect:'error',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),
  });
  // Never print response bodies, credentials or provider-controlled error text.
  if(!response.ok)throw new Error(`history_http_${response.status}`);
  if(!response.body)throw new Error('history_body_missing');
  const reader=response.body.getReader();const chunks=[];let total=0;
  try{while(true){const part=await reader.read();if(part.done)break;
    total+=part.value.byteLength;if(total>128*1024){await reader.cancel();throw new Error('history_oversize');}
    chunks.push(part.value);
  }}finally{reader.releaseLock();}
  const text=Buffer.concat(chunks).toString('utf8');
  try{return JSON.parse(text);}catch{throw new Error('history_json');}
}
export async function main(){
  const root=new URL('../',import.meta.url);
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if(!/^[a-f0-9]{40}$/.test(process.env.EXPECTED_SOURCE_SHA??'')||head!==process.env.EXPECTED_SOURCE_SHA)throw new Error('source_sha_mismatch');
  const dirty=execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'});
  if(dirty.trim())throw new Error('tracked_tree_dirty');
  execFileSync(process.execPath,['scripts/verify-supabase-migrations.mjs'],{cwd:root,stdio:'pipe'});
  const local=localManifest(new URL('supabase/migrations/',root));
  const remote=await readHistory(process.env.SUPABASE_ACCESS_TOKEN,process.env.SUPABASE_PROJECT_ID);
  const result=compareHistory(local,remote);
  const packet={kind:'read_only_staging_migration_preflight',projectRef:PROJECT,sourceSha:head,
    observedAt:new Date().toISOString(),localManifestSha256:sha(JSON.stringify(local)),pendingManifestSha256:sha(JSON.stringify(result.pending)),...result,
    scopeProof:'GET history proves access to this endpoint only; token scope/exclusivity not established',
    digestProof:'Local committed SQL bytes only; applied hosted SQL digest not verified',
    apply:'not implemented; no db push, migration repair, query write or Worker deployment'};
  writeFileSync('staging-migration-preflight.json',JSON.stringify(packet,null,2)+'\n',{mode:0o600});
  console.log(`Read-only preflight: ${result.appliedVersions.length} applied, ${result.pending.length} pending; no effects`);
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{const reason=/^[a-z0-9_]+$/.test(error.message)?error.message:'unexpected_error';console.error(`Preflight failed: ${reason}`);process.exitCode=1;});
