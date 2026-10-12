import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { DAY_CARDS, dayPlanInput, DAY_PLAN_INSTRUCTION, DAY_PLAN_SCHEMA } from '../src/prompt/day-cards';
import { deriveContextBudgetChars, SANITISE_DESTINATION_POLICIES, WALDO_CHAT_MODEL } from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
const limit=deriveContextBudgetChars(WALDO_CHAT_MODEL,SANITISE_DESTINATION_POLICIES.internal_context.max_chars);
const input=dayPlanInput({localNow:'2026-10-04T08:00',calendar:'No events.',cards:DAY_CARDS,proactivity:'Quiet hours 23:00-07:00'});
it.each([false,true])('real planDay provider admission with 220 facts, escaping=%s',async escaping=>{
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`review738-${escaping}`)),async(_i,state)=>{
 const memory=claimStore(state.storage.sql);
 for(let i=0;i<220;i++) {let text=`Routine ${i}: ${escaping?'"\\\n'.repeat(80):'synthetic detail '.repeat(20)}`;memory.add({kind:'routine',text,source:'stated',evidence:text,origin:'owner',source_ref:'owner, synthetic-day-plan'},'2026-10-04T00:00:00Z');}
 const requests:LLMGatewayRequest[]=[];
 const output=JSON.stringify({cards:DAY_CARDS.map(c=>({id:c.id,time:c.defaultTime,reason:'synthetic'}))});
 const gateway:LLMGatewayAdapter={complete:async request=>{requests.push(request);return {ok:true,data:{model:request.request.model,text:output,input_tokens:1,output_tokens:1,cache_read_input_tokens:0,latency_ms:0}};}};
 const args:Parameters<typeof createOwnerResponder>=['fixture',undefined,memory];args[10]=gateway;
 expect(await createOwnerResponder(...args).planDay('review738',input)).toBe(output);
 expect(requests).toHaveLength(1);
 const r=requests[0]!;expect(r.context).toBe('full_context');
 expect(r.request.system).toBe(DAY_PLAN_INSTRUCTION);expect(r.request.response_format).toEqual({name:'day_plan',schema:DAY_PLAN_SCHEMA});
 expect(JSON.stringify(r.request.messages).length).toBeLessThanOrEqual(limit);
 const content=r.request.messages[0]!.content;
 expect(content.endsWith(input)).toBe(true);expect(content).toContain('Routine 219:');expect(content).toContain('older owner facts are not shown here');
 });
});
it('oversized input fails before gateway admission',async()=>{
 let calls=0;const gateway:LLMGatewayAdapter={complete:async()=>{calls++;throw Error('unexpected gateway');}};
 const args:Parameters<typeof createOwnerResponder>=['fixture'];args[10]=gateway;
 await expect(createOwnerResponder(...args).planDay('review738','x'.repeat(limit))).rejects.toThrow('day plan input exceeds provider context budget');expect(calls).toBe(0);
});
