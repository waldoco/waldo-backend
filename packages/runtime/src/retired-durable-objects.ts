import { DurableObject } from 'cloudflare:workers';

// Retired Durable Object classes, kept only as declarations.
//
// Their code left with the second brain (RunLoopDO and the responsibility protocol; TracerDO's
// journal, outbox and loop-governor pipeline; the RuntimeProbeDO test probe). wrangler.jsonc still binds the classes (migrations v1-v3), and a Worker whose config
// binds a class the bundle does not export fails to deploy, so the names stay until the
// `deleted_classes` migration (v8) removes the bindings and drops their storage. Nothing in the
// runtime routes to these objects; a request that reaches one is refused.
const retired = (name: string): Response =>
  new Response(`${name} is retired`, { status: 410, headers: { 'cache-control': 'no-store' } });

export class RuntimeProbeDO extends DurableObject<Cloudflare.Env> {
  override async fetch(_request: Request): Promise<Response> {
    return retired('RuntimeProbeDO');
  }
}

export class RunLoopDO extends DurableObject<Cloudflare.Env> {
  override async fetch(_request: Request): Promise<Response> {
    return retired('RunLoopDO');
  }
}

export class TracerDO extends DurableObject<Cloudflare.Env> {
  override async fetch(_request: Request): Promise<Response> {
    return retired('TracerDO');
  }
}
