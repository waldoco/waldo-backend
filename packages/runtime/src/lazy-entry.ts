import { DurableObject } from 'cloudflare:workers';

// Cloudflare caps the CPU a Worker may spend evaluating its script at startup (error 10021), and the full Worker builds
// every contract schema at module scope: most of that budget. The deployed entry evaluates only this module; the default
// handler and each Durable Object class load the full Worker on their first event, once per isolate.
//
// A Durable Object class is exported synchronously, so each one here is a forwarder: its constructor builds the real
// object inside blockConcurrencyWhile, which holds every event (request, RPC, alarm, socket message) until the real
// constructor, and any blockConcurrencyWhile it starts, has run. A throw there resets the object, as one in the real
// constructor would. Each public method and Durable Object handler of the real class is forwarded by name.

type FullWorker = Pick<typeof import('./index'), 'default' | 'OwnerDO' | 'DeviceBridgeDO' | 'IMessageBridgeDO' | 'TaskWorkerDO'>;
type Env = Cloudflare.Env;
type Handler = 'fetch' | 'alarm' | 'webSocketMessage' | 'webSocketClose' | 'webSocketError';
// Every public method must be listed (a new RPC method fails typecheck until it is); handlers are listed when the real class defines them.
type Forwarded<T> = { [K in Exclude<keyof T, keyof DurableObject> as T[K] extends (...args: never[]) => unknown ? K : never]: true } & { [K in Handler]?: true };

const real = new WeakMap<DurableObject, Record<string, (...args: unknown[]) => unknown>>();

const lazyDurableObject = <T extends object>(load: () => Promise<new (ctx: DurableObjectState, env: never) => T>, methods: Forwarded<T>) => {
  class Forwarder extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      ctx.blockConcurrencyWhile(async () => { real.set(this, new (await load())(ctx, env as never) as never); });
    }
  }
  for (const name of Object.keys(methods)) {
    Object.defineProperty(Forwarder.prototype, name, { configurable: true, writable: true,
      value(this: Forwarder, ...args: unknown[]) { return real.get(this)![name]!(...args); } });
  }
  return Forwarder;
};

export const lazyWorker = (load: () => Promise<FullWorker>) => ({
  handler: {
    fetch: async (request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> => (await load()).default.fetch(request, env, ctx),
    email: async (message: ForwardableEmailMessage, env: Env): Promise<void> => (await load()).default.email(message, env),
    scheduled: async (controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> => (await load()).default.scheduled(controller, env, ctx),
  } satisfies ExportedHandler<Env>,
  OwnerDO: lazyDurableObject(async () => (await load()).OwnerDO, { fetch: true, alarm: true, taskClaim: true, taskTool: true, taskCheckpoint: true,
    taskReport: true, taskHeartbeat: true, admitIMessageTurn: true, noteIMessageReaction: true, recordIMessageResult: true, admitAgentMail: true, admitMacDelivery: true }),
  DeviceBridgeDO: lazyDurableObject(async () => (await load()).DeviceBridgeDO, { fetch: true, alarm: true, webSocketMessage: true, webSocketClose: true,
    webSocketError: true, admitNonce: true, enqueueCommand: true, listCommands: true, revoke: true, status: true }),
  IMessageBridgeDO: lazyDurableObject(async () => (await load()).IMessageBridgeDO, { alarm: true, hostRequest: true, enqueueReply: true, tapbacksReady: true,
    revoke: true, status: true, photonBegin: true, photonFinish: true, photonAccessToken: true, photonDropAccess: true, photonKeepAlive: true, photonStatus: true }),
  TaskWorkerDO: lazyDurableObject(async () => (await load()).TaskWorkerDO, { alarm: true, start: true }),
});
