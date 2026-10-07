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
