import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import contentLocks from './content-lock.mjs';

const directory=fileURLToPath(new URL('.',import.meta.url));
const coreRoot=process.argv[2]??resolve(directory,'../../../../../..');
const fromCore=name=>import(pathToFileURL(resolve(coreRoot,'packages/runtime',name)).href);
const {parseNativeCaseBundle}=await fromCore('evals/native-case-bundle.ts');
const {inspectNativeManifest}=await fromCore('evals/native-manifest.ts');
const {loadNativeSuite}=await fromCore('evals/waldo-native-suite.ts');
const {providerStateDigest,SyntheticProviderCustody,syntheticPayloadDigest,applyUnderExactApproval,IMPLEMENTED_NATIVE_EFFECTS}=await fromCore('evals/native-provider-state.ts');
const {inspectNativeExecutionSupport}=await fromCore('evals/native-execution-readiness.ts');
const {IsolatedSourceWorld}=await fromCore('scenarios/isolated-source-world.ts');
const {nativeSelectedSource}=await fromCore('scenarios/native-selected-source.ts');
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes,'utf8').digest('hex');
const ids=['W01','W02','W03','W04','W05','W06'];
const bytes=Object.fromEntries(ids.map(id=>[id,readFileSync(resolve(directory,`${id}.json`),'utf8')]));
const bundles=ids.map(id=>JSON.parse(bytes[id]));
const adapters=JSON.parse(readFileSync(resolve(directory,'adapters.json'),'utf8'));
const decision=(bundle,id)=>bundle.decisions.find(d=>d.id===id).synthetic_value;
const initial=bundle=>structuredClone(decision(bundle,'initial-provider-state').states);
const receiptKeys=['version','provenance','owner_id','kind','target','idempotency_key','payload_digest','state','provider_receipt_id','at','before_digest','after_digest'];
const contractedEffects=['calendar.create','calendar.move','calendar.cancel','mail.draft','mail.send','watch.start','watch.stop','order.submit','order.cancel','refund.request','subscription.cancel','subscription.switch','executor.admit','capture.admit','preference.correct','responsibility.stop','consent.revoke','data.delete'];

