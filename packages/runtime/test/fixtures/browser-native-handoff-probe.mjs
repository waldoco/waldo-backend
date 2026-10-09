// Native localhost login transport acceptance. Cloudflare protocol and viewer UI are doubles.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { chromium } = require(process.argv[2] ?? 'playwright');
const executablePath = process.argv[3]; if (!executablePath) throw Error('Local Chromium executable required');
const { cloudflareGeneralBrowser } = await import(process.argv[4] ? pathToFileURL(process.argv[4]).href : '../../src/channels/cloudflare-general-browser.ts');
const probeDeadline = Date.now() + 60000;
async function withinHarness(operation) {
  const remaining = probeDeadline - Date.now(); if (remaining <= 0) throw Error('Local fixture deadline exceeded');
  let timer;
  try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Local fixture deadline exceeded')), remaining); })]); }
  finally { clearTimeout(timer); }
}
const requests = [], connections = [], profile = await mkdtemp(join(tmpdir(), 'waldo-local-browser-session-'));
let rejectedOriginRequests=0;
const forbidden=createServer((request,response)=>{rejectedOriginRequests++;response.end('Forbidden origin');});
await new Promise(resolve=>forbidden.listen(0,'127.0.0.1',resolve));
const server=createServer(async(request,response)=>{
 requests.push(request.method+' '+request.url);response.setHeader('content-type','text/html');
 if(request.url==='/login')return response.end('<h1>Fictional sign in</h1><form method="POST" action="/password"><label>Password<input name="password" type="password"></label><button>Continue</button></form>');
 if(request.url==='/password'){
  let body='';for await(const part of request)body+=part;assert.equal(new URLSearchParams(body).get('password'),'LOCAL_FICTIONAL_PASSWORD');
  response.writeHead(303,{'location':'/otp','set-cookie':'login_stage=fictional; HttpOnly; SameSite=Strict; Path=/'});return response.end();
 }
 if(request.url==='/otp'){
  assert(request.headers.cookie?.includes('login_stage=fictional'));return response.end('<h1>Fictional MFA</h1><form method="POST" action="/complete"><label>One time code<input name="otp" inputmode="numeric"></label><button>Verify</button></form>');
 }
 if(request.url==='/complete'){
  let body='';for await(const part of request)body+=part;assert.equal(new URLSearchParams(body).get('otp'),'481516');assert(request.headers.cookie?.includes('login_stage=fictional'));
  response.writeHead(303,{'location':'/account','set-cookie':'signed_in=fictional_owner; HttpOnly; SameSite=Strict; Path=/'});return response.end();
 }
 if(request.url==='/account'){assert(request.headers.cookie?.includes('signed_in=fictional_owner'));return response.end('<h1>Signed in as fictional intended owner</h1><label>Account note<input value="Fresh owner account"></label>');}
 if(request.url==='/blocked-redirect'){response.writeHead(303,{location:`http://127.0.0.1:${forbidden.address().port}/outside`});return response.end();}
 response.writeHead(404);response.end('Missing fixture');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let processHandle, processExit;
// This watchdog controls only the synthetic local process, not provider/task budgets.
const watchdog = setTimeout(() => processHandle?.kill('SIGKILL'), Math.max(0, probeDeadline - Date.now()));
try {
  processHandle = spawn(executablePath, ['--headless', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions','--disable-component-extensions-with-background-pages','--disable-features=MediaRouter', '--disable-sync', '--metrics-recording-only', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  processExit = new Promise(resolve => processHandle.once('exit', resolve));
  await withinHarness(() => new Promise((resolve, reject) => {
    let stderr = '';
    const ready = data => { stderr += data.toString(); if (stderr.includes('DevTools listening on ws://')) { processHandle.stderr.off('data', ready); resolve(); } };
    processHandle.stderr.on('data', ready); processHandle.once('error', reject); processHandle.once('exit', () => reject(Error('Local Chromium exited before CDP readiness: '+stderr)));
  }));
  const [port, socketPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const endpoint = `http://127.0.0.1:${port}`, endpointSocket = `ws://127.0.0.1:${port}${socketPath}`, origin = `http://127.0.0.1:${server.address().port}`;
  const providerSessionId = 'local-owned-CDP', now = Date.now();
  const session = { id: 'local-owner-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId, contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: probeDeadline, updatedAt: now };
  const sessions = async () => {
    try { const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }); const version = await response.json(); return response.ok && version.webSocketDebuggerUrl === endpointSocket ? [{ sessionId: providerSessionId }] : []; }
    catch { return []; }
  };
  const listeners=new Set();let handoffActive=false,handoffCount=0,snapshots=0;
  const sdk={
   connect:async(_binding,options)=>{
    assert.deepEqual(options,{sessionId:providerSessionId,persistent:true});const connection=await withinHarness(()=>chromium.connectOverCDP(endpoint));connections.push(connection);
    const decorate=context=>{const nativeNew=context.newCDPSession.bind(context);
    context.newCDPSession=async page=>{const cdp=await nativeNew(page),nativeSend=cdp.send.bind(cdp),nativeOn=cdp.on.bind(cdp),nativeOff=cdp.off.bind(cdp);
     cdp.on=(event,fn)=>event==='Cloudflare.handoffComplete'?(listeners.add(fn),cdp):nativeOn(event,fn);
     cdp.off=(event,fn)=>event==='Cloudflare.handoffComplete'?(listeners.delete(fn),cdp):nativeOff(event,fn);
     cdp.send=async(method,args)=>{
      if(method==='Cloudflare.getSessionId')return {sessionId:providerSessionId};
      if(method==='Cloudflare.handoff'){assert.equal(listeners.size,1);handoffActive=true;handoffCount++;return {targetId:args.targetId,handoffId:'fictional-native-handoff'};}
      if(method==='Cloudflare.getHandoffState')return {active:handoffActive,handoffId:'fictional-native-handoff'};
      if(method==='Cloudflare.getLiveView')return {id:args.targetId,devtoolsFrontendUrl:'https://live.browser.run/ui/view?mode=tab&wss=FICTIONAL_LOCAL_ONLY'};
      if(method==='Accessibility.getFullAXTree')snapshots++;return nativeSend(method,args);
     };return cdp;};return context;};
    decorate(connection.contexts()[0]);const nativeContext=connection.newContext.bind(connection);connection.newContext=async options=>decorate(await nativeContext(options));
    return connection;
   },sessions,acquire:async()=>{throw Error('No allocation allowed');}
  };
  let turnAdmitted=true,ownerCurrent=true,allocations=0;
  const driver=cloudflareGeneralBrowser({ownerId:session.ownerId,binding:{},loadSdk:async()=>sdk,publicRead:true,retainConnection:true,now:Date.now,deadline:()=>session.expiresAt,
   admit:async()=>{if(!turnAdmitted)throw Error('Model turn closed');},maxScreenshotBytes:1024*1024,
   authorizeRequest:async(url,method)=>new URL(url).origin===origin&&method==='GET',
   authorizeHumanRequest:async(url,_method)=>ownerCurrent&&new URL(url).origin===origin});
  const first=await driver.navigate(session,origin+'/login'),beforeSnapshots=snapshots;
  const held=await driver.beginOwnerHandoff(session,first,'Sign in to fictional owner and complete MFA',async()=>{if(!ownerCurrent)throw Error('Owner revoked');});
  turnAdmitted=false;
  await assert.rejects(driver.observe(session));assert.equal(snapshots,beforeSnapshots);
  const page=connections.at(-1).contexts().flatMap(context=>context.pages()).find(page=>page.url()===origin+'/login');
  process.stderr.write('phase: password POST\n');
  await page.getByLabel('Password').fill('LOCAL_FICTIONAL_PASSWORD');await page.getByRole('button',{name:'Continue'}).click();await page.waitForURL(origin+'/otp');
  process.stderr.write('phase: OTP POST\n');
  await page.getByLabel('One time code').fill('481516');await page.getByRole('button',{name:'Verify'}).click();await page.waitForURL(origin+'/account');await page.getByRole('heading',{name:'Signed in as fictional intended owner'}).waitFor();await page.waitForLoadState('load');
  assert.equal(await held.controller.origin(),origin);assert.equal(snapshots,beforeSnapshots);
  handoffActive=false;for(const listener of listeners)listener({targetId:first.targetId,handoffId:held.handoffId,success:true});
  process.stderr.write('phase: resume\n');
  turnAdmitted=true;let committed=false;await held.controller.resume(()=>{committed=true;});assert(committed);
  const fresh=await driver.finishOwnerHandoff(session,first.observation.tab_ref);assert(fresh.observation.text.includes('Signed in as fictional intended owner'));
  assert.notEqual(fresh.observation.revision,first.observation.revision);assert(!JSON.stringify(fresh).includes('LOCAL_FICTIONAL_PASSWORD'));assert(!JSON.stringify(fresh).includes('481516'));
  assert.equal(handoffCount,1);assert.equal(allocations,0);
  // A second explicit handoff exercises native redirect custody without real login.
  process.stderr.write('phase: rejected redirect\n');
  const second=await driver.beginOwnerHandoff(session,fresh,'Check fictional redirect rejection',async()=>{if(!ownerCurrent)throw Error('Owner revoked');});
  turnAdmitted=false;try{await page.goto(origin+'/blocked-redirect',{timeout:3000});}catch{}
  assert.equal(rejectedOriginRequests,0,'Human redirect must not cross the already authorized origin');
  process.stderr.write('phase: cleanup\n');
  ownerCurrent=false;await driver.disconnect();
  const physicalClosure=processExit;let initialCleanupConfirmed=true;
  try{await withinHarness(()=>driver.terminate(session));}catch(error){assert.equal(error.code,'cleanup_unconfirmed');initialCleanupConfirmed=false;}
  await withinHarness(()=>physicalClosure);await driver.terminate(session);assert.deepEqual(await sessions(),[]);assert(connections.every(connection=>!connection.isConnected()));
  process.stdout.write(JSON.stringify({localOnly:true,cloudflareProtocolAndUi:'double',nativeDomInputPost303Cookies:true,passwordAndOtpAbsentAgentEvidence:true,noSnapshotsDuringTakeover:true,freshAccountEvidence:true,blockedCrossOriginRedirect:true,providerAllocations:allocations,exactProcessExit:true,initialCleanupConfirmed})+'\n');
} finally { clearTimeout(watchdog); if (processHandle?.pid && processHandle.exitCode === null) { processHandle.kill('SIGKILL'); await processExit; } await new Promise(resolve => server.close(resolve));await new Promise(resolve=>forbidden.close(resolve)); await rm(profile, { recursive: true, force: true }); }
