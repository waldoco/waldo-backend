import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import type { IMessageInboxRecord } from '../src/channels/imessage/owner-inbox';
import { surfaceApi, surfaceTurnEnvelope, type SurfaceAdapter, type SurfaceHost } from '../src/channels/owner-runtime';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { SURFACES } from '../src/channels/surfaces/registry';
import { TelegramOwnerListener } from '../src/channels/telegram-listener';
import type { InboxRecord } from '../src/channels/telegram-owner-inbox';
import { ownerTyped } from './helpers/owner-typed';

describe('every registered surface declares itself completely', () => {
  for (const [name, { descriptor }] of Object.entries(SURFACES)) {
    it(`${name} names itself and presents every delivery fact`, () => {
      expect(descriptor.name).toBe(name);
      expect(descriptor.presentation.surface).toBe(name);
      expect(Object.keys(descriptor.presentation.delivery).sort()).toEqual(['approval', 'attachments', 'reactions', 'text']);
      expect(['native_buttons', 'text_callback', 'none']).toContain(descriptor.presentation.delivery.approval);
      expect(Array.isArray(descriptor.presentation.commands)).toBe(true);
      expect(descriptor.transport).toContain('sendMessage');
      // A surface that presents reactions carries them, and one that does not, does not.
      expect(descriptor.transport.includes('setMessageReaction')).toBe(descriptor.presentation.delivery.reactions);
      if (descriptor.native) expect(descriptor.transport).toEqual(['sendMessage']);
    });

    it(`${name}: a turn never reaches a transport method the surface does not declare`, async () => {
      const called: string[] = [];
      const transport = async (method: string): Promise<unknown> => {
        if (!descriptor.transport.some(declared => declared === method)) throw new Error(`undeclared transport method ${method}`);
        called.push(method);
        return method === 'sendMessage' ? { message_id: 1 } : true;
      };
      const listener = new TelegramOwnerListener({ ownerTelegramId: 7, surface: descriptor.name, api: surfaceApi(descriptor.transport, transport),
        respond: async () => 'Done.', chooseReaction: async () => '👍', saveOffset: async () => undefined, typingEveryMs: 60_000 });
      expect(await listener.handle(ownerTyped({ updateId: 1, messageId: 9, senderId: 7, chatId: 7, sentAt: null, text: 'hi' }))).toBe('answered');
      expect(called.filter(method => method === 'sendMessage')).toHaveLength(1);
      expect([...new Set(called)].sort()).toEqual([...descriptor.transport].sort());
    });
  }
});

const DIRECTORY = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const scopeOf = (runId: string, attempt: string): RunEffectScope => ({ runId, attempt, deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: <T>(work: () => T) => work() });
const TEXT = 'Move my 3pm to tomorrow.';

// One owner object with a Telegram occurrence, an app record and an iMessage record, of which the test makes one active.
const withSurfaces = (name: string, run: (parts: Readonly<{
  adapters: Readonly<Record<keyof typeof SURFACES, SurfaceAdapter>>;
  active: { inbox: InboxRecord | null; app: AppInboxRecord | null; imessage: IMessageInboxRecord | null; scope: RunEffectScope | undefined };
  appContextReached: () => number;
}>) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  state.storage.kv.put('do_name', name);
  state.storage.kv.put('telegram_subject', '7');
  state.storage.kv.put('app_subject', String(appSubjectFor(name)));
  const active: { inbox: InboxRecord | null; app: AppInboxRecord | null; imessage: IMessageInboxRecord | null; scope: RunEffectScope | undefined } = { inbox: null, app: null, imessage: null, scope: undefined };
  let appContextCalls = 0;
  const host: SurfaceHost = {
    env: { ...env, ...DIRECTORY, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' }, storage: state.storage, doId: state.id.toString(),
    currentRunRef: () => undefined, waitUntil: () => undefined, serial: work => work(),
    activeInbox: () => active.inbox, activeScope: () => active.scope, activeApp: () => active.app, activeIMessage: () => active.imessage,
    scheduledAppDelivery: () => null, imessageHost: () => { throw new Error('iMessage admission reached'); }, appInbox: () => { throw new Error('app inbox reached'); },
    appContext: async () => { appContextCalls += 1; throw new Error('app admission reached'); },
    logSkippedLoad: () => undefined, jobHostFor: chain => ({ admit: async () => undefined, chain }), closeRunAtomic: () => undefined,
    browserTrial: undefined, browserAttachments: () => [],
  };
  const adapters = Object.fromEntries(Object.entries(SURFACES).map(([surface, module]) => [surface, module.surfaceAdapter(host)])) as Record<keyof typeof SURFACES, SurfaceAdapter>;
  await run({ adapters, active, appContextReached: () => appContextCalls });
});

