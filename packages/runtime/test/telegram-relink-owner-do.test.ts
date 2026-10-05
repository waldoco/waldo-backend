import { HELDROWS_SCAN_BUDGET, HARNESS_MESSAGE_LIMIT, heldRowShapes } from '../src/memory/held-rows';
import { likePrefilter, projectionPredicate } from '../src/memory/claims';
import { parseHarnessCommand } from '../src/channels/harness';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import { updateBook } from '../src/channels/update-cards';
import { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { loopBook, loopHandlers } from '../src/channels/loops';
import { redactConversationEntries, durableConversationStore } from '../src/channels/conversation-store';
import { episodeIndex } from '../src/channels/episodes';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';
import { capToolOutput } from '../src/conversation/tool-loop';
import { readToolOutputHandler } from '../src/tools/read-tool-output';
import { webSearchArgsSchema } from '@waldo/contracts';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';

// Real registered two-argument owner DO and its fenced inbox/listener/responder path.
// Only the model SDK and Telegram transport are scripted. No live provider or source service.
const seen = vi.hoisted(() => ({ writer: '{}', requests: [] as unknown[], fetches: [] as string[], replyText: 'Recorded fixture response.', reasoning: undefined as string | undefined, toolSuppliers: [] as (() => Promise<readonly import('../src/context-composer/types').ContextFragment[]>)[], offloads: [] as import('../src/conversation/tool-output-store').ToolOutputStore[], selectorThrows: false, selectedText: undefined as string | undefined, selectedTexts: [] as string[], selectorInputs: [] as string[], selectorCalls: [] as unknown[], failCleanup: false, onCleanup: undefined as undefined | (() => void), selectorOutputMessage: false, selectorMode: 'normal' as 'normal' | 'empty' | 'invalid' | 'missing-ref' | 'capped', onSelector: undefined as undefined | (() => void), onReply: undefined as undefined | (() => unknown[] | undefined | Promise<unknown[] | undefined>) }));
vi.mock('../src/run-loop/adapters', async load => {
 const actual = await load<typeof import('../src/run-loop/adapters')>();
 return { ...actual, resolveRunLoopAdapters: (...args: Parameters<typeof actual.resolveRunLoopAdapters>) => {
  if (args[1]?.toolOutputs) seen.toolSuppliers.push(args[1].toolOutputs);
  return actual.resolveRunLoopAdapters(...args);
 } };
});
vi.mock('../src/conversation/tool-output-store', async load => {
  const real = await load<typeof import('../src/conversation/tool-output-store')>();
  return { ...real, inMemoryToolOutputStore: () => { const store = real.inMemoryToolOutputStore(); seen.offloads.push(store); return store; } };
});
vi.mock('../src/channels/conversation-store', async load => {
  const actual = await load<typeof import('../src/channels/conversation-store')>();
  return { ...actual, redactConversationEntries: async (...args: Parameters<typeof actual.redactConversationEntries>) => {
    if (seen.failCleanup) throw new Error('Synthetic retained cleanup unavailable');
    const receipt = await actual.redactConversationEntries(...args);
    seen.onCleanup?.();
    return receipt;
  } };
});
vi.mock('../src/channels/telegram-api', async (load) => ({
  ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'fixture_bot' }
    : method === 'sendMessage' ? { message_id: 1, chat: { id: 42 } } : true,
}));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const name = (body as { text?: { format?: { name?: string } } }).text?.format?.name;
  if (!name) seen.requests.push(body);
  const output = !name ? await seen.onReply?.() ?? [] : [];
  let selection = '{}';
  if (name === 'forget_source_spans') {
    seen.selectorCalls.push(body);
    if (seen.selectorThrows) throw new Error('Synthetic selector unavailable');
    const input = (body as { input: string }).input; seen.selectorInputs.push(input);
    const supplied = JSON.parse(input.slice(input.indexOf('{'))) as { sources: Array<{ ref: string; text: string }> };
    seen.onSelector?.();
    const texts = [...seen.selectedTexts, ...(seen.selectedText ? [seen.selectedText] : [])];
    const spans = supplied.sources.flatMap(row => texts.filter(text => row.text.includes(text)).map(text => ({ ref: row.ref, text })));
    selection = seen.selectorMode === 'empty' ? '' : seen.selectorMode === 'invalid' ? '{invalid' : JSON.stringify({ complete: !!texts.length, reviewed_refs: supplied.sources.map(row => row.ref), spans: seen.selectorMode === 'missing-ref' ? spans.slice(1) : seen.selectorMode === 'capped' ? spans.slice(0, 32) : spans });
  }
  if (name === 'forget_source_spans' && seen.selectorOutputMessage) output.push({type:'message',id:'fixture-selector',role:'assistant',status:'completed',content:[{type:'output_text',text:selection,annotations:[]}]});
  if (!name && seen.reasoning) output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: seen.reasoning }] });
  return { id: 'local-fixture', output_text: name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : name === 'claim_ops' ? seen.writer
    : name === 'forget_source_spans' ? selection : name === 'reaction' ? '{"reaction":null}' : seen.replyText, output,
    usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));

