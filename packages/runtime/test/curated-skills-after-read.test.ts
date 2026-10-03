import { env, runInDurableObject } from 'cloudflare:test';
import { expect,it } from 'vitest';
import { buildSessionState, workspaceListArgsSchema } from '@waldo/contracts';
import { createScopedCuratedSkillCapability } from '../src/skills/curated-host';
import { dispatchTool } from '../src/tools/dispatcher';
import { runToolLoop } from '../src/conversation/tool-loop';
import { sanitise } from '../src/scribe/sanitiser';
const canaries=['ababcdbcdbababcd','cdcdababcdcdabab','bababcdcbababcdc'];
it('reviewed enabled selection remains owner-bound after an external workspace read without widening lifecycle grants',async()=>{
 const stub=env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName('skill-selection-after-read'));
 await runInDurableObject(stub,async(_,state)=>{
  let closed=false;const scope={runId:'run',attempt:'attempt',deadline:Date.now()+60000,signal:new AbortController().signal,admit(){if(closed)throw new Error('closed');},commit<T>(work:()=>T){this.admit();return work();}};
  const turn={owner:'owner',turnId:'turn',trigger:'user_message' as const,ownerText:'/skills install document-email-preparation@1',assertCurrent:async()=>scope.admit()};
  const cap=createScopedCuratedSkillCapability(state.storage.sql,turn,scope);
  const ctx={authenticatedUserId:'owner',turnId:'turn',runScope:scope,trigger:'user_message' as const,canaryTokens:canaries,session:buildSessionState({trigger:'user_message',canary_tokens:canaries,started_at:1}),hasApproval:()=>true,sourceTaint:null,toolArgSourceTaint:null as 'external'|null,sanitise};
  const version={name:'document-email-preparation',version:1};
  expect(await dispatchTool({id:'install',name:'skills_install',args:version},ctx,{handlers:cap.handlers})).toMatchObject({ok:true});
  const externalList={name:'workspace_list' as const,description:'Fixture private metadata',schema:workspaceListArgsSchema,trigger_allowlist:['user_message'] as const,autonomy_gated:false,handle:async()=>({ok:true as const,data:{files:[]},source_taint:'external' as const})};
  const events:Array<{name:string;ok:boolean}>=[];let step=0;
  await runToolLoop({handlers:[externalList,...cap.handlers],ctx,maxSteps:4,step:async()=>{
   const name=step++===0?'workspace_list':step===2?'skills_load':undefined;
   return name?{text:'',tool_calls:[{call_id:`call-${step}`,name,arguments:JSON.stringify(name==='workspace_list'?{}:version)}]}:{text:'done'};
  },onTool:event=>events.push({name:event.call.name,ok:event.ok})});
  expect(events).toEqual([{name:'workspace_list',ok:true},{name:'skills_load',ok:true}]);
  expect(ctx.toolArgSourceTaint).toBe('external');expect(await cap.prompt(canaries)).toContain('Prepare a reviewable draft.');
  const call=(args:unknown,overrides={})=>dispatchTool({id:'check',name:'skills_load',args},{...ctx,...overrides},{handlers:cap.handlers});
  for(const overrides of [{authenticatedUserId:'other'},{turnId:'other'},{runScope:{...scope,runId:'other'}},{runScope:{...scope,admit:()=>{}}}])expect(await call(version,overrides)).toMatchObject({ok:false});
  expect(await call({...version,version:2})).toMatchObject({ok:false});expect(await call({...version,name:'uploaded-skill'})).toMatchObject({ok:false});
  expect(await dispatchTool({id:'tainted-install',name:'skills_install',args:version},ctx,{handlers:cap.handlers})).toMatchObject({ok:false});
  const disabled=createScopedCuratedSkillCapability(state.storage.sql,{...turn,ownerText:'/skills disable document-email-preparation@1'},scope);
  expect(await dispatchTool({id:'tainted-disable',name:'skills_disable',args:version},ctx,{handlers:disabled.handlers})).toMatchObject({ok:false});
  expect(await dispatchTool({id:'owner-disable',name:'skills_disable',args:version},{...ctx,toolArgSourceTaint:null},{handlers:disabled.handlers})).toMatchObject({ok:true});
  expect(await call(version)).toMatchObject({ok:false});expect(await cap.prompt(canaries)).toBe('');
  closed=true;await expect(cap.prompt(canaries)).rejects.toThrow('closed');
 });
});
