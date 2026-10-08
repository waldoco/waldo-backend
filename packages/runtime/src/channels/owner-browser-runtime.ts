import { browsePageArgsSchema, WALDO_CHAT_MODEL, type BrowsePageArgs, type LLMAttachment, type ToolHandler } from '@waldo/contracts';
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

// The browser task follows the authenticated owner run. It needs no topic classifier
// or canonical execution activation; provider identity and budget stay in the DO.
export function ownerBrowserRuntime(options: Readonly<{
  env: TelegramWebhookEnv; storage: DurableObjectStorage; actualDoId: string;
  activeScope(): RunEffectScope | undefined;
  privateBrowser?: PrivateBrowserRegistration;
}>) {
  let active: Readonly<{ scope: RunEffectScope; host: ReturnType<typeof commonBrowserHost> }> | undefined;
  const automatic = commonOwnerBrowserRegistration({ ...options, loadSdk: commonBrowserSdk() });
  const configuration = (cleanupOnly = false) => {
    const registered = commonStagingRegistration(options.env);
    return commonPublicBrowserConfiguration({ ...options, cleanupOnly, ...(registered ? {
      policy: registered.policy, spend: registered.spend, loadSdk: commonBrowserSdk(),
    } : {}) });
  };
  const selectedConfiguration = async (cleanupOnly = false) => automatic.selected || automatic.hasRetained() ? automatic.configuration(cleanupOnly) : configuration(cleanupOnly);
  const privateBrowser = ownerPrivateBrowserHost({ storage: options.storage, environment: options.env.WALDO_ENVIRONMENT ?? '', registration: options.privateBrowser,
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
    configuration: selectedConfiguration, now: Date.now, wake: async at => { const prior = await options.storage.getAlarm(); await armAlarm(options.storage, Math.max(Date.now() + 250, prior === null ? at : Math.min(prior, at))); }, assertOwner: async () => {
      const doName = options.storage.kv.get<string>('do_name'), subject = options.storage.kv.get<string>('telegram_subject');
      const physical = () => { if (!doName || !subject || options.storage.kv.get('do_name') !== doName || options.storage.kv.get('telegram_subject') !== subject
        || options.storage.kv.get('telegram_unlinked') === true || options.env.TELEGRAM_OWNER_DO?.idFromName(doName).toString() !== options.actualDoId) throw new ClosedRunError(); };
      physical(); const owner = await commonOwnerAuthority(options.env).resolve('telegram', subject!, doName!); physical();
      if (!owner) throw new ClosedRunError(); return { directoryOwnerId: owner.directoryOwnerId, custodyDigest: owner.custodyDigest };
    } });
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
          if (args.provider === 'browserbase_stagehand_http_v3' || !args.provider && options.env.WALDO_ENVIRONMENT !== 'staging') return fallback.handle(args, { ...ctx, assertTaskSourceCurrent: assertCurrent });
          if (privateBrowser.matches(args.url)) return privateBrowser.read(args, { ...ctx, assertTaskSourceCurrent: assertCurrent });
          const config = automatic.selected || automatic.hasRetained() ? await automatic.configuration() : configuration();
          if (!config) return { ok: false, code: 'rejected', error: 'The selected Cloudflare browser is not registered for this owner.', source_taint: 'external' };
          const wake = Math.min(ctx.runScope!.deadline, config.expiresAt, Date.now() + config.lifetimeMs);
          const prior = await options.storage.getAlarm();
          await armAlarm(options.storage, Math.max(Date.now() + 250, prior === null ? wake : Math.min(prior, wake)));
          await assertCurrent();
          if (!active || active.scope !== options.activeScope()) {
            if (active) throw new ClosedRunError();
            const scope = options.activeScope()!;
            active = { scope, host: commonBrowserHost({ storage: options.storage, config, ownerId: config.ownerId, egressAllowlist: ctx.egressAllowlist,
              source: () => ({ taskId: scope.runId, revision: 1, sources: ['browser'], ready: true, startRef: scope.attempt }),
              assertCurrent, deadline: () => scope.deadline, now: Date.now }) };
          }
          return active.host.handler.handle(args, { ...ctx, authenticatedUserId: config.ownerId, assertTaskSourceCurrent: assertCurrent });
        } catch { return { ok: false, code: 'rejected', error: 'The browser owner or retained session is unavailable. No replacement was allocated.', source_taint: 'external' }; }
      } };
    },
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
      const base = new OpenAIResponsesAdapter({ apiKey: options.env.OPENAI_API_KEY! });
      const metered = config?.meterGateway?.(base);
      if (!metered) return undefined;
      // Only a run that holds a browser allocation is metered. An expired or used-up registration denies browser allocations, never ordinary model calls.
      return new Proxy(base, { get(target, key) {
        if (key !== 'complete') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
        return (request: { runScope?: RunEffectScope }) => {
          const scope = request.runScope;
          return active && scope && active.scope.runId === scope.runId && active.scope.attempt === scope.attempt ? metered.complete(request as never) : target.complete(request as never);
        };
      } });
    },
    attachments(scope?: RunEffectScope): readonly LLMAttachment[] {
      return active && scope === active.scope ? active.host.attachments() : [];
    },
    async finish(scope?: RunEffectScope) {
      if (!scope || active?.scope !== scope) return;
      const retained = active; active = undefined; await retained.host.cancel();
    },
    stop() { privateBrowser.stop(); revokeCommonBrowsers(options.storage, Date.now()); },
    async maintain() { await Promise.all([privateBrowser.maintain(), (async () => { const config = await automatic.configuration(true) ?? (automatic.selected ? undefined : configuration(true)); if (config) await maintainCommonBrowsers(options.storage, config, Date.now()); })()]); },
  };
}
