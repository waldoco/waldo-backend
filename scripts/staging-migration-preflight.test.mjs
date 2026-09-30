import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareHistory,readHistory,localManifest} from './staging-migration-preflight.mjs';
const local=[{version:'20260930060000'},{version:'20260930070000'}];
test('empty or exact prefix produces pending list',()=>{
 assert.equal(compareHistory(local,[]).pending.length,2);
 assert.deepEqual(compareHistory(local,[{version:local[0].version}]).pending,[local[1]]);
 assert.equal(compareHistory(local,local).pending.length,0);
});
for(const [label,remote] of [['gap',[local[1]]],['duplicate',[local[0],local[0]]],['foreign',[{version:'20260930050000'}]],['badshape',{}],['badversion',[{version:1}]]])test(label+' fails closed',()=>assert.throws(()=>compareHistory(local,remote)));
test('wrong target cannot make request',async()=>{
 let calls=0;await assert.rejects(readHistory('not-a-secret-test','other',()=>{calls++;}));assert.equal(calls,0);
});
test('only GET, redirects refused, errors reveal status not body',async()=>{
 let captured; await assert.rejects(readHistory('fictional-token','togdshayyxycitzckpqv',async(u,o)=>{captured={u,o};return {ok:false,status:403,text:()=>{throw Error('must not read');}};}),/history_http_403/);
 assert.equal(captured.o.method,'GET'); assert.equal(captured.o.redirect,'error');assert.match(captured.u,/\/database\/migrations$/);
});
test('auth absent cannot make request',async()=>await assert.rejects(readHistory('','togdshayyxycitzckpqv',()=>{throw Error('should not call');}),/auth_missing/));
test('oversize history rejected',async()=>await assert.rejects(readHistory('fictional-token','togdshayyxycitzckpqv',async()=>new Response(' '.repeat(128*1024+1))),/history_oversize/));
test('real committed manifest has digests and37 entries',()=>{const m=localManifest(new URL('../supabase/migrations/',import.meta.url));assert.equal(m.length,37);assert.ok(m.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)&&x.byteLength>0));});

test('malformed provider content does not leak in parse error',async()=>await assert.rejects(readHistory('fictional-token','togdshayyxycitzckpqv',async()=>new Response('do-not-print-this-value')),/history_json/));
