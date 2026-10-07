import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { WaldoCoordinator } from '../src/coordinator/waldo-coordinator';
import type { CommonOwnerAuthority } from '../src/identity/common-owner-authority';
import type { RunLoopDO } from '../src/run-loop/do';
const ownerId='owner_'+'a'.repeat(64);
const admitted: CommonOwnerAuthority={custodyDigest:'b'.repeat(64),kind:'verified_message_presence',ownerId, authenticatedSubjectRef:'supabase_subject_'+'a'.repeat(64),authenticatedUserId:'30000000-0000-0000-0000-000000000001',directoryOwnerId:'10000000-0000-0000-0000-000000000001',doName:'fixture-common',presenceId:'20000000-0000-0000-0000-000000000001',provider:'telegram',subject:'81101',stateVersion:0,admissionRevision:'9'};
const input={requestId:'message_capture_one',commandId:'message_command_one',correlationId:'message_correlation_one',payload:{userStatement:'Make a private summary from this supplied text.'}};
it('captures through the existing writer and projects the same task under two truthful message issuers with no fabricated sessions',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-message-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async (_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const first=await coordinator.captureMessageResponsibility(input,admitted,async()=>{});
  const secondPresence={...admitted,provider:'whatsapp' as const,subject:'15550001111',presenceId:'20000000-0000-0000-0000-000000000002',custodyDigest:'c'.repeat(64)};
  const repeated=await coordinator.captureMessageResponsibility(input,secondPresence,async()=>{});
  expect(repeated).toEqual(first);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(1);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM presence_sessions').one().n).toBe(0);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM common_message_custody').one().n).toBe(2);
  const projected=coordinator.readResponsibilityProjection({routedOwnerId:ownerId,fromExclusiveCursor:0,limit:10});
  expect(projected.items.some(x=>x.aggregateId===first.outcome.id)).toBe(true);
 });
});
it('freshness failure stops capture and a newer global custody receipt fences all older issuer receipts',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-message-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  await expect(coordinator.captureMessageResponsibility(input,admitted,async()=>{throw Error('source revoked');})).rejects.toThrow('source revoked');
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(0);
  await coordinator.captureMessageResponsibility(input,{...admitted,admissionRevision:'10'},async()=>{});
  await expect(coordinator.captureMessageResponsibility(input,admitted,async()=>{})).rejects.toThrow();
  await expect(coordinator.captureMessageResponsibility(input,{...admitted,authenticatedSubjectRef:'supabase_subject_'+'b'.repeat(64)},async()=>{})).rejects.toThrow();
 });
});

it('existing source classifier allocates canonical Outcomes once, retains restrictions across a second issuer and recreation',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-source-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const scope={runId:'fixture-common-attempt',attempt:'fixture',deadline:Date.now()+30000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>state.storage.transactionSync(work)};
  const first=await coordinator.commonTaskSourceScope(admitted,{inputRef:'input_one',text:'Summarize only supplied notes.'},[],scope,async()=>{});
  const narrowed=(await first.classify(JSON.stringify({decision:'restrict',sources:[]}),'input_one','Summarize only supplied notes.')).snapshot;
  expect(narrowed.taskId.startsWith('outcome_')).toBe(true);
  const second=await coordinator.commonTaskSourceScope({...admitted,provider:'whatsapp',subject:'15550001111',presenceId:'20000000-0000-0000-0000-000000000002',custodyDigest:'c'.repeat(64)}, {inputRef:'input_two',text:'Make it shorter.'},['mail'],scope,async()=>{});
  const retained=(await second.classify(JSON.stringify({decision:'retain',sources:['mail']}),'input_two','Make it shorter.')).snapshot;
  expect(retained.taskId).toBe(narrowed.taskId);expect(retained.sources).toEqual([]);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(1);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM owner_task_source_scope').one().n).toBe(1);
 });
});

it('pending widening survives root policy recreation without treating a later reply as the original task',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-new-source-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const scope={runId:'fixture-common-attempt',attempt:'fixture',deadline:Date.now()+30000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>state.storage.transactionSync(work)};
  const first=await coordinator.commonTaskSourceScope(admitted,{inputRef:'input_one',text:'Summarize only supplied notes.'},[],scope,async()=>{});
  const old=(await first.classify(JSON.stringify({decision:'restrict',sources:[]}),'input_one','Summarize only supplied notes.')).snapshot;
  const request='Start a new task and read my mail.';
  const second=await coordinator.commonTaskSourceScope(admitted,{inputRef:'input_two',text:request},['mail'],scope,async()=>{});
  const waiting=await second.classify(JSON.stringify({decision:'new',sources:['mail'],evidence:request}),'input_two',request);
  expect(waiting.proposal).toBeDefined();expect(waiting.snapshot.taskId).toBe(old.taskId);
  const recreated=await coordinator.commonTaskSourceScope(admitted,{inputRef:'input_three',text:'Yes looks good.'},['mail'],scope,async()=>{});
  const stillWaiting=await recreated.classify(JSON.stringify({decision:'retain',sources:['mail']}),'input_three','Yes looks good.');
  expect(stillWaiting.snapshot.ready).toBe(false);expect(stillWaiting.snapshot.sources).toEqual([]);
  // Applying a pending new-task approval needs the original admitted request, not this later reply.
  // Caller recovery for that source is still unwired: preserve the pending boundary, do not mint from 'Yes'.
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(1);
 });
});

