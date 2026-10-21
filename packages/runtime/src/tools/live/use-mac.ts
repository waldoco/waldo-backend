import {useMacArgsSchema,taintGateBlocksDirectExecution,type UseMacArgs,type ToolHandler,type ToolResult} from '@waldo/contracts';
import type {ToolDispatcherContext} from '../dispatcher';
import type {CommandInput,EnqueueResult} from '../../devices/command-store';
import type {MacPayload} from '../../devices/mac-wire';
import type {Capability} from '../../devices/contract';
import {sha256Hex} from '../../devices/signing';
export function macAction(args:UseMacArgs):{class:Capability;payload:MacPayload}{
 if(args.action==='run_command')return {class:'shell_exec',payload:{project:args.project,command:args.command,reason:args.reason,timeout_seconds:args.timeout_seconds}};
 if(args.action==='list_sessions')return {class:'session_query',payload:{action:args.action,project:args.project}};
 if(args.action==='read_session')return {class:'session_query',payload:{action:args.action,project:args.project,session_id:args.session_id}};
 const payload:MacPayload={action:args.action,project:args.project,reason:args.reason};
 if('session_id' in args)payload.session_id=args.session_id;
 if('prompt' in args)payload.prompt=args.prompt;
 if('agent' in args)payload.agent=args.agent;
 return {class:'session_control',payload};
}
export type MacDesk={request(input:Pick<CommandInput,'class'|'payload'|'request_id'>,ctx:ToolDispatcherContext):Promise<EnqueueResult>};
export const useMacHandler=(desk:MacDesk):ToolHandler<UseMacArgs,unknown,ToolDispatcherContext>=>({
 name:'use_mac',description:'Request a command or coding-session operation on your paired Mac. Commands, starts, messages and stops require a native Mac approval every time. Queries and interrupts need no dialog. Chat replies cannot approve. Returns immediately; the result arrives separately.',
 schema:useMacArgsSchema,trigger_allowlist:['user_message'],autonomy_gated:false,mutates_state:true,
 handle:async(args,ctx):Promise<ToolResult<unknown>>=>{
  if(ctx?.ownerInitiated!==true || !ctx?.turnId||!ctx.toolCallId||ctx.trigger!=='user_message'||taintGateBlocksDirectExecution('use_mac',ctx.toolArgSourceTaint))return {ok:false,code:'forbidden',error:'Mac requests require an untainted owner turn.'};
  ctx.runScope?.admit();
  const request_id=await sha256Hex(new TextEncoder().encode(`mac:${ctx.authenticatedUserId}:${ctx.turnId}:${ctx.toolCallId}`));
  const input=macAction(args);
  try{
   const result=await desk.request({...input,request_id},ctx);ctx.runScope?.admit();
   return result.accepted?{ok:true,data:{request_id,status:'sent to your Mac for approval'},source_taint:null}:{ok:false,code:'forbidden',error:'The Mac request could not be admitted. Check pairing, capability consent and request limits.'};
  }catch{return {ok:false,code:'transient',error:'The Mac request status is uncertain. Retry this same request identity; never assume execution.'};}
 },
});
