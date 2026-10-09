import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,copyFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {canonicalHistoryVersions} from './canonical-history-versions.mjs';
const sql=readFileSync(new URL('../supabase/fixtures/assert-canonical-migration-history.sql',import.meta.url),'utf8');
test('real executable44-entry declaration excludes line/block/nested comment versions',()=>{
 const original=canonicalHistoryVersions(sql);assert.equal(original.length,44);
 for(const comment of ["-- '20261008000100'","/* '20261008000100' */","/* outer /* '20261008000100' */ inner */"]){
  const changed=sql.replace("'20261008000000',","'20261008000000'").replace("'20261008000100'",comment);
  assert.equal(canonicalHistoryVersions(changed).length,43);
 }
 assert.deepEqual(canonicalHistoryVersions(sql.replace('expected constant',"/* expected constant text[] := array['11111111111111']; */ expected constant")),original);
});
test('strings and quoted identifiers never supply declarations, malformed/duplicate arrays fail closed',()=>{
 assert.throws(()=>canonicalHistoryVersions("select 'expected constant text[] := array[''11111111111111''];';"));
 assert.throws(()=>canonicalHistoryVersions('"expected" constant text[] := array[\'11111111111111\'];'));
 // An interior closing tag hidden in a presumed comment ends the real
 // PostgreSQL body; declarations after it are not executable. Reject, never 44.
 assert.throws(()=>canonicalHistoryVersions(sql.replace('declare',"declare -- preview $assertion$\n")));
 assert.throws(()=>canonicalHistoryVersions(sql.replace('begin',"/* preview $assertion$ */ begin")));
 for(const bad of [sql.replace("'20261008000100'","'not-a-version'"),sql.replace("'20261008000100'","coalesce('20261008000100','x')"),sql+'\nexpected constant text[] := array[\'11111111111111\'];',sql+'/*unterminated',sql.replace('declare','declare $$ expected constant text[] := array[\'11111111111111\']; $$;'),sql.replace('constant text',"'constant' text")])assert.throws(()=>canonicalHistoryVersions(bad));
});

test('actual verifier rejects43active line/block comment entries and accepts exact44source',()=>{
 const root=mkdtempSync(join(tmpdir(),'canonical-history-test-'));
 try{
  for(const dir of ['scripts','supabase/migrations','supabase/fixtures'])mkdirSync(join(root,dir),{recursive:true});
  for(const name of ['verify-supabase-migrations.mjs','canonical-history-versions.mjs'])copyFileSync(new URL(name,import.meta.url),join(root,'scripts',name));
  for(const name of readdirSync(new URL('../supabase/migrations/',import.meta.url)))if(name.endsWith('.sql'))writeFileSync(join(root,'supabase/migrations',name),'');
  const fixture=join(root,'supabase/fixtures/assert-canonical-migration-history.sql');
  const run=()=>spawnSync(process.execPath,[join(root,'scripts/verify-supabase-migrations.mjs')],{encoding:'utf8'});
  writeFileSync(fixture,sql);assert.equal(run().status,0);
  for(const comment of ["-- '20261008000100'","/* outer /* '20261008000100' */ inner */"]){
   writeFileSync(fixture,sql.replace("'20261008000000',","'20261008000000'").replace("'20261008000100'",comment));
   const result=run();assert.equal(result.status,1);assert.ok(result.stderr.includes('SQL canonical migration history assertion drifted'));
  }
  // Interior tag probe: all 44 declarations remain textually present, but the
  // real body closes early; the verifier must refuse instead of reporting 44.
  writeFileSync(fixture,sql.replace('declare','declare -- preview $assertion$\n'));
  const interior=run();assert.ok(interior.stderr.includes('unsupported SQL assertion wrapper'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
