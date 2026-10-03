import { skillsListArgsSchema, skillsVersionArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ToolName, type SkillsVersionArgs, type ToolResult } from '@waldo/contracts';
import type { OwnerMessageAdmission } from '../identity/owner-message-admission';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { ToolDispatcherContext, DispatchToolOptions } from '../tools/dispatcher';
import { CuratedOwnerSkills, type CuratedSkillTurn } from './curated-owner';

export type OwnerSkillCapability = Readonly<{
 handlers: DispatchToolOptions<ToolDispatcherContext>['handlers'];
 metadata(): string;
 prompt(canaries:readonly string[]):Promise<string>;
 assertProcedureCurrent(expected:string,canaries:readonly string[]):Promise<void>;
}>;
// Host constructs this only after canonical owner admission. No model or source bytes can
// construct lifecycle authority; the original admitted owner text and run identity are fixed.
export function createCuratedSkillCapability(sql:SqlStorage, admission:OwnerMessageAdmission, ownerText:string, turnId:string, scope:RunEffectScope):OwnerSkillCapability {
 const owner=admission.invocation.verified_authority.principal_ref;
 const turn:CuratedSkillTurn={owner,ownerText,turnId,trigger:admission.invocation.runtime_binding.trigger,
  assertCurrent:async()=>{scope.admit();await admission.assertCurrent();scope.admit();}};
 return createScopedCuratedSkillCapability(sql,turn,scope);
}
// Existing owner-channel ingress supplies this private capability; model arguments never do.
export function createScopedCuratedSkillCapability(sql:SqlStorage, turn:CuratedSkillTurn, scope:RunEffectScope):OwnerSkillCapability {
 const owner=turn.owner;
 const turnId=turn.turnId;
 const book=new CuratedOwnerSkills(sql,owner,undefined,turn.custodyKey ?? owner);
 const allow=(name:ToolName)=>triggerTypeSchema.options.filter(trigger=>TOOL_PERMISSIONS[trigger].includes(name));
 const checked=async(ctx:ToolDispatcherContext,work:()=>ToolResult<unknown>)=>{
  await turn.assertCurrent();
  // Hook snapshots clone the scope object; its host-created closure identities are opaque proof.
  if(ctx.authenticatedUserId!==owner || ctx.turnId!==turnId || (ctx.runScope?.runId!==scope.runId || ctx.runScope.attempt!==scope.attempt || ctx.runScope.deadline!==scope.deadline || ctx.runScope.admit!==scope.admit || ctx.runScope.commit!==scope.commit) || ctx.trigger!==turn.trigger || ctx.toolArgSourceTaint!==null)
   return {ok:false as const,code:'rejected' as const,error:'Skill invocation authority is unavailable.'};
  const result=scope.commit(work);await turn.assertCurrent();return result;
 };
 const handlers:DispatchToolOptions<ToolDispatcherContext>['handlers']=[
  {name:'skills_list',description:'Discover reviewed built-in skill metadata and enabled versions. Instructions are loaded separately with skills_load; metadata grants no tools or permission.',schema:skillsListArgsSchema,trigger_allowlist:allow('skills_list'),autonomy_gated:false,
   handle:async(_:unknown,ctx:ToolDispatcherContext)=>checked(ctx,()=>({ok:true,source_taint:null,data:book.list()}))},
  ...(['install','disable','load'] as const).map(action=>({name:`skills_${action}` as ToolName,
   description:action==='load'?'Select one already enabled reviewed skill version for this invocation. Instructions enter trusted bounded context on the next step and never appear in this result.':`Explicit owner command only: /skills ${action} document-email-preparation@1. Does not accept uploaded skills or grant capabilities.`,
   schema:skillsVersionArgsSchema,trigger_allowlist:allow(`skills_${action}` as ToolName),autonomy_gated:action!=='load',mutates_state:true as const,
   handle:async(args:SkillsVersionArgs,ctx:ToolDispatcherContext)=>checked(ctx,()=>book[action](args.name,args.version,turn))})),
 ];
 return Object.freeze({handlers,metadata:()=>`Reviewed skill catalog (metadata only): ${JSON.stringify(book.list())}. Use skills_load only if an enabled skill fits the current task. Disabled skills cannot load; install requires the explicit owner lifecycle command.`,prompt:async(canaries:readonly string[])=>book.prompt(turn,canaries),assertProcedureCurrent:async(expected:string,canaries:readonly string[])=>{if(await book.prompt(turn,canaries)!==expected)throw new Error('Selected skill is no longer current.');}});
}