const directoryState=vi.hoisted(()=>({linked:new Map<string,string>(),target:'',sends:[] as any[]}));
vi.mock('../src/identity/owner-directory',async load=>({...await load<typeof import('../src/identity/owner-directory')>(),ownerDirectory:()=>({byPresence:async (_p:string,s:string)=>directoryState.linked.has(s)?{doName:directoryState.linked.get(s),subject:s}:null,redeemHashed:async (_p:string,s:string)=>{directoryState.linked.set(s,directoryState.target);return {kind:'redeemed'};}})}));
vi.mock('../src/identity/console-auth',async load=>({...await load<typeof import('../src/identity/console-auth')>(),consoleAuth:()=>({assertChannelPresence:async(n:string,_p:string,s:string)=>directoryState.linked.get(s)===n,saveSettings:async()=>true,unlinkTelegram:async(n:string)=>{for(const [subject,name] of directoryState.linked)if(name===n)directoryState.linked.delete(subject);return true;},listSessions:async()=>[]})}));
// Replace only transport capture, never the registered owner DO or its inbox/listener/outbox.
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(m:string,p:any)=>{directoryState.sends.push({m,p});return m==='getMe'?{username:'fixture_bot'}:m==='sendMessage'?{message_id:directoryState.sends.length,chat:{id:p.chat_id}}:true;}}));
const {handleTelegramWebhook}=await import('../src/channels/telegram-webhook');
const {ownerDirectory}=await import('../src/identity/owner-directory');
const raw=(subject:number,id:number,text:string)=>JSON.stringify({update_id:id,message:{message_id:id,from:{id:subject,is_bot:false},chat:{id:subject,type:'private'},text}});
const webhook=async(subject:number,id:number,text:string)=>handleTelegramWebhook(new Request('https://fixture.invalid/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET!},body:raw(subject,id,text)}),env,()=>{},ownerDirectory(env));
const boot=async(name:string)=>runInDurableObject(stub(name),async(instance,state)=>{
 const token=await (await instance.fetch!(new Request('https://owner/grant-console',{method:'POST',headers:{'x-waldo-do-name':name}}))).text();
 const r=await instance.fetch!(new Request('https://owner/console/connections',{headers:{cookie:`${CONSOLE_COOKIE}=${token}`}}));expect(r.status).toBe(200);
 await state.storage.deleteAlarm();
});
const link=async(name:string,subject:number,id:number)=>{
 directoryState.target=name;directoryState.linked.delete(String(subject));expect((await webhook(subject,id,'/link ABCDEFGHJK')).status).toBe(200);
 await runInDurableObject(stub(`telegram-link:7:${subject}`),async(instance,state)=>{await instance.alarm!();await instance.alarm!();await state.storage.deleteAlarm();});
 expect(directoryState.linked.get(String(subject))).toBe(name);
};
const drain=async(name:string,id:number)=>runInDurableObject(stub(name),async(instance,state)=>{
 const inbox=new TelegramOwnerInbox(state.storage,persistInboxWake);
 for(let n=0;n<4;n++){const finals=state.storage.kv.get<any[]>('telegram_final_outbox_v1')??[];for(const f of finals)if(f.status==='pending')f.dueAt=0;state.storage.kv.put('telegram_final_outbox_v1',finals);await instance.alarm!();}
 const row=(await inbox.records()).find(r=>r.updateId===id);await state.storage.deleteAlarm();return row;
});
const stub=(name:string)=>env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
beforeEach(()=>{seen.requests.length=0;seen.onReply=undefined;directoryState.sends.length=0;vi.stubGlobal('fetch',()=>{throw Error('network forbidden');});});
afterEach(()=>vi.unstubAllGlobals());
it.each(['console-first','telegram-first','preexisting','eviction'])('ADV registered full webhook/link/owner/inbox/alarm pipeline %s',async(mode)=>{
 const subject=85001+['console-first','telegram-first','preexisting','eviction'].indexOf(mode),name=`adv-${mode}`;
 if(mode!=='telegram-first'&&mode!=='preexisting')await boot(name);
 await link(name,subject,subject);
 if(mode==='preexisting')await runInDurableObject(stub(name),async(instance,state)=>{state.storage.kv.put('telegram_subject',String(subject));state.storage.kv.put('do_name',name);await (instance as any).setup().ready;await state.storage.deleteAlarm();});
 if(mode==='eviction')await evictDurableObject(stub(name));
 expect((await webhook(subject,subject+100,'Test ordinary turn')).status).toBe(200);
 expect((await drain(name,subject+100))?.reason).toBe('delivery_ack');
 expect(seen.requests.length).toBeGreaterThan(0);
 expect(directoryState.sends.some(r=>r.m==='sendMessage'&&r.p.chat_id===subject&&r.p.text==='Recorded fixture response.')).toBe(true);
});
it.each([false,true])('ADV unlink then relink changed=%s',async(changed)=>{
 const name=`adv-relink-${changed}`,first=changed?88001:89001,next=changed?88002:89001;
 await boot(name);await link(name,first,first);await webhook(first,first+100,'Initial');expect((await drain(name,first+100))?.reason).toBe('delivery_ack');
 await runInDurableObject(stub(name),async(instance,state)=>{const token=await consoleAccess(state.storage).grant();const session=(await consoleAccess(state.storage).session(token))!;const form=new FormData();form.set('csrf',session.csrf);form.set('action','telegram.unlink');const result=await instance.fetch!(new Request('https://owner/console/action',{method:'POST',headers:{cookie:`${CONSOLE_COOKIE}=${token}`},body:form}));expect(result.status).toBe(303);expect(state.storage.kv.get('telegram_unlinked')).toBe(true);});
 await link(name,next,first+200);expect((await webhook(next,first+300,'Relinked')).status).toBe(200);expect((await drain(name,first+300))?.reason).toBe('delivery_ack');
});
it('ADV runtime switch is atomic and old subject turn is fenced after rebind',async()=>{
 const name='adv-concurrent';directoryState.linked.set('87001',name);await webhook(87001,87001,'Old owner turn');
 let old:any;
 seen.onReply=async()=>{await runInDurableObject(stub(name),async(instance,state)=>{old=(instance as any).setup();state.storage.kv.put('telegram_subject','87002');directoryState.linked.delete('87001');directoryState.linked.set('87002',name);const next=(instance as any).setup();expect(next).not.toBe(old);expect(old.owner).toBe(87001);expect(next.owner).toBe(87002);await next.ready;});return [];};
 const row=await drain(name,87001);expect(row?.state).toBe('quarantined');expect(directoryState.sends.filter(r=>r.m==='sendMessage'&&r.p.text==='Recorded fixture response.')).toEqual([]);
 seen.onReply=undefined;await webhook(87002,87002,'New owner turn');expect((await drain(name,87002))?.reason).toBe('delivery_ack');
});
