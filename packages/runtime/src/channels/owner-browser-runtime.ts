import {browserHandoffConsole} from './browser-handoff-console';
import { browsePageArgsSchema, browseActArgsSchema, WALDO_CHAT_MODEL, type BrowseActArgs, type BrowsePageArgs, type LLMAttachment, type ToolEligibility, type ToolHandler } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { TelegramWebhookEnv } from './telegram-webhook';
import { ClosedRunError, type RunEffectScope } from './run-effect-scope';
import { commonBrowserHost, maintainCommonBrowsers, revokeCommonBrowsers,fenceLostNativeHandoffs } from './common-browser-host';
import { commonPublicBrowserConfiguration, commonPublicBrowserConfigured } from './common-public-browser-configuration';
import { COMMON_TEST_CEILING_MICROUSD, commonBrowserSdk, commonStagingRegistration } from './common-staging-registration';
import { OpenAIResponsesAdapter } from '../llm/openai';
import { armAlarm } from '../scheduler/alarm-slot';
import { commonOwnerBrowserRegistration,CommonBrowserRegistrationUnavailable } from './common-owner-browser-registration';
import type { LLMGatewayAdapter } from '../llm/provider';
import { localOwnerBinding, ownerBindingCurrent, verifyOwnerBinding } from '../identity/owner-binding';
import { workspaceOwnerHost, workspaceMetadata } from './workspace-host';
import {cloudflarePublicRead,PublicReadRefusal,PUBLIC_READ_RESERVED_BROWSER_MS} from './cloudflare-public-read';
import {ordinaryPublicBrowserConfiguration} from './ordinary-public-browser-configuration';
import {OwnerPublicBrowserCeilingExceeded,reserveOwnerPublicBrowser} from './owner-public-browser-spend';
const browserFailureClass=(cause:unknown)=>cause instanceof CommonBrowserRegistrationUnavailable?'CommonBrowserRegistrationUnavailable':cause instanceof ClosedRunError?'ClosedRunError':cause instanceof TypeError?'TypeError':cause instanceof RangeError?'RangeError':cause instanceof SyntaxError?'SyntaxError':cause instanceof Error?'Error':'UnknownError';
const traceBrowserFailure=(operation:string,cause:unknown)=>console.warn(JSON.stringify({event:'owner_browser_failure',operation,error_class:browserFailureClass(cause)}));
// The spend ledger refuses a read that no retry can fund. The model is told so, and what to tell the owner.
const spendRefusal=(cause:unknown)=>{
  const ceiling=cause instanceof OwnerPublicBrowserCeilingExceeded;
  traceBrowserFailure(ceiling?'public_read_spend_ceiling':'public_read_spend_reconciliation',cause);
  return new PublicReadRefusal(ceiling
    ?'No browser was started: the owner\'s browser spend limit is used up. Retrying will not help; tell the owner browsing is paused until the limit allows more.'
    :'No browser was started: the owner\'s browser spend record needs reconciliation. Retrying will not help; tell the owner browsing is paused until it is reconciled.');
};

// A browser refusal the model can act on: it names the open session's handle and the ways forward.
class BrowserSessionRefusal extends Error {}
const heldElsewhere=(handle:string)=>`An interactive browser session from an earlier turn is still open (session_handle ${handle}). Continue it by passing that session_handle, or end it with browse_act command cancel and that session_handle, then start a new one. A read without retain_session works now.`;

// The run lease's wake: maintenance runs when the lease's run deadline, its configuration or its session lifetime ends,
// whichever comes first. It is a listed wake key, so an arbiter re-arm keeps it.
export const COMMON_BROWSER_LEASE_DUE='common_browser_lease_due_v1';