for(const bundle of bundles){
 const id=bundle.manifest.case_id;
 test(`${id}: core parser and manifest accept the canonical bundle`,()=>{
  const parsed=parseNativeCaseBundle(bytes[id]);
  assert.deepEqual(parsed.bundle,bundle);
  assert.equal(parsed.digest,digest(bytes[id]));
  assert.deepEqual(inspectNativeManifest(bundle.manifest),{status:'ready_for_isolated_trial',missing:[]});
  assert.equal(bundle.manifest.source_digest,digest(JSON.stringify(bundle.manifest.world.sources)));
  const expected=['version','suite_digest','baseline_head','revision','manifest','selected_source_ids','decisions','turns','required_source_families','required_effect_kinds','readiness'];
  assert.deepEqual(Object.keys(bundle).sort(),expected.sort());
 });
 test(`${id}: original visible prompt, fixture clock and pinned facts remain byte-exact`,()=>{
  const spec=loadNativeSuite().find(s=>s.id===id);
  assert.equal(bundle.manifest.visible_prompt,spec.user_prompt);
  assert.equal(bundle.turns[0].text,spec.user_prompt);
  assert.equal(bundle.manifest.world.clock,spec.fixture.now);
  assert.deepEqual(decision(bundle,'pinned-facts'),spec.fixture.facts);
  assert.equal(bundle.suite_digest,'fc651ed0e02bf53d3875d2497637f9f9309db794b6ce02386227a04b7155211f');
  assert.equal(bundle.baseline_head,'8eae4bd1d1c8a3a3338a8c689f20ea2b1bd5077e');
 });
 test(`${id}: every reviewed candidate/control source payload retains its content digest`,()=>{
  for(const lock of contentLocks.filter(l=>l.case_id===id)){
   const row=bundle.manifest.world.sources[lock.family].find(r=>r.owner_id===lock.owner_id&&r.id===lock.id);
   assert.ok(row);
   const payload=Object.fromEntries(lock.fields.map(field=>[field,row[field]]));
   assert.equal(syntheticPayloadDigest(payload),lock.digest,`${id}/${lock.owner_id}/${lock.family}/${lock.id}`);
  }
 });
 test(`${id}: selection happens before reads and never admits either owner's canary`,()=>{
  const world=new IsolatedSourceWorld(bundle.manifest.world);
  const owner=bundle.manifest.candidate_owner,control=bundle.manifest.control_owner;
  assert.notEqual(owner,control);
  const source=nativeSelectedSource(world,owner,bundle.selected_source_ids);
  const returned=[];
  for(const family of bundle.required_source_families){
   const rows=source.list(owner,family);
   assert.deepEqual(rows.map(r=>r.id),bundle.selected_source_ids[family]);
   assert.ok(rows.every(r=>r.owner_id===owner));
   returned.push(...rows);
   assert.throws(()=>source.list(control,family),/denied/);
  }
  const text=JSON.stringify(returned);
  assert.ok(!text.includes('CANARY_'));
  assert.ok(!text.includes('CONTROL_OWNER_ONLY'));
  for(const [family,rows]of Object.entries(bundle.manifest.world.sources))for(const row of rows){
   if(row.marker){assert.throws(()=>source.read(owner,family,row.id),/denied/);assert.ok(!text.includes(row.marker));}
  }
  assert.ok(world.accessLog(owner).some(a=>['denied_read','denied_list'].includes(a.kind)));
  assert.deepEqual(world.accessLog(control),[]);
 });
 test(`${id}: two-owner initial state digests are canonical, nonempty and reset independently`,()=>{
  const states=initial(bundle),locked=decision(bundle,'initial-provider-state').digests;
  for(const state of states){
   assert.equal(providerStateDigest(state),locked[state.owner_id]);
   assert.ok(Object.values(state.families).some(rows=>rows.length>0));
   const reordered={...state,receipts:[{ignored_for_digest:true}],families:Object.fromEntries(Object.entries(state.families).reverse().map(([family,rows])=>[family,[...rows].reverse().map(r=>Object.fromEntries(Object.entries(r).reverse()))]))};
   assert.equal(providerStateDigest(reordered),locked[state.owner_id]);
  }
  const provider=new SyntheticProviderCustody(states,()=>bundle.manifest.world.clock);
  const control=provider.readback(bundle.manifest.control_owner);
  const reset=new SyntheticProviderCustody(initial(bundle),()=>bundle.manifest.world.clock);
  assert.deepEqual(reset.readback(bundle.manifest.control_owner),control);
  const copy=provider.readback(bundle.manifest.candidate_owner);copy.families.files=[];
  assert.deepEqual(provider.readback(bundle.manifest.candidate_owner),states[0]);
 });
}

