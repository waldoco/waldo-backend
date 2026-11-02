import { DurableObject } from 'cloudflare:workers';
import { ownerSignalSchema } from '@waldo/contracts';
import { coreFileStore } from '../memory/core-files';
import { armAlarm } from '../scheduler/alarm-slot';
import { durableConversationStore } from './conversation-store';
import { DEFAULT_MORNING_DEADLINE, ProactiveOwner } from './proactive-owner';
import { createTelegramCaller, createTelegramOwnerApi } from './telegram-api';
import { TelegramOwnerListener } from './telegram-listener';
import { TelegramPollingAdapter } from './telegram-polling';
import { createTelegramResponder, type TelegramResponder } from './telegram-turn';
import type { TelegramWebhookEnv } from './telegram-webhook';

type Runtime = Readonly<{
  listener: TelegramOwnerListener;
  proactive: ProactiveOwner;
}>;

export class TelegramOwnerDO extends DurableObject<TelegramWebhookEnv> {
  private runtime?: Runtime;
  private queue: Promise<unknown> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const body = await request.text();
    const signal = new URL(request.url).pathname === '/signal';
    await this.serialise(async () => {
      const runtime = this.ensureRuntime();
      await runtime.proactive.ensureArmed();
      if (signal) {
        await runtime.proactive.handle(ownerSignalSchema.parse(JSON.parse(body)));
        return;
      }
      const offset = (await this.ctx.storage.get<number>('offset')) ?? 0;
      const update = JSON.parse(body) as unknown;
      await runtime.listener.pollOnce(new TelegramPollingAdapter({ getUpdates: async () => [update] }, offset), 0);
    });
    return new Response('ok');
  }

  override async alarm(): Promise<void> {
    await this.serialise(() => this.ensureRuntime().proactive.onAlarm());
  }

  private serialise(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ensureRuntime(): Runtime {
    if (this.runtime) return this.runtime;
    const { TELEGRAM_BOT_TOKEN: token, OPENAI_API_KEY: key, WALDO_OWNER_TELEGRAM_ID: owner } = this.env;
    if (!token || !key || !owner) throw new Error('telegram owner runtime is unconfigured');
    const log = (entry: object) => console.log(JSON.stringify(entry));
    const api = createTelegramOwnerApi(createTelegramCaller(token));
    const responder: TelegramResponder = createTelegramResponder(
      key, durableConversationStore(this.ctx.storage), coreFileStore(this.ctx.storage.sql), log,
    );
    const ownerChatId = Number(owner);
    this.runtime = {
      listener: new TelegramOwnerListener({
        ownerTelegramId: ownerChatId,
        api,
        respond: responder.respond,
        chooseReaction: responder.chooseReaction,
        log,
        saveOffset: (offset) => this.ctx.storage.put('offset', offset),
      }),
      proactive: new ProactiveOwner({
        storage: this.ctx.storage,
        arm: (at) => armAlarm(this.ctx.storage, at),
        responder,
        send: (text) => api.sendMessage({ chat_id: ownerChatId, text }),
        ownerChatId,
        timeZone: this.env.WALDO_OWNER_TIMEZONE || null,
        morningDeadline: this.env.WALDO_MORNING_DEADLINE || DEFAULT_MORNING_DEADLINE,
        now: Date.now,
        log,
      }),
    };
    return this.runtime;
  }
}
