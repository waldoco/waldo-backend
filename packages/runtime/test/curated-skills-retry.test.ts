import { env,runInDurableObject } from 'cloudflare:test';
import { expect,it } from 'vitest';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { createScopedCuratedSkillCapability } from '../src/skills/curated-host';
import { CuratedOwnerSkills,CURATED_PREPARATION_SKILL } from '../src/skills/curated-owner';
import { localTrustedBriefScheduleInput } from '../src/run-loop/adapters';
import type { LLMGatewayAdapter } from '../src/llm/provider';

for(const kind of ['physical_retry','medical_recursion'] as const){
 it(`revocation prevents stale procedure egress during ${kind}`,async()=>{
  const stub=env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`curated-${kind}`));
  await runInDurableObject(stub,async(_,state)=>{
   const owner=localTrustedBriefScheduleInput().admission.verified_authority.principal_ref;
   const trace=`curated-${kind}`;const name=CURATED_PREPARATION_SKILL.name;const body=CURATED_PREPARATION_SKILL.body_markdown;
   const scope={runId:'run',attempt:'attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit(){},commit<T>(work:()=>T){return work();}};
   const writer=new CuratedOwnerSkills(state.storage.sql,owner);
   expect(writer.install(name,1,{owner,turnId:trace,trigger:'user_message',ownerText:`/skills install ${name}@1`,assertCurrent:async()=>{}}).ok).toBe(true);
   const physical:Array<{containsBody:boolean;status:string;context:string}>=[];let clinicalRejected=false;
   const archive=()=>state.storage.sql.exec("UPDATE skills SET status='archived' WHERE name=?",name);
   const gateway:LLMGatewayAdapter={complete:async({request,context})=>{
    const index=physical.length;const status=state.storage.sql.exec<{status:string}>('SELECT status FROM skills WHERE name=?',name).toArray()[0]!.status;
    physical.push({containsBody:request.system?.includes(body)??false,status,context});
    if(kind==='physical_retry'&&index===1){archive();return {ok:false,code:'transient',error:'Synthetic transient after disable'};}
    return {ok:true,data:{model:request.model,text:index===0?'':kind==='medical_recursion'&&index===1?'Take 5 mg of aspirin.':'Ask a physician.',input_tokens:1,output_tokens:1,cache_read_input_tokens:0,latency_ms:1,
     ...(index===0?{tool_calls:[{call_id:'load',name:'skills_load',arguments:JSON.stringify({name,version:1})}]}:{})}};
   }};
   const args:Parameters<typeof createOwnerResponder>=['fixture'];
   args[3]=entry=>{if(kind==='medical_recursion'&&entry.hop==='llm_reply'&&!entry.ok&&entry.code?.includes('medical_gate')){clinicalRejected=true;archive();}};
   args[10]=gateway;
   args[21]={skillHost:{prepare:async(turn,contextOwnerId,capturedScope)=>createScopedCuratedSkillCapability(state.storage.sql,{owner:contextOwnerId,turnId:turn.traceId,trigger:'user_message',ownerText:turn.text,assertCurrent:async()=>scope.admit()},capturedScope)}};
   await expect(createOwnerResponder(...args).respond({traceId:trace,conversationRef:'telegram-42',surface:'telegram',text:'Prepare a draft',runScope:scope,memoryWrites:false},async(_hop,work)=>work())).rejects.toThrow();
   expect(physical).toHaveLength(2);
   expect(physical.map(call=>call.containsBody)).toEqual([false,true]);
   expect(physical.every(call=>call.status==='active')).toBe(true);
   if(kind==='medical_recursion')expect(clinicalRejected).toBe(true);
  });
 });
}
