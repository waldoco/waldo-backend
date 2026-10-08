import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { buildSessionState, EXTERNAL_ORIGIN_TOOLS, WALDO_CHAT_MODEL, TOOL_PERMISSIONS, toolNameSchema, triggerTypeSchema, skillsListArgsSchema, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { createScopedCuratedSkillCapability } from '../src/skills/curated-host';
import { CURATED_SKILLS } from '../src/skills/curated-owner';
import type { LLMGatewayAdapter } from '../src/llm/provider';

const fixtureArgs: Record<string, unknown> = {
  read_thread:{thread_id:'thread-1'}, workspace_read:{file_id:'file-1',revision:1}, workspace_write:{path:'draft.md',text:'Verified draft',mime:'text/markdown',expected_revision:0},
  draft_email:{to:['friend@example.test'],subject:'Meeting',body_markdown:'See you soon.'}, send_email:{to:['friend@example.test'],subject:'Meeting',body_markdown:'See you soon.'},
  web_search:{query:'public source'}, browse_page:{url:'https://example.com/',instruction:'Read the source'},
  propose_calendar_change:{action:'create',title:'Focus',start:'2026-10-08T10:00:00Z',end:'2026-10-08T11:00:00Z',reason:'Owner review'},
  query_availability:{date_range:{from:'2026-10-08T10:00:00Z',to:'2026-10-08T18:00:00Z'},duration_minutes:60},
  set_reminder:{note:'Call mom',at:'2026-10-08T18:00'}, log_meal:{description:'Rice'}, log_workout:{type:'Walking'},
};
const scenarioNames=['day-brief','meeting-prep','inbox-triage-reply-draft','sourced-research-brief','calendar-focus-proposal','artifact-revision-delivery','weekly-review','follow-up-prep','reminders-and-watches','reviewed-outbound-message','project-catch-up','meal-activity-log-and-planning','memory-correction','travel-prep','decision-brief'];
for (const name of scenarioNames) {
  it(`skill-${name}: loads by default and named tools remain callable`, async () => {
    const skill=CURATED_SKILLS.find(s=>s.name===name);
    expect(skill).toBeDefined();
    if(!skill)throw new Error('skill_missing');
    expect(skill.required_tools.length).toBeGreaterThan(0);
    await runInDurableObject(env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`l1-${skill.name}`)), async (_,state) => {
      const scope = { runId:'run', attempt:'attempt', deadline:Date.now()+60000, signal:new AbortController().signal, admit(){}, commit<T>(work:()=>T){return work();} };
      const seen: string[] = []; const successful: string[] = []; const systems: string[] = []; let step=0; let activeTool=skill.required_tools[0]!;
      const gateway: LLMGatewayAdapter = { complete: async ({request}) => {
        if(request.response_format) return {ok:true,data:{model:request.model,text:'{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}',input_tokens:1,output_tokens:1,cache_read_input_tokens:0,latency_ms:1}};
        systems.push(request.system??'');
        const calls=step++===0?[{call_id:'load',name:'skills_load',arguments:JSON.stringify({name:skill.name,version:skill.version})}]:step===2?[{call_id:'tool',name:activeTool,arguments:JSON.stringify(fixtureArgs[activeTool]??{})}]:undefined;
        return {ok:true,data:{model:request.model,text:calls?'':'Prepared with verified receipts.',...(calls?{tool_calls:calls}:{}),input_tokens:1,output_tokens:1,cache_read_input_tokens:0,latency_ms:1}};
      }};
      const handlers=skill.required_tools.map(tool=>({name:tool as ToolName,description:'Fixture provider with recorded receipt',schema:skillsListArgsSchema.passthrough(),trigger_allowlist:triggerTypeSchema.options.filter(t=>TOOL_PERMISSIONS[t].includes(tool as ToolName)),autonomy_gated:false,handle:async()=>{seen.push(tool);return {ok:true as const,source_taint:EXTERNAL_ORIGIN_TOOLS.includes(tool as ToolName)?'external' as const:null,data:{receipt:'verified'}};}}));
      const args: Parameters<typeof createOwnerResponder> = ['fixture'];
      args[3]=entry=>{if(entry.hop.startsWith('tool_') && entry.ok)successful.push(entry.hop.slice(5));};
      args[5]=handlers as never; args[6]=WALDO_CHAT_MODEL; args[10]=gateway;
      args[16]=['example.com'];
      args[21]={skillHost:{prepare:async(turn,owner,capturedScope)=>createScopedCuratedSkillCapability(state.storage.sql,{owner,turnId:turn.traceId,trigger:'user_message',ownerText:turn.text,assertCurrent:async()=>scope.admit()},capturedScope)}};
      const responder=createOwnerResponder(...args);
      for (const [index, tool] of skill.required_tools.entries()) {
        activeTool=tool; step=0; systems.length=0;
        const reply=await responder.respond({traceId:`skill-${skill.name}-${index}`,conversationRef:'telegram-42',surface:'telegram',text:`Help me with ${skill.trigger_condition}`,runScope:scope,memoryWrites:false},async(_hop,work)=>work());
        expect(reply).toContain('Prepared with verified receipts.');
        expect(systems[0]).not.toContain(skill.body_markdown);
        expect(systems.slice(1).some(s=>s.includes(skill.body_markdown))).toBe(true);
      }
      expect(successful).toEqual(skill.required_tools.flatMap(tool=>['skills_load',tool]));
      expect(seen).toEqual(skill.required_tools.filter(tool=>tool!=='get_context'));
      for(const tool of skill.required_tools) expect(toolNameSchema.safeParse(tool).success).toBe(true);
    });
  });
}

it('a disabled procedure does not block an unrelated tool', async () => {
  await runInDurableObject(env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName('l1-no-skill-gate')),async(_,state)=>{
    const { CuratedOwnerSkills }=await import('../src/skills/curated-owner');
    const turn={owner:'owner-a',turnId:'turn',trigger:'user_message' as const,ownerText:'/skills disable day-brief',assertCurrent:async()=>{}};
    const book=new CuratedOwnerSkills(state.storage.sql,turn.owner);
    expect(book.disable('day-brief',2,turn).ok).toBe(true);
    expect(book.load('day-brief',2,turn).ok).toBe(false);
    expect(await book.prompt(turn,[])).toBe('');
    const { dispatchTool }=await import('../src/tools/dispatcher');
    const result=await dispatchTool({id:'read',name:'read_memory',args:{}},{trigger:'user_message',session:buildSessionState({trigger:'user_message',canary_tokens:['0123456789abcdef','fedcba9876543210','0011223344556677'],started_at:1}),canaryTokens:['0123456789abcdef','fedcba9876543210','0011223344556677'],authenticatedUserId:turn.owner,hasApproval:()=>true,sourceTaint:null,toolArgSourceTaint:null,sanitise:(await import('../src/scribe/sanitiser')).sanitise} as never,{handlers:[{name:'read_memory',description:'Read fixture memory',schema:skillsListArgsSchema,trigger_allowlist:triggerTypeSchema.options.filter(t=>TOOL_PERMISSIONS[t].includes('read_memory')),autonomy_gated:false,handle:async()=>({ok:true,source_taint:null,data:{claims:[]}})}]});
    expect(result.ok).toBe(true);
  });
});