test('adapter specification uses only the contracted fields, method names and effect taxonomy',()=>{
 assert.deepEqual(Object.keys(adapters).sort(),['version','revision','sources','effects'].sort());
 assert.equal(adapters.version,1);
 for(const source of adapters.sources){
  assert.deepEqual(Object.keys(source).sort(),['family','row_fields','read_methods','selected_id_filter_required'].sort());
  assert.equal(source.selected_id_filter_required,true);
  assert.ok(source.read_methods.every(m=>['read','list'].includes(m)));
  for(const bundle of bundles)for(const row of bundle.manifest.world.sources[source.family]??[])assert.ok(Object.keys(row).every(k=>source.row_fields.includes(k)));
 }
 for(const effect of adapters.effects){
  assert.deepEqual(Object.keys(effect).sort(),['kind','state_family','required_payload_fields','requires_exact_approval'].sort());
  assert.ok(contractedEffects.includes(effect.kind));
  assert.ok(!['watch.cancel','artifact.write'].includes(effect.kind));
 }
 for(const bundle of bundles)for(const effect of bundle.required_effect_kinds)assert.ok(adapters.effects.some(e=>e.kind===effect));
});
test('all read-only base cases retain no external-effect approval',()=>{
 for(const id of ['W02','W05','W06']){
  const bundle=bundles.find(b=>b.manifest.case_id===id);
  assert.equal(bundle.turns.length,1);
  assert.deepEqual(bundle.required_effect_kinds,[]);
  assert.ok(bundle.manifest.grants.every(g=>g.allowed_effects.length===0));
 }
 const w3=bundles.find(b=>b.manifest.case_id==='W03');
 assert.ok(w3.manifest.grants.every(g=>!g.allowed_effects.includes('mail.send')));
});
test('exact synthetic approval binds both W01 revisions and the complete W04 message/deck',()=>{
 for(const id of ['W01','W04']){
  const bundle=bundles.find(b=>b.manifest.case_id===id);
  const turn=bundle.turns.find(t=>t.payload?.approvals?.length);
  assert.equal(turn.kind,'owner_text');
  for(let i=0;i<turn.payload.requests.length;i++){
   const request={...turn.payload.requests[i],idempotency_key:`validation-${id}-${i}`};
   const approval=turn.payload.approvals[i];
   assert.equal(syntheticPayloadDigest(request.payload),approval.payload_digest);
   const custody=new SyntheticProviderCustody(initial(bundle),()=>turn.at);
   const before=custody.readback(bundle.manifest.candidate_owner);
   assert.throws(()=>applyUnderExactApproval(custody,{...request,payload:{...request.payload,body:'changed'}},approval,turn.at),/differs/);
   assert.deepEqual(custody.readback(bundle.manifest.candidate_owner),before);
   const receipt=applyUnderExactApproval(custody,request,approval,turn.at);
   assert.deepEqual(Object.keys(receipt).sort(),receiptKeys.sort());
   assert.equal(receipt.payload_digest,approval.payload_digest);
   assert.notEqual(receipt.before_digest,receipt.after_digest);
   assert.equal(receipt.after_digest,providerStateDigest(custody.readback(bundle.manifest.candidate_owner)));
   const control=initial(bundle)[1];assert.deepEqual(custody.readback(control.owner_id),control);
  }
 }
});
test('unknown transport preserves an applied delta and reconciles the original intent without retry',()=>{
 const bundle=bundles[0],turn=bundle.turns[1];
 const request={...turn.payload.requests[0],idempotency_key:'lost-response'};
 const custody=new SyntheticProviderCustody(initial(bundle),()=>turn.at);
 const applied=applyUnderExactApproval(custody,request,turn.payload.approvals[0],turn.at);
 const transport={...applied,state:'unknown',provider_receipt_id:null};
 assert.equal(transport.state,'unknown');
 assert.notEqual(transport.before_digest,transport.after_digest);
 const settled=custody.intentReadback(request.owner_id,request.kind,request.idempotency_key);
 assert.deepEqual(settled,applied);
 assert.equal(providerStateDigest(custody.readback(request.owner_id)),applied.after_digest);
 assert.equal(custody.readback(request.owner_id).receipts.length,1);
 assert.throws(()=>custody.apply({...request,payload:{...request.payload,start:'different'}},[request.kind]),/conflict/);
});
test('rejected exact approvals and unsupported effects do not mutate provider state',()=>{
 const bundle=bundles[0],turn=bundle.turns[1],custody=new SyntheticProviderCustody(initial(bundle),()=>turn.at);
 const before=custody.readback(bundle.manifest.candidate_owner);
 const request={...turn.payload.requests[0],idempotency_key:'rejected'};
 assert.throws(()=>applyUnderExactApproval(custody,{...request,approved_revision:'stale'},turn.payload.approvals[0],turn.at),/differs/);
 assert.deepEqual(custody.readback(request.owner_id),before);
 assert.throws(()=>custody.apply({...request,kind:'watch.start'},['watch.start']),/unsupported/);
 assert.deepEqual(custody.readback(request.owner_id),before);
});
test('core execution support fails closed for unimplemented source, turn and watch custody',()=>{
 const bundle=bundles.find(b=>b.manifest.case_id==='W04');
 const missing=inspectNativeExecutionSupport(bundle,{source_families:['calendar','mail','tasks'],effect_kinds:IMPLEMENTED_NATIVE_EFFECTS,turn_kinds:['owner_text'],production_tools:bundle.manifest.supported_tools});
 assert.ok(missing.includes('unimplemented effect custody: watch.start'));
 assert.ok(missing.includes('unimplemented effect custody: watch.stop'));
 assert.ok(missing.includes('unimplemented source adapter: files'));
 assert.ok(missing.includes('unimplemented supervisor turn: provider_event'));
});
test('actual facts include 720-minute backlog, 240-minute availability, 18-to-12 updates and three notes',()=>{
 const w3=bundles.find(b=>b.manifest.case_id==='W03');
 assert.equal(w3.manifest.world.sources.tasks.filter(r=>r.owner_id===w3.manifest.candidate_owner).reduce((n,r)=>n+r.duration_minutes,0),720);
 assert.equal(w3.manifest.world.sources.availability.find(r=>r.id==='availability'&&r.owner_id===w3.manifest.candidate_owner).minutes,240);
 const w2=bundles.find(b=>b.manifest.case_id==='W02');
 const files=w2.manifest.world.sources.files.filter(r=>r.owner_id===w2.manifest.candidate_owner);
 assert.ok(files.find(r=>r.id==='company-update-sept20').bytes.includes('18 customers'));
 assert.ok(files.find(r=>r.id==='company-update-oct03').bytes.includes('12 customers'));
 const w6=bundles.find(b=>b.manifest.case_id==='W06');
 const notes=w6.manifest.world.sources.files.filter(r=>r.owner_id===w6.manifest.candidate_owner&&r.id.startsWith('reviewer-'));
 assert.equal(notes.length,3);
 assert.equal(notes.filter(r=>r.bytes.includes('could not identify the customer problem')).length,2);
});

