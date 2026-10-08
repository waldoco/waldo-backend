import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {TelegramOwnerDO} from '../src/channels/telegram-owner-do';
import {consoleAccess,CONSOLE_COOKIE} from '../src/channels/console';
const proof=vi.hoisted(()=>({owner:'10000000-0000-0000-0000-000000000091',digest:'a'.repeat(64),present:true,receipt:true,sends:[] as any[],deliver:undefined as undefined|((owner:string,url:string)=>Promise<void>)}));
vi.mock('openai',()=>({default:class{responses={create:async()=>{throw Error('Synthetic test forbids model transport');}};}}));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:proof.owner,custodyDigest:proof.digest}),assertCurrent:async(owner:any)=>{if(owner.directoryOwnerId!==proof.owner||owner.custodyDigest!==proof.digest)throw Error('changed');}})}));
vi.mock('../src/channels/owner-browser-runtime',async load=>{const real=await load<typeof import('../src/channels/owner-browser-runtime')>();return {...real,ownerBrowserRuntime:(options:any)=>{proof.deliver=options.privateBrowser?.deliverToOwner;return real.ownerBrowserRuntime(options);}};});
vi.mock('../src/identity/console-auth',async load=>({...await load<typeof import('../src/identity/console-auth')>(),presenceRecheck:()=>async()=>proof.present}));
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string,payload:any)=>{if(method==='sendMessage'){proof.sends.push(payload);return {message_id:1,chat:{id:payload.chat_id,type:proof.receipt?'private':'group'},reply_markup:payload.reply_markup};}return method==='getMe'?{username:'synthetic_browser_bot'}:true;}}));
it('authenticated ownerDO exposes dark registered consent and checks its owner-only handoff receipt',async()=>{
 const name='private-browser-console-'+crypto.randomUUID(),namespace=env.TELEGRAM_OWNER_DO!,id=namespace.idFromName(name);proof.present=true;proof.receipt=true;proof.sends=[];proof.owner='10000000-0000-0000-0000-000000000091';
 await runInDurableObject(namespace.get(id),async(_instance,state)=>{
  state.storage.kv.put('do_name',name);state.storage.kv.put('telegram_subject','81191');
  const cfg={...env,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'fixture',TELEGRAM_BOT_TOKEN:'123:synthetic',OPENAI_API_KEY:'synthetic',WALDO_TOOL_OFFLOAD:'0'};
  const policy={siteOrigin:'https://synthetic.example',accountId:'Actual account',expiresAt:Date.now()+600000,sitePolicy:{origins:['https://synthetic.example'],cookieDomains:['synthetic.example']},allowedDomains:['synthetic.example'],verifyAccount:async()=>false,signIn:{instructions:'Complete synthetic sign-in',prepare:async()=>{throw Error('No provider allowed');}}};
  const instance=new TelegramOwnerDO(state,cfg,undefined,undefined,policy as never);
  const url='https://owner.invalid/console/browser/saved';expect((await instance.fetch(new Request(url))).status).toBe(401);
  const access=consoleAccess(state.storage),link=await access.mintLink('https://owner.invalid'),cookie=await access.redeem(new URL(link).searchParams.get('t')!),session=(await access.session(cookie!))!;
  const request=(body?:object,html=false)=>new Request(url,{headers:{cookie:`${CONSOLE_COOKIE}=${cookie}`,...(body?{'content-type':'application/json'}:{}),...(html?{accept:'text/html'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  const page=await instance.fetch(request(undefined,true));expect(await page.text()).toContain('Actual account');
  const proposal=await(await instance.fetch(request())).json() as any;expect(proposal.site).toBe(policy.siteOrigin);
  expect((await instance.fetch(request({action:'confirm',nonce:proposal.nonce,csrf:'wrong'}))).status).toBe(403);
  expect((await instance.fetch(request({action:'confirm',nonce:proposal.nonce,csrf:session.csrf}))).status).toBe(200);
  expect((await instance.fetch(request({action:'confirm',nonce:proposal.nonce,csrf:session.csrf}))).status).toBe(409);
  expect(proof.deliver).toBeTypeOf('function');await proof.deliver!(proof.owner,'https://live.browser.run/?synthetic-bearer');
  expect(proof.sends).toHaveLength(1);expect(proof.sends[0].text).not.toContain('synthetic-bearer');expect(proof.sends[0]).toMatchObject({chat_id:81191,link_preview_options:{is_disabled:true}});
  proof.receipt=false;await expect(proof.deliver!(proof.owner,'https://live.browser.run/?synthetic-bearer')).rejects.toThrow('delivery unconfirmed');
  const prior=proof.sends.length;proof.present=false;await expect(proof.deliver!(proof.owner,'https://live.browser.run/?synthetic-bearer')).rejects.toThrow();expect(proof.sends).toHaveLength(prior);
  proof.present=true;await expect(proof.deliver!('foreign','https://live.browser.run/?synthetic-bearer')).rejects.toThrow();expect(proof.sends).toHaveLength(prior);
  state.storage.kv.put('telegram_unlinked',true);await expect(proof.deliver!(proof.owner,'https://live.browser.run/?synthetic-bearer')).rejects.toThrow();expect(proof.sends).toHaveLength(prior);
  await state.storage.deleteAlarm();
 });
});


it('ordinary two-argument staging ownerDO leaves private custody dark without provider or Vault I/O',async()=>{
 const name='private-browser-dark-'+crypto.randomUUID(),namespace=env.TELEGRAM_OWNER_DO!,id=namespace.idFromName(name);
 await runInDurableObject(namespace.get(id),async(_instance,state)=>{
  state.storage.kv.put('do_name',name);state.storage.kv.put('telegram_subject','81191');
  const instance=new TelegramOwnerDO(state,{...env,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:'fixture'});
  const access=consoleAccess(state.storage),cookie=await access.grant();
  const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Dark private custody forbids network');});
  try{
   expect((await instance.fetch(new Request('https://owner.invalid/console/browser/saved',{headers:{cookie:`${CONSOLE_COOKIE}=${cookie}`}}))).status).toBe(404);
   expect(network).not.toHaveBeenCalled();expect(proof.deliver).toBeUndefined();
   expect([...state.storage.kv.list({prefix:'private-browser-owner/'})]).toHaveLength(0);
  }finally{network.mockRestore();await state.storage.deleteAlarm();}
 });
});
