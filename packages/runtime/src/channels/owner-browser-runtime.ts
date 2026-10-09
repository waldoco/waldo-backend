import { browsePageArgsSchema, browseActArgsSchema, WALDO_CHAT_MODEL, type BrowseActArgs, type BrowsePageArgs, type LLMAttachment, type ToolHandler } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { TelegramWebhookEnv } from './telegram-webhook';
import { ClosedRunError, type RunEffectScope } from './run-effect-scope';
import { commonBrowserHost, maintainCommonBrowsers, revokeCommonBrowsers } from './common-browser-host';
import { commonPublicBrowserConfiguration } from './common-public-browser-configuration';
import { commonBrowserSdk, commonStagingRegistration } from './common-staging-registration';
import { OpenAIResponsesAdapter } from '../llm/openai';
import { armAlarm } from '../scheduler/alarm-slot';
import { commonOwnerBrowserRegistration } from './common-owner-browser-registration';
import type { LLMGatewayAdapter } from '../llm/provider';
import { commonOwnerAuthority } from '../identity/common-owner-authority';
import { ownerPrivateBrowserHost, type PrivateBrowserRegistration } from './owner-private-browser-host';
import { workspaceOwnerHost, workspaceMetadata } from './workspace-host';
import { ownerBrowserVaultRegistration, revokeOwnerBrowserVault } from './owner-browser-vault-registration';

