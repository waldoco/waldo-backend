import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { WaldoAgentCore } from "./waldo-agent-core";

export class WaldoAgent extends DurableObject<Env> {
  private readonly core: WaldoAgentCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new WaldoAgentCore(this.ctx.storage);
  }

  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }

  async alarm(): Promise<void> {
    await this.core.alarm();
  }
}
