import { skillsListArgsSchema, skillsVersionArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ToolName, type SkillsVersionArgs, type ToolResult } from '@waldo/contracts';
import type { OwnerMessageAdmission } from '../identity/owner-message-admission';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { ToolDispatcherContext, DispatchToolOptions } from '../tools/dispatcher';
import { CuratedOwnerSkills, type CuratedSkillTurn } from './curated-owner';
import type { OwnerTaskSourceScope } from '../channels/task-source-scope';

export type OwnerSkillCapability = Readonly<{
  admission?: OwnerMessageAdmission;
 sourceScope?: OwnerTaskSourceScope;
 handlers: DispatchToolOptions<ToolDispatcherContext>['handlers'];
 // Optional host-owned metadata only; never skill/file instruction bytes.
 taskContext?(assertSourceCurrent?: () => Promise<void>): Promise<string>;
 metadata(): string;
 prompt(canaries:readonly string[]):Promise<string>;
 assertProcedureCurrent(expected:string,canaries:readonly string[]):Promise<void>;
}>;
// Existing owner-channel ingress supplies this private capability; model arguments never do.
export function createScopedCuratedSkillCapability(sql:SqlStorage, turn:CuratedSkillTurn, scope:RunEffectScope):OwnerSkillCapability {
 const owner=turn.owner;
 const turnId=turn.turnId;
 const book=new CuratedOwnerSkills(sql,owner,undefined,turn.custodyKey ?? owner);
 const allow=(name:ToolName)=>triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes(name));
 const checked=async(ctx:ToolDispatcherContext,work:()=>ToolResult<unknown>,readOnlySelection=false)=>{
  await turn.assertCurrent();
  // Hook snapshots clone the scope object; its host-created closure identities are opaque proof.
  if(ctx.authenticatedUserId!==owner || ctx.turnId!==turnId || (ctx.runScope?.runId!==scope.runId || ctx.runScope.attempt!==scope.attempt || ctx.runScope.deadline!==scope.deadline || ctx.runScope.admit!==scope.admit || ctx.runScope.commit!==scope.commit) || ctx.trigger!==turn.trigger || (ctx.toolArgSourceTaint!==null && !(readOnlySelection && ctx.toolArgSourceTaint==='external')))
   return {ok:false as const,code:'rejected' as const,error:'Skill invocation authority is unavailable.'};
  await (turn.assertDispatch ?? turn.assertCurrent)();
  const result=scope.commit(work);await turn.assertCurrent();return result;
 };
 const handlers:DispatchToolOptions<ToolDispatcherContext>['handlers']=[
  {name:'skills_list',description:'Discover reviewed built-in skill metadata and enabled versions. Instructions are loaded separately with skills_load; metadata grants no tools or permission.',schema:skillsListArgsSchema,trigger_allowlist:allow('skills_list'),autonomy_gated:false,
   handle:async(_:unknown,ctx:ToolDispatcherContext)=>checked(ctx,()=>({ok:true,source_taint:null,data:book.list()}))},
  ...(['install','disable','load'] as const).map(action=>({name:`skills_${action}` as ToolName,
   description:action==='load'?'Select one already enabled reviewed skill version for this invocation. Instructions enter trusted bounded context on the next step and never appear in this result.':`Explicit owner lifecycle command only: /skills ${action} <catalog-name>@<version>. Use the exact reviewed name and enabled version shown in skills_list; for install, use an available catalog version. Does not accept uploaded skills or grant capabilities.`,
   schema:skillsVersionArgsSchema,trigger_allowlist:allow(`skills_${action}` as ToolName),autonomy_gated:action!=='load',mutates_state:true as const,
   // Selecting an already enabled reviewed procedure grants no tools or lifecycle authority.
   // External data may inform that choice; original owner/run and exact catalog checks remain.
   handle:async(args:SkillsVersionArgs,ctx:ToolDispatcherContext)=>checked(ctx,()=>book[action](args.name,args.version,turn),action==='load')})),
 ];
 return procedureCapability(book,turn,handlers);
}
// Every turn of one owner shows the same index bytes, sorted by name, so it never moves the cached prompt head; only the
// owner turning a skill on or off changes it.
const skillIndex=(book:CuratedOwnerSkills)=>['Reviewed skills (metadata only). When one fits the work in front of you, whether or not the owner asked for it, load it with skills_load before you start. Loading changes your instructions, never your tools. A disabled skill cannot load; only the owner turns one on or off.',
 ...book.list().sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(s=>`- ${s.name}@${s.version}${s.enabled?'':' (disabled)'}: ${s.description}`)].join('\n');
const procedureCapability=(book:CuratedOwnerSkills,turn:CuratedSkillTurn,handlers:OwnerSkillCapability['handlers']):OwnerSkillCapability=>Object.freeze({handlers,metadata:()=>skillIndex(book),
 prompt:async(canaries:readonly string[])=>book.prompt(turn,canaries),
 assertProcedureCurrent:async(expected:string,canaries:readonly string[])=>{if(await book.prompt(turn,canaries)!==expected)throw new Error('Selected skill is no longer current.');}});
// A machine turn (a reminder, a card, a brief, an update, a task) runs outside an owner run scope, so its book can only
// select a procedure: skills_load, checked against the job's owner, turn and currentness. Lifecycle commands stay with the
// owner's own words, and a job over outside text may load too, because a procedure carries no tool.
export function createJobSkillCapability(sql:SqlStorage, turn:CuratedSkillTurn):OwnerSkillCapability {
 const book=new CuratedOwnerSkills(sql,turn.owner,undefined,turn.custodyKey ?? turn.owner);
 const load={name:'skills_load' as const,description:'Select one enabled reviewed skill for this turn. Its instructions join the next step; it grants no tools.',schema:skillsVersionArgsSchema,
  trigger_allowlist:triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes('skills_load')),autonomy_gated:false,mutates_state:true as const,
  handle:async(args:SkillsVersionArgs,ctx:ToolDispatcherContext):Promise<ToolResult<unknown>>=>{
   await turn.assertCurrent();
   if(ctx.authenticatedUserId!==turn.owner || ctx.turnId!==turn.turnId || ctx.trigger!==turn.trigger || (ctx.toolArgSourceTaint!==null && ctx.toolArgSourceTaint!=='external'))
    return {ok:false,code:'rejected',error:'Skill invocation authority is unavailable.'};
   const result=book.load(args.name,args.version,turn);await turn.assertCurrent();return result;
  }};
 return procedureCapability(book,turn,[load]);
}