// The browser task follows the authenticated owner run. It needs no topic classifier
// or canonical execution activation; provider identity and budget stay in the DO.
export function ownerBrowserRuntime(options: Readonly<{
  env: TelegramWebhookEnv; storage: DurableObjectStorage; actualDoId: string;
  activeScope(): RunEffectScope | undefined;
  privateBrowser?: Omit<PrivateBrowserRegistration, 'custody'> & Partial<Pick<PrivateBrowserRegistration, 'custody'>>;
}>) {
  let active: { scope?: RunEffectScope; taskId:string; ownerId:string; host: ReturnType<typeof commonBrowserHost> } | undefined;
  let lease: Readonly<{scope?:RunEffectScope;deadline:number;assertCurrent():Promise<void>}>|undefined;
  const continuationKey='common-browser-current:v1';
  const retainedTask=()=>{
    const pointer=options.storage.kv.get<{taskId:string;sessionHandle:string}>(continuationKey);
    const row=pointer?options.storage.kv.get<{session:{id:string;state:string;expiresAt:number};cleanup?:string}>(`common-browser:${pointer.taskId}`):undefined;
    return pointer&&row&&!row.cleanup&&row.session.state==='active'&&row.session.id===pointer.sessionHandle&&row.session.expiresAt>Date.now()?pointer:undefined;
  };
  let proposeCommon:((payload:import('./approvals').BrowserSubmitProposal,ctx:ToolDispatcherContext)=>Promise<string>)|undefined;
  let maintenance:Promise<void>|undefined;
  const automatic = commonOwnerBrowserRegistration({ ...options, loadSdk: commonBrowserSdk() });
  const configuration = (cleanupOnly = false) => {
    const registered = commonStagingRegistration(options.env);
    return commonPublicBrowserConfiguration({ ...options, cleanupOnly, ...(registered ? {
      policy: registered.policy, spend: registered.spend, loadSdk: commonBrowserSdk(),
    } : {}) });
  };
  const selectedConfiguration = async (cleanupOnly = false) => automatic.selected || automatic.hasRetained() ? automatic.configuration(cleanupOnly) : configuration(cleanupOnly);
  const assertOwner = async () => {
      const doName = options.storage.kv.get<string>('do_name'), subject = options.storage.kv.get<string>('telegram_subject');
      const physical = () => { if (!doName || !subject || options.storage.kv.get('do_name') !== doName || options.storage.kv.get('telegram_subject') !== subject
        || options.storage.kv.get('telegram_unlinked') === true || options.env.TELEGRAM_OWNER_DO?.idFromName(doName).toString() !== options.actualDoId) throw new ClosedRunError(); };
      physical(); const owner = await commonOwnerAuthority(options.env).resolve('telegram', subject!, doName!); physical();
      if (!owner) throw new ClosedRunError(); return { directoryOwnerId: owner.directoryOwnerId, custodyDigest: owner.custodyDigest };
    };
  const vaultOptions = { ...options, assertOwner };
  const registration = options.privateBrowser ? options.privateBrowser.custody ? options.privateBrowser as PrivateBrowserRegistration : ownerBrowserVaultRegistration({ ...vaultOptions, registration: options.privateBrowser }) : undefined;
  const privateBrowser = ownerPrivateBrowserHost({ storage: options.storage, environment: options.env.WALDO_ENVIRONMENT ?? '', registration,
    retireState: approval => revokeOwnerBrowserVault(vaultOptions, approval),
    files: async (assertCurrent, ownerId) => {
      const scope = options.activeScope(), doName = options.storage.kv.get<string>('do_name');
      if (!scope || !doName) throw new ClosedRunError();
      const admit = async () => {
        await assertCurrent(); scope.admit();
        if (options.activeScope() !== scope || options.storage.kv.get('do_name') !== doName) throw new ClosedRunError();
        const binding = workspaceMetadata(options.storage, scope).transaction(state => state.binding);
        if (binding && binding.ownerId !== ownerId) throw new ClosedRunError();
      };
      await admit();
      const workspace = await workspaceOwnerHost(options.env, options.storage, options.actualDoId, doName, fetch, scope, admit);
      await admit();
      const origin = options.storage.kv.get<string>('origin'); if (!origin) throw new ClosedRunError();
      return { workspace, origin };
    },
    configuration: selectedConfiguration, now: Date.now, wake: async at => { const prior = await options.storage.getAlarm(); await armAlarm(options.storage, Math.max(Date.now() + 250, prior === null ? at : Math.min(prior, at))); }, assertOwner });
  const current = (ctx: ToolDispatcherContext) => {
    const scope = options.activeScope(), supplied = ctx.runScope;
    const doName = options.storage.kv.get<string>('do_name'), subject = options.storage.kv.get<string>('telegram_subject');
    // Hooks copy the context object, but retain these host-created functions.
    if (!scope || !supplied || supplied.runId !== scope.runId || supplied.attempt !== scope.attempt
      || supplied.deadline !== scope.deadline || supplied.admit !== scope.admit || supplied.commit !== scope.commit
      || !doName || !subject || !ctx.authenticatedUserId) throw new ClosedRunError();
    return async () => {
      scope.admit();
      if (options.activeScope() !== scope || options.storage.kv.get('do_name') !== doName
        || options.storage.kv.get('telegram_subject') !== subject || options.storage.kv.get('telegram_unlinked') === true
        || options.env.TELEGRAM_OWNER_DO?.idFromName(doName).toString() !== options.actualDoId) throw new ClosedRunError();
      scope.admit();
    };
  };
  const commonFiles=async(assertCurrent:()=>Promise<void>,ownerId:string)=>{
    const scope=options.activeScope(),doName=options.storage.kv.get<string>('do_name');if(!doName)throw new ClosedRunError();
    const admit=async()=>{await assertCurrent();scope?.admit();if(scope&&options.activeScope()!==scope||options.storage.kv.get('do_name')!==doName)throw new ClosedRunError();const owner=await assertOwner();if(ownerId!==owner.directoryOwnerId&&ownerId!==`prn_${owner.directoryOwnerId.replaceAll('-','')}`)throw new ClosedRunError();const bound=workspaceMetadata(options.storage,scope).transaction(state=>state.binding);if(bound&&bound.ownerId!==owner.directoryOwnerId)throw new ClosedRunError();await assertCurrent();};
    await admit();const workspace=await workspaceOwnerHost(options.env,options.storage,options.actualDoId,doName,fetch,scope,admit);await admit();const origin=options.storage.kv.get<string>('origin');if(!origin)throw new ClosedRunError();return {workspace,origin};
  };
  const bindHost=async(ctx:ToolDispatcherContext,sessionHandle?:string)=>{
    const assertCurrent=current(ctx);await assertCurrent();
    const scope=options.activeScope()!,config=await selectedConfiguration();await assertCurrent();
    if(!config)throw new ClosedRunError();
    if(active&&options.storage.kv.get<{cleanup?:string}>(`common-browser:${active.taskId}`)?.cleanup==='closed'){active=undefined;lease=undefined;options.storage.kv.put(continuationKey,null);}
    const pointer=retainedTask();
    if(sessionHandle&&pointer?.sessionHandle!==sessionHandle)throw new ClosedRunError();
    if(active){
      if(active.ownerId!==config.ownerId||active.scope&&active.scope!==scope||active.scope!==scope&&active.host.sessionHandle()!==sessionHandle)throw new ClosedRunError();
      active.scope=scope;
    }else{
      const taskId=sessionHandle?pointer!.taskId:scope.runId,initialAttempt=scope.attempt;
      active={scope,taskId,ownerId:config.ownerId,host:commonBrowserHost({storage:options.storage,config:{...config,retainInteractions:true},ownerId:config.ownerId,egressAllowlist:ctx.egressAllowlist,
        source:()=>({taskId,revision:1,sources:['browser'],ready:true,startRef:initialAttempt}),
        files:commonFiles,propose:(payload,context)=>{if(!proposeCommon)throw new ClosedRunError();return proposeCommon(payload,context);},
        assertCurrent:async()=>{const admitted=lease;if(!admitted)throw new ClosedRunError();await admitted.assertCurrent();if(lease!==admitted)throw new ClosedRunError();},
        deadline:()=>lease?.deadline??0,now:Date.now})};
    }
    lease={scope,deadline:scope.deadline,assertCurrent};
    options.storage.kv.put(`common-browser-run:${scope.runId}`,active.taskId);
    const wake=Math.min(scope.deadline,config.expiresAt,Date.now()+config.lifetimeMs),prior=await options.storage.getAlarm();
    await armAlarm(options.storage,Math.max(Date.now()+250,prior===null?wake:Math.min(prior,wake)));await assertCurrent();
    return {active,context:{...ctx,authenticatedUserId:config.ownerId,assertTaskSourceCurrent:assertCurrent}};
  };
  const publishPointer=()=>{const handle=active?.host.sessionHandle();if(active&&handle)options.storage.kv.put(continuationKey,{taskId:active.taskId,sessionHandle:handle});};
  const funded=(scope:RunEffectScope)=>active?.scope===scope||options.storage.kv.get(`common-browser:${scope.runId}`)!==undefined||options.storage.kv.get(`common-browser-run:${scope.runId}`)!==undefined;
  return {
    current,
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
      return { ...fallback, schema: browsePageArgsSchema, async handle(args, ctx) {
        try {
          const assertCurrent = current(ctx); await assertCurrent();
          // Browserbase remains an explicit choice. Cloudflare failure never switches providers.
          if(args.provider==='browserbase_stagehand_http_v3'&&args.session_handle)throw new ClosedRunError();
          if (args.provider === 'browserbase_stagehand_http_v3' || !args.provider && !args.session_handle && options.env.WALDO_ENVIRONMENT !== 'staging') return fallback.handle(args, { ...ctx, assertTaskSourceCurrent: assertCurrent });
          if (privateBrowser.matches(args.url)) return privateBrowser.read(args, { ...ctx, assertTaskSourceCurrent: assertCurrent });
          const bound=await bindHost(ctx,args.session_handle);
          const result=await bound.active.host.handler.handle(args,bound.context);publishPointer();return result;
        } catch { return { ok: false, code: 'rejected', error: 'The browser owner or retained session is unavailable. No replacement was allocated.', source_taint: 'external' }; }
      } };
    },
    act(fallback:ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>,propose?:(payload:import('./approvals').BrowserSubmitProposal,ctx:ToolDispatcherContext)=>Promise<string>):ToolHandler<BrowseActArgs,unknown,ToolDispatcherContext>{
      proposeCommon=propose;
      return {...fallback,schema:browseActArgsSchema,description:'Use the selected Cloudflare owner browser through observed refs. Read with browse_page first. Native actions: type, click, scroll, goto, open_tab, switch_tab, close_tab, read, inspect, screenshot, cancel. session_handle explicitly continues an existing owner session. Uploads require owner approval; page sends are refused; uncertain effects cannot repeat. Browserbase remains an explicit alternative.',async handle(args,ctx){
        try{
          const assertCurrent=current(ctx);await assertCurrent();
          if(args.provider==='browserbase_stagehand_http_v3'&&(args.command||args.session_handle))throw new ClosedRunError();
          if(args.provider==='browserbase_stagehand_http_v3'||!args.provider&&!args.session_handle&&options.env.WALDO_ENVIRONMENT!=='staging')return fallback.handle(args,{...ctx,assertTaskSourceCurrent:assertCurrent});
          // A configured synthetic task keeps its existing typed host. Never
          // reinterpret native commands or explicit Cloudflare as a paid fallback.
          if(!args.provider&&!args.session_handle&&args.command&&!options.env.COMMON_BROWSER_REGISTRATION&&!automatic.hasRetained()&&!active)return fallback.handle(args,{...ctx,assertTaskSourceCurrent:assertCurrent});
          const bound=await bindHost(ctx,args.session_handle);
          const result=await bound.active.host.actionHandler.handle(args,bound.context);
          if(args.command?.operation==='cancel'&&result.ok){active=undefined;lease=undefined;options.storage.kv.put(continuationKey,null);}else publishPointer();return result;
        }catch{return {ok:false,code:'rejected',error:'The selected owner browser session or current action is unavailable. No replacement or provider switch was made.',source_taint:'external'};}
      }};
    },
    async submitCommon(payload:import('./approvals').BrowserSubmitProposal,approvalRef?:string):Promise<import('../tools/live/browser').BrowserSubmitOutcome>{
      const held=active,scope=options.activeScope(),expires=payload.approvalExpiresAt;
      if(!held||!approvalRef||!payload.commonBrowser||payload.commonBrowser.taskId!==held.taskId||held.host.sessionHandle()!==payload.commonBrowser.sessionHandle||!expires||expires<=Date.now())return {status:'rejected',message:'The approved browser session is unavailable. No replacement was allocated.'};
      const admit=async()=>{scope?.admit();if(scope&&options.activeScope()!==scope||active!==held||Date.now()>=expires)throw new ClosedRunError();await assertOwner();const row=options.storage.sql.exec<{payload_json:string;status:string;decided_at:number}>('SELECT payload_json,status,decided_at FROM ledger WHERE id = ? AND kind = ?',approvalRef,'browser_submit').toArray()[0];if(!row||row.status!=='uncertain'||!row.decided_at||row.decided_at>Date.now()||JSON.stringify(JSON.parse(row.payload_json))!==JSON.stringify(payload))throw new ClosedRunError();scope?.admit();};
      const prior=lease;lease={scope,deadline:Math.min(expires,scope?.deadline??expires),assertCurrent:admit};
      try{await admit();return await held.host.submit(payload,approvalRef,admit);}catch{return {status:'rejected',message:'The exact owner approval is no longer current.'};}finally{if(lease?.assertCurrent===admit)lease=prior;}
    },
    async denyCommon(payload:import('./approvals').BrowserSubmitProposal){await assertOwner();const held=active;if(held&&held.taskId===payload.commonBrowser?.taskId)await held.host.deny(payload);},
    privateControl: privateBrowser.control,
    gateway() {
      if (automatic.selected || automatic.hasRetained()) {
        const gateway = new OpenAIResponsesAdapter({ apiKey: options.env.OPENAI_API_KEY! });
        let metered: Promise<LLMGatewayAdapter> | undefined;
        return { async complete(request) {
          const scope = options.activeScope(), supplied = request.runScope;
          if (!scope || !supplied || scope.runId !== supplied.runId || scope.attempt !== supplied.attempt
            || scope.admit !== supplied.admit || scope.commit !== supplied.commit || scope.deadline !== supplied.deadline) throw new ClosedRunError();
          scope.admit();
          // Directory admission is independent of browser policy. A retained task
          // record keeps funded model history metered after host reconstruction,
          // including uncertain/closed records; it never restarts physical ordinals.
          const holdsFunding = () => funded(scope);
          if (!holdsFunding()) {
            await assertOwner(); scope.admit();
            if (options.activeScope() !== scope) throw new ClosedRunError();
            // Allocation may have appeared while directory authority was pending.
            if (!holdsFunding()) return gateway.complete(request);
          }
          // The reused quote covers Luna only; a model override needs its own priced envelope.
          if (request.request.model !== WALDO_CHAT_MODEL) throw Error('automatic browser model price unavailable');
          const config = await automatic.configuration();
          scope.admit();
          if (options.activeScope() !== scope || !config?.meterGateway) throw new ClosedRunError();
          // Share one wrapper even across concurrent first calls: physical model
          // ordinals must never restart within this constructed owner host.
          metered ??= Promise.resolve(config.meterGateway(gateway));
          return (await metered).complete(request);
        } } satisfies LLMGatewayAdapter;
      }
      const config = configuration();
      if (!config?.meterGateway) return undefined;
      const base = new OpenAIResponsesAdapter({ apiKey: options.env.OPENAI_API_KEY! });
      const metered = config?.meterGateway?.(base);
      if (!metered) return undefined;
      // Only a run that holds a browser allocation is metered. An expired or used-up registration denies browser allocations, never ordinary model calls.
      return new Proxy(base, { get(target, key) {
        if (key !== 'complete') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
        return (request: { runScope?: RunEffectScope }) => {
          const scope = request.runScope;
          return scope && funded(scope) ? metered.complete(request as never) : target.complete(request as never);
        };
      } });
    },
    attachments(scope?: RunEffectScope): readonly LLMAttachment[] {
      return active && scope === active.scope ? active.host.attachments() : [];
    },
    async finish(scope?: RunEffectScope) {
      if (!scope || active?.scope !== scope) return;
      active.host.resetAttachments();active.scope=undefined;lease=undefined;
      // Keep the disposable context/CDP connection under the original paid
      // session deadline. Idle requests fail admission until explicit continuation.
    },
    stop() { privateBrowser.stop(); revokeCommonBrowsers(options.storage, Date.now()); },
    maintain() {
      return maintenance??=(async()=>{
        await privateBrowser.maintain();
        if(active){const row=options.storage.kv.get<{cleanup?:string;session:{expiresAt:number}}>(`common-browser:${active.taskId}`);if(row&&(row.cleanup||row.session.expiresAt<=Date.now())){const held=active;await held.host.cancel();if(active===held){active=undefined;lease=undefined;}}}
        const config=await automatic.configuration(true)??(automatic.selected?undefined:configuration(true));
        if(config)await maintainCommonBrowsers(options.storage,config,Date.now());
      })().finally(()=>{maintenance=undefined;});
    },
  };
}
