import { expect, it, vi, beforeEach } from 'vitest';
import { browsePageArgsSchema, browseActArgsSchema, buildSessionState, TOOL_PERMISSIONS, triggerTypeSchema, type ToolHandler } from '@waldo/contracts';
import { runToolLoop } from '../src/conversation/tool-loop';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
const canaries = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const ctx = { authenticatedUserId: 'owner', trigger: 'user_message' as const, canaryTokens: canaries, sourceTaint: null, toolArgSourceTaint: null, sanitise: resolveRunLoopAdapters({ WALDO_ENV: 'local' }).safety.sanitise, egressAllowlist: ['*'], session: buildSessionState({ trigger: 'user_message', canary_tokens: canaries, started_at: 0 }) };
beforeEach(()=>{ctx.session=buildSessionState({trigger:'user_message',canary_tokens:canaries,started_at:0});ctx.toolArgSourceTaint=null;});
const args = JSON.stringify({ provider: 'cloudflare_playwright', url: 'https://example.com/a', instruction: 'Read page' });
for (const retained of [true, false]) it(`${retained ? 'retained host' : 'ordinary provider'} read keeps its correct duplicate and hard-budget behavior`, async () => {
 const handle = vi.fn(async () => ({ ok: true as const, data: { url: 'https://example.com/a', ...(retained ? { session_handle: 'host-session' } : {}) }, source_taint: 'external' as const }));
 const handler: ToolHandler<unknown, unknown, ToolDispatcherContext> = { name: 'browse_page', schema: browsePageArgsSchema, description: 'Read', trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('browse_page')), autonomy_gated: false, handle };
 const outputs: any[] = [], budget = { remaining: 2 };
 await runToolLoop({ handlers: [handler], ctx, maxSteps: 5, budget, onTool: event => outputs.push(JSON.parse(event.output.split("\n")[0]!)), step: async tools => tools ? { text: '', tool_calls: [{ call_id: crypto.randomUUID(), name: 'browse_page', arguments: args }] } : { text: 'Done' } });
 expect(handle).toHaveBeenCalledTimes(1);
 expect(outputs).toHaveLength(2); expect(budget.remaining).toBe(0);
 expect(outputs[1]).toMatchObject({ ok: false, code: 'repeat_refusal' });
});
it('fresh retained revisit checks authority and caches its settled rejection', async () => {
 let allowed = true;
 const handle = vi.fn(async () => allowed ? { ok: true as const, data: { session_handle: 'host-session' }, source_taint: 'external' as const } : { ok: false as const, code: 'rejected' as const, error: 'Owner revoked', source_taint: 'external' as const });
 const handler: ToolHandler<unknown, unknown, ToolDispatcherContext> = { name: 'browse_page', schema: browsePageArgsSchema, description: 'Read', trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('browse_page')), autonomy_gated: false, handle };
 const action = { ...handler, name:'browse_act' as const, trigger_allowlist:triggerTypeSchema.options.filter(t=>TOOL_PERMISSIONS[t].includes('browse_act')), schema:browseActArgsSchema, mutates_state:true as const, handle:async()=>({ok:true as const,data:{browser_action_session_handle:'host-session'},source_taint:'external' as const}) };
 const outputs: any[] = [];let step=0;
 await runToolLoop({ handlers: [handler,action], ctx, maxSteps: 4, onTool: event => { outputs.push(JSON.parse(event.output.split("\n")[0]!)); allowed = false; }, step: async tools => tools ? { text: '', tool_calls: [{ call_id: crypto.randomUUID(), name: ++step===2?'browse_act':'browse_page', arguments: step===2?JSON.stringify({url:'https://example.com/a',task:'Act',command:{operation:'scroll',delta:400,intent:'read'}}):args }] } : { text: 'Done' } });
 expect(handle).toHaveBeenCalledTimes(2);
 expect(outputs[2]).toMatchObject({ ok: false, error: 'Owner revoked' });
 expect(outputs[3]).toEqual(outputs[2]);
});

for (const actionSession of ['host-session','other-session',null]) it(`only completed action in matching retained session unlocks a duplicate: ${actionSession}`,async()=>{
 const read=vi.fn(async()=>({ok:true as const,data:{session_handle:'host-session'},source_taint:'external' as const}));
 const base={description:'Synthetic trusted handler',trigger_allowlist:triggerTypeSchema.options.filter(t=>TOOL_PERMISSIONS[t].includes('browse_page')),autonomy_gated:false};
 const handlers:ToolHandler<unknown,unknown,ToolDispatcherContext>[]=[{...base,name:'browse_page',schema:browsePageArgsSchema,handle:read},{...base,name:'browse_act',trigger_allowlist:triggerTypeSchema.options.filter(t=>TOOL_PERMISSIONS[t].includes('browse_act')),schema:browseActArgsSchema,mutates_state:true,handle:async()=>({ok:true,data:actionSession?{browser_action_session_handle:actionSession}:{stopped:'approval_pending'},source_taint:'external'})}];
 const outputs:any[]=[];let step=0;const budget={remaining:4};
 await runToolLoop({handlers,ctx,budget,maxSteps:6,onTool:e=>outputs.push(JSON.parse(e.output.split('\n')[0]!)),step:async tools=>tools?{text:'',tool_calls:[{call_id:crypto.randomUUID(),name:++step===2?'browse_act':'browse_page',arguments:step===2?JSON.stringify({url:'https://example.com/a',task:'Synthetic action',command:{operation:'scroll',delta:400,intent:'read'}}):args}]}:{text:'Done'}});
 expect(read).toHaveBeenCalledTimes(actionSession==='host-session'?2:1);
 expect(outputs[2].ok).toBe(actionSession==='host-session');expect(outputs[3]).toMatchObject({ok:false,code:'repeat_refusal'});expect(budget.remaining).toBe(0);
});