it('fresh nonpending owner-evidenced task transition allocates a new canonical Outcome rather than transport policy UUID',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-transition-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const scope={runId:'fixture-common-attempt',attempt:'fixture',deadline:Date.now()+30000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>state.storage.transactionSync(work)};
  const first=await coordinator.commonTaskSourceScope(admitted,{inputRef:'input_one',text:'Summarize notes.'},['workspace'],scope,async()=>{});
  const initial=(await first.classify(JSON.stringify({decision:'retain',sources:[]}),'input_one','Summarize notes.')).snapshot;
  const text='Start a new task in my workspace.';
  const second=await coordinator.commonTaskSourceScope(admitted,{inputRef:'input_two',text},['workspace'],scope,async()=>{});
  const fresh=(await second.classify(JSON.stringify({decision:'new',sources:['workspace'],evidence:text}),'input_two',text)).snapshot;
  expect(fresh.taskId).not.toBe(initial.taskId);
  expect(state.storage.sql.exec('SELECT user_statement FROM outcomes WHERE id = ?',fresh.taskId).one().user_statement).toBe(text);
 });
});

it('classification publication crash rolls back the task transition so an exact retry cannot duplicate or lose it',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-source-crash-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const scope={runId:'fixture',attempt:'fixture',deadline:Date.now()+30000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>state.storage.transactionSync(work)};
  const text='Start a new task in my workspace.';
  const cap=await coordinator.commonTaskSourceScope(admitted,{inputRef:'crash_input',text},['workspace'],scope,async()=>{});
  const before=await cap.current();
  const raw=JSON.stringify({decision:'new',sources:['workspace'],evidence:text});
  await expect(cap.classify(raw,'crash_input',text,()=>{throw Error('publication interrupted');})).rejects.toThrow('publication interrupted');
  expect(await cap.current()).toEqual(before);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(1);
  const result=await cap.classify(raw,'crash_input',text,value=>state.storage.kv.put('fixture-receipt',value));
  expect(state.storage.kv.get('fixture-receipt')).toEqual(result);
  expect(result.snapshot.taskId).not.toBe(before.taskId);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(2);
 });
});

it('prepared classifier retry refuses a changed source snapshot instead of applying the old decision to a later task',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-source-prepared-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const scope={runId:'fixture',attempt:'fixture',deadline:Date.now()+30000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>state.storage.transactionSync(work)};
  const text='Start a new task in my workspace.';
  const cap=await coordinator.commonTaskSourceScope(admitted,{inputRef:'prepared_input',text},['workspace'],scope,async()=>{});
  const expected=await cap.current();
  await cap.classify(JSON.stringify({decision:'restrict',sources:[]}),'restriction_input');
  const current=await cap.current();
  await expect(cap.classify(JSON.stringify({decision:'new',sources:['workspace'],evidence:text}),'prepared_input',text,()=>{},expected)).rejects.toThrow('Task source scope changed');
  expect(await cap.current()).toEqual(current);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(1);
 });
});

it('new global authority admission during a prepared source command fences the old reducer at local commit',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-source-epoch-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const scope={runId:'fixture',attempt:'fixture',deadline:Date.now()+30000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>state.storage.transactionSync(work)};
  let calls=0;
  const assertCurrent=async()=>{
   if (++calls === 3) await coordinator.captureMessageResponsibility({...input,requestId:'epoch_input',commandId:'epoch_command'}, {...admitted,admissionRevision:'10'},async()=>{});
  };
  const cap=await coordinator.commonTaskSourceScope(admitted,{inputRef:'epoch_source',text:'Make this shorter.'},['workspace'],scope,assertCurrent);
  await expect(cap.classify(JSON.stringify({decision:'retain',sources:[]}),'epoch_source','Make this shorter.')).rejects.toThrow();
  expect(state.storage.sql.exec('SELECT revision FROM owner_task_source_scope').one().revision).toBe(1);
 });
});

