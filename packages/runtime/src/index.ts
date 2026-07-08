import { DurableObject } from 'cloudflare:workers';
import { armAlarm } from './scheduler/alarm-slot';

export * from './hooks/registry';
export { TracerDO } from './tracer/tracer-do';
import type { TracerDO } from './tracer/tracer-do';

// Augment the ambient worker env so both the DO base (typed on Cloudflare.Env)
// and the test's `env` import (also Cloudflare.Env) see the DO bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      RUNTIME_DO: DurableObjectNamespace<RuntimeProbeDO>;
      TRACER_DO: DurableObjectNamespace<TracerDO>;
    }
  }
}

type Env = Cloudflare.Env;

// Test-only probe DO for the hermetic Gate-5 runtime substrate. No product logic:
// it exercises DO SQLite durability, the alarm slot via the alarm-slot seam, and
// eviction survival. `tick` is synthetic neutral state, not a physiological value.
export class RuntimeProbeDO extends DurableObject<Env> {
  // In-memory flag (not persisted). Reset to false when the instance is reconstructed
  // after eviction — the test reads this to prove eviction actually tore down the
  // instance rather than returning a still-live one.
  inMemoryTouched = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe_state(id TEXT PRIMARY KEY, tick INTEGER)');
  }

  async seed(): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO probe_state (id, tick) VALUES ('probe', 1) ON CONFLICT(id) DO UPDATE SET tick = 1",
    );
    this.inMemoryTouched = true;
    await armAlarm(this.ctx.storage, Date.now() + 1000);
  }

  async readTick(): Promise<number> {
    return this.ctx.storage.sql
      .exec<{ tick: number }>("SELECT tick FROM probe_state WHERE id = 'probe'")
      .one().tick;
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE probe_state SET tick = 2 WHERE id = 'probe'");
    this.inMemoryTouched = true;
  }
}

export default {
  fetch(): Response {
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