// The browser task follows the authenticated owner run. It needs no topic classifier
// or canonical execution activation; provider identity and budget stay in the DO.
export function ownerBrowserRuntime(options: Readonly<{
  env: TelegramWebhookEnv; storage: DurableObjectStorage; actualDoId: string;
  activeScope(): RunEffectScope | undefined;
  typedHost?(): boolean;
}>) {
  fenceLostNativeHandoffs(options.storage,Date.now());
  let active: { scope?: RunEffectScope; taskId:string; ownerId:string; host: ReturnType<typeof commonBrowserHost> } | undefined;
  let lease: Readonly<{scope?:RunEffectScope;deadline:number;assertCurrent():Promise<void>}>|undefined;
  const continuationKey='common-browser-current:v1';
  const retainedTask=()=>{
    const pointer=options.storage.kv.get<{taskId:string;sessionHandle:string}>(continuationKey);
    const row=pointer?options.storage.kv.get<{session:{id:string;state:string;expiresAt:number};cleanup?:string}>(`common-browser:${pointer.taskId}`):undefined;
    return pointer&&row&&!row.cleanup&&row.session.state==='active'&&row.session.id===pointer.sessionHandle&&row.session.expiresAt>Date.now()?pointer:undefined;
  };
  let maintenance:Promise<void>|undefined;
  const automatic = commonOwnerBrowserRegistration({ ...options, loadSdk: commonBrowserSdk() });
  const configuration = (cleanupOnly = false, normalRead = false) => {
    const registered = commonStagingRegistration(options.env, cleanupOnly || normalRead ? 'retained_read' : 'admission');
    if (normalRead && registered && registered.policy.expiresAt > Date.now() && registered.spend.policy.validUntil > Date.now()) commonStagingRegistration(options.env);
    return commonPublicBrowserConfiguration({ ...options, cleanupOnly, ...(registered ? {
      policy: registered.policy, spend: registered.spend, loadSdk: commonBrowserSdk(),
    } : {}) });
  };
  const selectedConfiguration = async (cleanupOnly = false, normalRead = false) => automatic.selected || automatic.hasRetained() ? automatic.configuration(cleanupOnly) : configuration(cleanupOnly, normalRead);
  // Browsing is offered only to an owner this object holds a binding for, since every browse call needs one. Then a held
  // session, or the enabled typed task host for browse_act, serves browsing; otherwise only the owner's Cloudflare host
  // does, on a staging Worker that registered its provider code and holds a browser binding. Browserbase keys never do.
  const cloudflareReady = () => options.env.WALDO_ENVIRONMENT === 'staging' && Boolean(options.env.BROWSER && (commonBrowserSdk() || commonPublicBrowserConfigured()));
  const eligibleWith = (typed = false) => (): ToolEligibility => binding() && (active || typed && options.typedHost?.() || cloudflareReady()) ? { ok: true } : { ok: false, reason: 'not_configured' };
  // The browser serves the owner bound to this physical object, through Telegram or the app; the directory confirms it.
  const binding = () => localOwnerBinding(options.storage.kv, options.env.OWNER_DO, options.actualDoId);
  const bound = (held: NonNullable<ReturnType<typeof binding>>) => ownerBindingCurrent(options.storage.kv, options.env.OWNER_DO, options.actualDoId, held);
  const assertOwner = async () => {
      const held = binding();
      if (!held) throw new ClosedRunError();
      const owner = await verifyOwnerBinding(options.env, held, options.actualDoId, options.env.OWNER_DO);
      if (!bound(held) || !owner) throw new ClosedRunError(); return { directoryOwnerId: owner.directoryOwnerId, custodyDigest: owner.custodyDigest };
    };
  const current = (ctx: ToolDispatcherContext) => {
    const scope = options.activeScope(), supplied = ctx.runScope, held = binding();
    // Hooks copy the context object, but retain these host-created functions.
    if (!scope || !supplied || supplied.runId !== scope.runId || supplied.attempt !== scope.attempt
      || supplied.deadline !== scope.deadline || supplied.admit !== scope.admit || supplied.commit !== scope.commit
      || !held || !ctx.authenticatedUserId) throw new ClosedRunError();
    return async () => {
      scope.admit();
      if (options.activeScope() !== scope || !bound(held)) throw new ClosedRunError();
      scope.admit();
    };
  };
  const commonFiles=async(assertCurrent:()=>Promise<void>,ownerId:string)=>{
    const scope=options.activeScope(),doName=options.storage.kv.get<string>('do_name');if(!doName)throw new ClosedRunError();
    const admit=async()=>{await assertCurrent();scope?.admit();if(scope&&options.activeScope()!==scope||options.storage.kv.get('do_name')!==doName)throw new ClosedRunError();const owner=await assertOwner();if(ownerId!==owner.directoryOwnerId&&ownerId!==`prn_${owner.directoryOwnerId.replaceAll('-','')}`)throw new ClosedRunError();const bound=workspaceMetadata(options.storage,scope).transaction(state=>state.binding);if(bound&&bound.ownerId!==owner.directoryOwnerId)throw new ClosedRunError();await assertCurrent();};
    await admit();const workspace=await workspaceOwnerHost(options.env,options.storage,options.actualDoId,doName,fetch,scope,admit);await admit();const origin=options.storage.kv.get<string>('origin');if(!origin)throw new ClosedRunError();return {workspace,origin};
  };
  const bindHost=async(ctx:ToolDispatcherContext,sessionHandle?:string,retainSession=false)=>{
    const assertCurrent=current(ctx);await assertCurrent();
    const scope=options.activeScope()!,pointerBefore=retainedTask();
    const ordinary=!!options.storage.kv.get(`ordinary-public-browser-grant:${sessionHandle?pointerBefore?.taskId??active?.taskId:active?.taskId??scope.runId}`);
    let config;
    if(!ordinary){try{config=await selectedConfiguration(false,retainSession);}catch(cause){if(!retainSession||!(cause instanceof CommonBrowserRegistrationUnavailable))throw cause;}}
    let expiredSpend=false;
    if(options.env.COMMON_BROWSER_REGISTRATION)expiredSpend=JSON.parse(options.env.COMMON_BROWSER_REGISTRATION).spend?.validUntil<=Date.now();
    if(ordinary||retainSession&&(!config||config.expiresAt<=Date.now()||expiredSpend)){
      const sdk=commonBrowserSdk();if(options.env.WALDO_ENVIRONMENT!=='staging'||!options.env.BROWSER||!sdk)throw new ClosedRunError();
      const owner=await assertOwner();await assertCurrent();
      config=ordinaryPublicBrowserConfiguration({storage:options.storage,binding:options.env.BROWSER,loadSdk:sdk,owner:{ownerId:`prn_${owner.directoryOwnerId.replaceAll('-','')}`,custodyDigest:owner.custodyDigest},deadline:scope.deadline,now:Date.now,assertCurrent:async()=>{const admitted=lease;if(!admitted)throw new ClosedRunError();await admitted.assertCurrent();if(lease!==admitted)throw new ClosedRunError();},
        declaredLimitMicrousd:options.env.COMMON_BROWSER_REGISTRATION?JSON.parse(options.env.COMMON_BROWSER_REGISTRATION).spend?.limitMicrousd:undefined,
        assertOwner:async()=>{const fresh=await assertOwner();return {ownerId:`prn_${fresh.directoryOwnerId.replaceAll('-','')}`,custodyDigest:fresh.custodyDigest};}});
    }
    await assertCurrent();
    if(!config)throw new ClosedRunError();
    if(active&&options.storage.kv.get<{cleanup?:string}>(`common-browser:${active.taskId}`)?.cleanup==='closed'){active=undefined;lease=undefined;options.storage.kv.put(continuationKey,null);}
    const pointer=retainedTask();
    // The run that holds the session may name it before its first read succeeds; other runs only through the published pointer.
    if(sessionHandle&&pointer?.sessionHandle!==sessionHandle&&(active?.scope!==scope||active.host.sessionHandle()!==sessionHandle))throw new BrowserSessionRefusal(pointer?heldElsewhere(pointer.sessionHandle):'That session_handle is not an open browser session. Start a new one with retain_session:true and no session_handle, or read without retain_session.');
    if(active){
      if(active.ownerId!==config.ownerId)throw new ClosedRunError();
      if(active.scope&&active.scope!==scope)throw new BrowserSessionRefusal('The browser is still in use by an earlier turn that is finishing. Try again shortly, or read without retain_session.');
      if(active.scope!==scope&&active.host.sessionHandle()!==sessionHandle){
        if(pointer?.taskId===active.taskId)throw new BrowserSessionRefusal(heldElsewhere(pointer.sessionHandle));
        // A finished turn's session whose first read never succeeded: no handle for it was ever published, so end it and start fresh.
        const stale=active;active=undefined;lease=undefined;
        try{await stale.host.cancel();}catch{/* its row keeps the cleanup obligation; maintenance owns it */}
      }
    }
    if(active)active.scope=scope;
    else{
      const taskId=sessionHandle?pointer!.taskId:scope.runId,initialAttempt=scope.attempt;
      active={scope,taskId,ownerId:config.ownerId,host:commonBrowserHost({storage:options.storage,config:{...config,retainInteractions:true},ownerId:config.ownerId,egressAllowlist:ctx.egressAllowlist,
        source:()=>({taskId,revision:1,sources:['browser'],ready:true,startRef:initialAttempt}),
        files:commonFiles,
        assertCurrent:async()=>{const admitted=lease;if(!admitted)throw new ClosedRunError();await admitted.assertCurrent();if(lease!==admitted)throw new ClosedRunError();},
        deadline:()=>lease?.deadline??0,now:Date.now})};
    }
    lease={scope,deadline:scope.deadline,assertCurrent};
    options.storage.kv.put(`common-browser-run:${scope.runId}`,active.taskId);
    const wake=Math.min(scope.deadline,config.expiresAt,Date.now()+config.lifetimeMs),prior=await options.storage.getAlarm();
    options.storage.kv.put(COMMON_BROWSER_LEASE_DUE,wake);
    await armAlarm(options.storage,Math.max(Date.now()+250,prior===null?wake:Math.min(prior,wake)));await assertCurrent();
    return {active,context:{...ctx,authenticatedUserId:config.ownerId,assertTaskSourceCurrent:assertCurrent}};
  };
  const publishPointer=()=>{const handle=active?.host.sessionHandle();if(active&&handle)options.storage.kv.put(continuationKey,{taskId:active.taskId,sessionHandle:handle});};
  const funded=(scope:RunEffectScope)=>active?.scope===scope||options.storage.kv.get(`common-browser:${scope.runId}`)!==undefined||options.storage.kv.get(`common-browser-run:${scope.runId}`)!==undefined;
  return {
    current,
    consoleHandoff(request:Request,csrf:string,assertSession:()=>Promise<void>){
      const held=active;
      const admit=async()=>{await assertSession();if(held){const owner=await assertOwner();await assertSession();if(active!==held||held.ownerId!==`prn_${owner.directoryOwnerId.replaceAll('-','')}`&&held.ownerId!==owner.directoryOwnerId)throw new ClosedRunError();}};
      return browserHandoffConsole(request,{csrf,ownerScope:options.actualDoId,limiter:options.env.RESPONSIBILITY_RATE_LIMITER,assertConsole:admit,
        status:async()=>held?.host.handoffStatus(),open:async()=>{if(!held)throw new ClosedRunError();return held.host.openHandoff();},cancel:async()=>{if(!held)throw new ClosedRunError();await held.host.cancel();}});
    },
    guard<T>(handler: ToolHandler<T, unknown, ToolDispatcherContext>, principal?: () => string): ToolHandler<T, unknown, ToolDispatcherContext> {
      return { ...handler, async handle(args, ctx) {
        try {
          const assertCurrent = current(ctx); await assertCurrent();
          return await handler.handle(args, { ...ctx, assertTaskSourceCurrent: assertCurrent,
            ...(principal ? { authenticatedUserId: principal() } : {}) });
        } catch { return { ok: false, code: 'rejected', error: 'The browser owner run is no longer current.', source_taint: 'external' }; }
      } };
    },
    read(fallback: ToolHandler<BrowsePageArgs, unknown, ToolDispatcherContext>): ToolHandler<BrowsePageArgs, unknown, ToolDispatcherContext> {
      return { ...fallback, eligible: eligibleWith(), schema: browsePageArgsSchema, description: fallback.description+' For interactive tasks use retain_session:true to receive DOM/accessibility, a PNG and session_handle, then call browse_act with that handle and current refs. Omit for a one-shot read.', async handle(args, ctx) {
        try {
          const assertCurrent = current(ctx); await assertCurrent();
          // The run holding an open journey keeps it: an omitted handle must not quietly leave its unsent page state behind.
          // A session held by another turn never blocks this one; the read below names it instead.
          const journey=retainedTask(),held=journey&&options.storage.kv.get(`ordinary-public-browser-grant:${journey.taskId}`)?journey:undefined;
          if(!args.session_handle&&!args.retain_session&&held&&active&&active.scope===options.activeScope()&&active.taskId===held.taskId)return {ok:false,code:'rejected',error:`This turn has an interactive browser session open (session_handle ${held.sessionHandle}). Read its current page with that session_handle, or end it with browse_act command cancel and that session_handle before a read without retain_session.`,source_taint:'external'};
          // A normal fresh public read does not require a paid-test registration.
          // Retained session handles still select their existing exact-session host.
          if(!args.session_handle&&!args.retain_session){
            let retainedConfiguration;
            try{retainedConfiguration=await selectedConfiguration(false, true);}catch(cause){traceBrowserFailure('public_read_configuration',cause);if(!(cause instanceof CommonBrowserRegistrationUnavailable))throw cause;}
            let expiredSpend=false;
            if(options.env.COMMON_BROWSER_REGISTRATION){try{expiredSpend=JSON.parse(options.env.COMMON_BROWSER_REGISTRATION).spend?.validUntil<=Date.now();}catch(cause){traceBrowserFailure('public_read_registration',cause);/* invalid descriptor is checked before reservation */}}
            if(!retainedConfiguration||retainedConfiguration.expiresAt<=Date.now()||expiredSpend){
              const sdk=commonBrowserSdk();
              if(options.env.WALDO_ENVIRONMENT!=='staging'||!options.env.BROWSER||!sdk)return {ok:false,code:'auth_failed',error:'The selected Cloudflare browser provider is unavailable.',source_taint:'external'};
              const owner=await assertOwner();await assertCurrent();
              const ownerId=`prn_${owner.directoryOwnerId.toLowerCase().replaceAll('-','')}`;
              // The ordinary owner loop carries its trusted local principal.
              // Browser custody comes from this physical host's live directory,
              // never from model arguments or a trial-only invocation principal.
              const assertReadCurrent=async()=>{await assertCurrent();const fresh=await assertOwner();await assertCurrent();if(fresh.directoryOwnerId!==owner.directoryOwnerId||fresh.custodyDigest!==owner.custodyDigest)throw new ClosedRunError();};
              const read=cloudflarePublicRead({binding:options.env.BROWSER,loadSdk:sdk,reserveAllocation:async()=>{
                await assertReadCurrent();
                const scope=options.activeScope()!;
                const declaredLimitMicrousd=options.env.COMMON_BROWSER_REGISTRATION?JSON.parse(options.env.COMMON_BROWSER_REGISTRATION).spend?.limitMicrousd:undefined;
                const effectiveLimitMicrousd=Number.isSafeInteger(declaredLimitMicrousd)?Math.min(declaredLimitMicrousd,COMMON_TEST_CEILING_MICROUSD):declaredLimitMicrousd;
                try{
                  return reserveOwnerPublicBrowser({storage:options.storage,ownerId,custodyDigest:owner.custodyDigest,intent:`${scope.runId}:${scope.attempt}:${ctx.toolCallId}`,reservedBrowserMs:PUBLIC_READ_RESERVED_BROWSER_MS,now:Date.now(),declaredLimitMicrousd:effectiveLimitMicrousd,assertCurrent:()=>{scope.admit();if(options.activeScope()!==scope||!binding())throw new ClosedRunError();}});
                }catch(cause){if(cause instanceof ClosedRunError)throw cause;throw spendRefusal(cause);}
              }});
              const result=await read(args,{...ctx,authenticatedUserId:ownerId,assertTaskSourceCurrent:assertReadCurrent});
              return held&&result.ok?{...result,data:{...result.data,open_browser_session:{session_handle:held.sessionHandle,notice:'An interactive browser session from an earlier turn is still open. This read used a separate page and did not see or change it. Continue that session with its session_handle, or end it with browse_act command cancel.'}}}:result;
            }
          }
          const bound=await bindHost(ctx,args.session_handle,args.retain_session);
          const result=await bound.active.host.handler.handle(args,bound.context);if(result.ok)publishPointer();return result;
        } catch(cause) { traceBrowserFailure('read',cause);return { ok: false, code: 'rejected', error: cause instanceof BrowserSessionRefusal?cause.message:`The browser owner or retained session is unavailable (${browserFailureClass(cause)}). No replacement was allocated.`, source_taint: 'external' }; }
      } };
    },
    act(fallback:ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>):ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>{
      return {...fallback,eligible:eligibleWith(true),schema:browseActArgsSchema,description:'Use the selected Cloudflare owner browser through observed refs. Read with browse_page retain_session:true first, then use its session_handle. Native actions: type, click, select, set_checked, scroll, goto, open_tab, switch_tab, close_tab, read, inspect, screenshot, download, owner_login, resume_owner_login, cancel. download uses an observed link for an authenticated GET attachment, stores and verifies bytes in your private workspace, and returns an exact-revision owner download link. Blob/data and POST exports are unsupported. owner_login pauses this turn for human sign-in in the authenticated console; end the turn and ask the owner to reply after Done. Resume only on that later owner reply, then verify the intended signed-in account from fresh evidence. session_handle explicitly continues an existing owner session. File selection and page sends are unsupported; uncertain effects cannot repeat.',async handle(args,ctx){
        try{
          const assertCurrent=current(ctx);await assertCurrent();
          // The owner's Cloudflare host acts only through a typed command; a plain action has no browser to run on.
          if(!args.command)return {ok:false,code:'rejected',error:'browse_act needs a typed command on a session from browse_page retain_session:true.',source_taint:'external'};
          // A typed command goes to the enabled task host while no common browser is held, otherwise to the owner's Cloudflare host.
          if(!args.session_handle&&options.typedHost?.()&&!options.env.COMMON_BROWSER_REGISTRATION&&!automatic.hasRetained()&&!active)return fallback.handle(args,{...ctx,assertTaskSourceCurrent:assertCurrent});
          const bound=await bindHost(ctx,args.session_handle);
          const result=await bound.active.host.actionHandler.handle(args,bound.context);
          if(args.command?.operation==='owner_login'&&result.ok){const origin=options.storage.kv.get<string>('origin');if(origin&&new URL(origin).protocol==='https:'&&'data' in result&&result.data&&typeof result.data==='object')Object.assign(result.data,{console_url:new URL('/console/browser-handoff',origin).href});}
          if(args.command?.operation==='cancel'&&result.ok){active=undefined;lease=undefined;options.storage.kv.put(continuationKey,null);}else if(result.ok)publishPointer();return result;
        }catch(cause){traceBrowserFailure('act',cause);return {ok:false,code:'rejected',error:cause instanceof BrowserSessionRefusal?cause.message:`The selected owner browser session or current action is unavailable (${browserFailureClass(cause)}). No replacement or provider switch was made.`,source_taint:'external'};}
      }};
    },
    gateway() {
      if (automatic.selected || automatic.hasRetained()) {
        const gateway = new OpenAIResponsesAdapter({ apiKey: options.env.OPENAI_API_KEY! });
        let metered: Promise<LLMGatewayAdapter> | undefined;
        return { async complete(request) {
          const scope = options.activeScope(), supplied = request.runScope;
          if (!scope || !supplied || scope.runId !== supplied.runId || scope.attempt !== supplied.attempt
            || scope.admit !== supplied.admit || scope.commit !== supplied.commit || scope.deadline !== supplied.deadline) throw new ClosedRunError();
          scope.admit();
          // Browser trial funding never defines ordinary model-run admission.
          // Retained browser spend is metered only while its configuration is live.
          const holdsFunding = () => funded(scope);
          if (!holdsFunding()) {
            await assertOwner(); scope.admit();
            if (options.activeScope() !== scope) throw new ClosedRunError();
            // Allocation may have appeared while directory authority was pending.
            if (!holdsFunding()) return gateway.complete(request);
          }
          const config = await automatic.configuration().catch(cause=>{traceBrowserFailure('trial_configuration',cause);if(!(cause instanceof CommonBrowserRegistrationUnavailable))throw cause;return undefined;});
          scope.admit();
          if (options.activeScope() !== scope) throw new ClosedRunError();
          if(!config?.meterGateway||config.expiresAt<=Date.now()){
            const owner=await assertOwner();scope.admit();if(options.activeScope()!==scope)throw new ClosedRunError();
            const pinned=options.storage.kv.get<any>('common_owner_browser_registration_v1');
            if(pinned&&(pinned.custodyDigest!==owner.custodyDigest||pinned.registration?.policy?.directoryOwnerId!==owner.directoryOwnerId))throw Error('automatic browser policy requires reconciliation');
            return gateway.complete(request);
          }
          // The live trial quote covers Luna only; normal model policy remains
          // with the ordinary adapter when trial registration is unavailable.
          if (request.request.model !== WALDO_CHAT_MODEL) throw Error('automatic browser model price unavailable');
          // Share one wrapper even across concurrent first calls: physical model
          // ordinals must never restart within this constructed owner host.
          metered ??= Promise.resolve(config.meterGateway(gateway));
          return (await metered).complete(request);
        } } satisfies LLMGatewayAdapter;
      }
      let config;try{config=configuration();}catch(cause){traceBrowserFailure('trial_configuration',cause);return undefined;}
      if (!config?.meterGateway) return undefined;
      const manual=commonStagingRegistration(options.env);
      const base = new OpenAIResponsesAdapter({ apiKey: options.env.OPENAI_API_KEY! });
      const metered = config?.meterGateway?.(base);
      if (!metered) return undefined;
      // Only a run that holds a browser allocation is metered. An expired or used-up registration denies browser allocations, never ordinary model calls.
      return new Proxy(base, { get(target, key) {
        if (key !== 'complete') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
        return (request: { runScope?: RunEffectScope }) => {
          const scope = request.runScope;
          return scope && funded(scope)&&config.expiresAt>Date.now()&&(!manual||manual.spend.policy.validUntil>Date.now()) ? metered.complete(request as never) : target.complete(request as never);
        };
      } });
    },
    attachments(scope?: RunEffectScope): readonly LLMAttachment[] {
      return active && scope === active.scope ? active.host.attachments() : [];
    },
    async finish(scope?: RunEffectScope) {
      if (!scope || active?.scope !== scope) return;
      active.host.resetAttachments();active.scope=undefined;lease=undefined;options.storage.kv.put(COMMON_BROWSER_LEASE_DUE,null);
      // Keep the disposable context/CDP connection under the original paid
      // session deadline. Idle requests fail admission until explicit continuation.
    },
    stop() { revokeCommonBrowsers(options.storage, Date.now()); },
    maintain() {
      return maintenance??=(async()=>{
        // A lease wake that has come keeps a live lease's deadline, or goes, so no past wake stays for the arbiter to re-arm.
        const leaseDue=options.storage.kv.get<number|null>(COMMON_BROWSER_LEASE_DUE);
        if(typeof leaseDue==='number'&&leaseDue<=Date.now())options.storage.kv.put(COMMON_BROWSER_LEASE_DUE,lease&&lease.deadline>Date.now()?lease.deadline:null);
        if(active){await active.host.maintainHandoff();const row=options.storage.kv.get<{cleanup?:string;cleanupFailed?:boolean;session:{expiresAt:number}}>(`common-browser:${active.taskId}`);if(row&&!row.cleanupFailed&&(row.cleanup||row.session.expiresAt<=Date.now())){const held=active;await held.host.cancel();if(active===held){active=undefined;lease=undefined;}}}
        const config=await automatic.configuration(true)??(automatic.selected?undefined:configuration(true));
        if(config)await maintainCommonBrowsers(options.storage,config,Date.now());
        const sdk=commonBrowserSdk();if(options.env.BROWSER&&sdk){
          const cleanup=ordinaryPublicBrowserConfiguration({storage:options.storage,binding:options.env.BROWSER,loadSdk:sdk,now:Date.now,assertCurrent:async()=>{throw new ClosedRunError();},assertOwner:async()=>{throw new ClosedRunError();}});
          await maintainCommonBrowsers(options.storage,cleanup,Date.now());
        }
      })().finally(()=>{maintenance=undefined;});
    },
  };
}