it('common planned WorkUnit receives a host ceiling through the same canonical writer and replay before execution admission',async()=>{
 const stub=env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-authorized-work-'+crypto.randomUUID())) as DurableObjectStub<RunLoopDO>;
 await runInDurableObject(stub,async(_instance,state)=>{
  const coordinator=new WaldoCoordinator(state.storage);
  const scope={runId:'fixture',attempt:'fixture',deadline:Date.now()+30000,signal:new AbortController().signal,admit(){},commit:<T>(work:()=>T)=>state.storage.transactionSync(work)};
  const cap=await coordinator.commonTaskSourceScope(admitted,{inputRef:'authorize_input',text:'Write a private checklist.'},['workspace'],scope,async()=>{});
  const snapshot=(await cap.classify(JSON.stringify({decision:'retain',sources:[]}),'authorize_input','Write a private checklist.')).snapshot;
  const unit=state.storage.sql.exec<{id:string}>('SELECT id FROM work_units').one().id;
  const ceiling={tools:['workspace_write'],connectors:[],externalEffects:'none' as const,outcomeMutation:'none' as const,evidenceAdmission:'none' as const,verification:'none' as const,acceptance:'none' as const,closure:'none' as const};
  const authorization={snapshot,workUnitId:unit,expectedRevision:1,authorityCeiling:ceiling,maxProviderTurns:25,maxDurationMs:30000,executorId:'fixture_registered_host',commandId:'fixture_authorization'};
  await expect(coordinator.authorizeMessageWorkUnitExecution({...authorization,snapshot:{...snapshot,sources:[]}},admitted,async()=>{})).rejects.toThrow('common execution source changed');
  await expect(coordinator.authorizeMessageWorkUnitExecution(authorization,admitted,async()=>{throw Error('owner changed');})).rejects.toThrow('owner changed');
  expect(state.storage.sql.exec('SELECT state FROM work_units').one().state).toBe('planned');
  const result=await coordinator.authorizeMessageWorkUnitExecution(authorization,admitted,async()=>{});
  const {applyDoMigration, COMMON_EXECUTION_WORKUNIT_SCHEMA_MIGRATION} = await import('../src/do-schema');
  expect(()=>applyDoMigration(state.storage,COMMON_EXECUTION_WORKUNIT_SCHEMA_MIGRATION,'down')).toThrow();
  expect(result.workUnit.state).toBe('execution_authorized');
  expect(result.workUnit.authorityCeiling.tools).toEqual(['workspace_write']);
  expect(coordinator.replayResponsibility(admitted.ownerId).workUnits[0]).toEqual(result.workUnit);
  const digest=`sha256:${'d'.repeat(64)}`;
  const binding={provider:{category:'provider' as const,id:'fixture_model_provider',version:'1.0.0',modelRef:'fixture_model',manifest:{id:'fixture_provider_manifest',version:'1.0.0',digest}},
    environment:{category:'execution_environment' as const,id:'fixture_registered_host',version:'1.0.0',environmentKind:'local' as const,manifest:{id:'fixture_environment_manifest',version:'1.0.0',digest}},
    contextProjectionRef:'fixture_frozen_context',contextProjectionDigest:digest};
  const admission={id:'fixture_execution_request',outcomeId:snapshot.taskId,workUnitId:unit};
  const aggregate=await coordinator.admitMessageExecutionRequestV04(admission,admitted,async()=>{},binding);
  expect(aggregate.request.authorityCeiling).toEqual(ceiling);
  expect(await coordinator.admitMessageExecutionRequestV04(admission,admitted,async()=>{},binding)).toEqual(aggregate);
  await expect(coordinator.admitMessageExecutionRequestV04(admission,admitted,async()=>{},{...binding,contextProjectionRef:'changed_context'})).rejects.toThrow();
  const claimed=coordinator.claimExecutionAttemptV04({executionRequestId:admission.id,attemptId:'fixture_attempt',leaseId:'fixture_lease',sessionId:'fixture_session',providerSessionRef:null});
  expect(claimed.attempts[0]!.workUnit.id).toBe(unit);
  expect(claimed.attempts[0]!.workUnit.revision).toBe(2);
  expect(claimed.attempts[0]!.provider).toEqual(binding.provider);
  const leaseInput={executionRequestId:admission.id,attemptId:'fixture_attempt',leaseId:'fixture_lease',fencingGeneration:1,cancellationGeneration:1,sourceSnapshot:snapshot};
  expect((await coordinator.assertMessageExecutionCurrent(leaseInput,admitted,async()=>{})).attempt.id).toBe('fixture_attempt');
  await expect(coordinator.assertMessageExecutionCurrent({...leaseInput,fencingGeneration:2},admitted,async()=>{})).rejects.toThrow('common execution lease closed');
  await cap.classify(JSON.stringify({decision:'restrict',sources:[]}),'restrict_after_claim');
  await expect(coordinator.assertMessageExecutionCurrent(leaseInput,admitted,async()=>{})).rejects.toThrow('common execution source changed');


  expect(state.storage.sql.exec('SELECT count(*) AS n FROM presence_sessions').one().n).toBe(0);
  await expect(coordinator.authorizeMessageWorkUnitExecution({snapshot,workUnitId:unit,expectedRevision:1,authorityCeiling:ceiling,maxProviderTurns:25,maxDurationMs:30000,executorId:'fixture_registered_host',commandId:'different_authorization'},admitted,async()=>{})).rejects.toThrow();
 });
});