import { ownerTurnLocks } from './content-lock.mjs';
test('every reviewed synthetic approval/disposition word remains byte-exact',()=>{
 for(const lock of ownerTurnLocks){
  const turn=bundles.find(b=>b.manifest.case_id===lock.case_id).turns.find(t=>t.id===lock.id);
  assert.equal(digest(turn.text),lock.digest);
 }
});
test('state digest validates complete JSON values, exact row IDs and receipt exclusion',()=>{
 const bundle=bundles[0],state=initial(bundle)[0];
 for(const value of [undefined,NaN,Infinity,BigInt(1),()=>{},Symbol('x'),new Date()]){
  const changed=structuredClone(state);changed.families.calendar[0].invalid=value;
  assert.throws(()=>providerStateDigest(changed));
 }
 const duplicate=structuredClone(state);duplicate.families.calendar.push(duplicate.families.calendar[0]);
 assert.throws(()=>providerStateDigest(duplicate),/invalid/);
 const fields=structuredClone(state);fields.families.calendar[0].fields={nil:null,flag:false,count:0,case:'A a ',unicode:'₹'};
 assert.notEqual(providerStateDigest(fields),providerStateDigest(state));
});
test('same-owner revisions change only candidate state and resetting discards the intent',()=>{
 const bundle=bundles[0],turn=bundle.turns[1],states=initial(bundle);
 const request={...turn.payload.requests[0],idempotency_key:'reset-intent'};
 const provider=new SyntheticProviderCustody(states,()=>turn.at);
 const first=applyUnderExactApproval(provider,request,turn.payload.approvals[0],turn.at);
 assert.deepEqual(applyUnderExactApproval(provider,request,turn.payload.approvals[0],turn.at),first);
 assert.notDeepEqual(provider.readback(request.owner_id),states[0]);
 assert.deepEqual(provider.readback(bundle.manifest.control_owner),states[1]);
 const reset=new SyntheticProviderCustody(initial(bundle),()=>turn.at);
 assert.deepEqual(reset.readback(request.owner_id),states[0]);
 assert.equal(reset.intentReadback(request.owner_id,request.kind,request.idempotency_key),null);
});
test('each effect definition has a specific state family and field inventory',()=>{
 for(const effect of adapters.effects){
  const state=adapters.sources.find(s=>s.family===effect.state_family);
  assert.ok(state,`missing state family ${effect.state_family}`);
  assert.ok(state.row_fields.includes('owner_id'));
  assert.ok(state.row_fields.includes('id'));
 }
 const watches=adapters.sources.find(s=>s.family==='watches');
 for(const field of ['thread_id','sent_message_id','expires_at','status','cancelled_at','revision'])assert.ok(watches.row_fields.includes(field));
});