const telegramTurn = (scope: RunEffectScope) => surfaceTurnEnvelope(ownerTyped({ updateId: 41, messageId: 41, senderId: 7, chatId: 7, sentAt: null, text: TEXT, runScope: scope }), SURFACES.telegram.descriptor.presentation);
const occurrence = (scope: RunEffectScope): InboxRecord => ({ id: 'tg-occurrence', digest: 'd', sequence: 1, updateId: 41, body: '{}', admittedAt: 1, state: 'claimed', runId: scope.runId, attempt: scope.attempt, subject: '7', doName: 'runtime' } as InboxRecord);
const appRecord = (name: string, scope: RunEffectScope): AppInboxRecord => ({ id: scope.runId, updateId: 42, clientId: 'c', digest: 'd', text: TEXT, owner: name, sessionHash: 'a'.repeat(64),
  conversationRef: `owner:prn_${'a'.repeat(32)}`, admittedAt: 1, state: 'running', attempt: scope.attempt });
const appTurn = (name: string, scope: RunEffectScope) => surfaceTurnEnvelope(ownerTyped({ updateId: 42, messageId: null, senderId: appSubjectFor(name), chatId: appSubjectFor(name), sentAt: null, text: TEXT, runScope: scope }), SURFACES.app.descriptor.presentation);
const iMessageRecord = (scope: RunEffectScope) => ({ id: scope.runId, updateId: 43, text: TEXT, attempt: scope.attempt } as IMessageInboxRecord);
const relabel = <T extends { surface: string }>(turn: T, surface: string): T => ({ ...turn, surface, presentation: SURFACES[surface as keyof typeof SURFACES].descriptor.presentation });

describe('a turn admitted on one surface never runs as another surface\'s owner', () => {
  it('a Telegram occurrence binds only a Telegram turn, and no other surface admits it', async () => {
    await withSurfaces('runtime-isolation-telegram', async ({ adapters, active }) => {
      const scope = scopeOf('run-telegram', 'attempt-telegram');
      active.inbox = occurrence(scope); active.scope = scope;
      const turn = telegramTurn(scope);
      await expect(adapters.telegram.ownerIdentity!(turn, scope, 7)()).resolves.toBeUndefined();
      await expect(adapters.telegram.ownerIdentity!(relabel(turn, 'app'), scope, 7)()).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.telegram.ownerIdentity!(turn, scope, 8)()).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.app.ownerIdentity!(turn, scope, 7)()).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.app.ownerIdentity!(relabel(turn, 'app'), scope, 7)()).rejects.toBeInstanceOf(ClosedRunError);
      for (const surface of ['app', 'imessage'] as const) {
        await expect(adapters[surface].context(parts()).contextHost!.prepare(relabel(turn, surface), scope)).rejects.toBeInstanceOf(ClosedRunError);
      }
    });
  });

  it('an app record binds only an app turn: Telegram and iMessage refuse it before any admission read', async () => {
    const name = 'runtime-isolation-app';
    await withSurfaces(name, async ({ adapters, active, appContextReached }) => {
      const scope = scopeOf('run-app', 'attempt-app');
      active.app = appRecord(name, scope); active.scope = scope;
      const turn = appTurn(name, scope);
      await expect(adapters.app.ownerIdentity!(turn, scope, 0)()).resolves.toBeUndefined();
      await expect(adapters.app.ownerIdentity!(relabel(turn, 'imessage'), scope, 0)()).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.telegram.ownerIdentity!(relabel(turn, 'telegram'), scope, 7)()).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.telegram.context(parts()).contextHost!.prepare(relabel(turn, 'telegram'), scope)).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.imessage.context(parts()).contextHost!.prepare(relabel(turn, 'imessage'), scope)).rejects.toBeInstanceOf(ClosedRunError);
      expect(appContextReached()).toBe(0);
    });
  });

  it('an iMessage record admits no app or Telegram turn, even with the same words in the same run', async () => {
    const name = 'runtime-isolation-imessage';
    await withSurfaces(name, async ({ adapters, active, appContextReached }) => {
      const scope = scopeOf('run-imessage', 'attempt-imessage');
      active.imessage = iMessageRecord(scope); active.scope = scope;
      const turn = relabel(appTurn(name, scope), 'imessage');
      await expect(adapters.app.context(parts()).contextHost!.prepare(relabel(turn, 'app'), scope)).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.app.ownerIdentity!(relabel(turn, 'app'), scope, 0)()).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.telegram.context(parts()).contextHost!.prepare(relabel(turn, 'telegram'), scope)).rejects.toBeInstanceOf(ClosedRunError);
      await expect(adapters.telegram.ownerIdentity!(relabel(turn, 'telegram'), scope, 7)()).rejects.toBeInstanceOf(ClosedRunError);
      expect(appContextReached()).toBe(0);
    });
  });
});

// Only the context hosts' identity checks run here; nothing reaches the health or profile reads.
const parts = () => ({ owner: 7, log: () => undefined, api: surfaceApi(['sendMessage'], async () => undefined), routedCall: async () => undefined, probeCapture: { current: null },
  turnReceiptUrls: new Map(), core: {} as never, healthContext: { latest: async () => null } as never, ownerProfile: async () => null });
