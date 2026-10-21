// Test-only Worker entry: the production entry's exports plus the storage substrate the Durable
// Object tests run in. `env.TEST_STORAGE_DO` is an object with the owner substrate schema
// (tracer/schema.ts, what OwnerDO applies first) and no behaviour; a test provisions anything else
// it exercises (`provisionDoSchema`) inside `runInDurableObject`. The vitest configs name this
// file as `main` and add the binding; wrangler.jsonc never sees it.
import { DurableObject } from 'cloudflare:workers';
import { ensureSchema } from '../../src/tracer/schema';

export { default } from '../../src/index';
export * from '../../src/index';

export class TestStorageDO extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ensureSchema(ctx.storage);
  }

  // Code under test arms the object's one alarm (scheduler rearm); the substrate has no wake behaviour.
  override async alarm(): Promise<void> {}
}

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_STORAGE_DO: DurableObjectNamespace<TestStorageDO>;
    }
  }
}
