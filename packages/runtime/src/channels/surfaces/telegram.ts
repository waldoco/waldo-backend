import { createOwnerTurnContext, ownerChainRef, surfaceChatRef } from '../../context-composer/owner-turn';
import { commonOwnerAuthority } from '../../identity/common-owner-authority';
import { consoleAuth } from '../../identity/console-auth';
import { ownerMessageAdmission } from '../../identity/owner-message-admission';
import { surfaceOwnerAdmission } from '../../identity/surface-owner-admission';
import { ownerPrincipalRef } from '../app-api';
import { browserOwnerBindingReader } from '../browser-production-factory';
import { telegramConsoleRoute } from '../console-link';
import { redactSecretUrls } from '../egress-guard';
import type { OwnerContextIntegration } from '../owner-turn';
import { ownerTurnTrace } from '../owner-turn-envelope';
import { turnOnSurface, type SurfaceAdapter, type SurfaceDescriptor, type SurfaceHost } from '../owner-runtime';
import { ClosedRunError } from '../run-effect-scope';
import { createTelegramCaller } from '../telegram-api';
import { createTelegramFileDownloader } from '../telegram-media';
import { OWNER_INBOX_KEY, type InboxRecord } from '../telegram-owner-inbox';

// A directory-backed DO whose owner has not linked Telegram yet resolves to 0 (not the deploy
// owner's id): every send gate drops on 0, so one owner's messages can never land in another's chat.
// The env fallback exists only for legacy single-owner deploys with no Supabase directory.
export const resolveOwnerTelegramId = (
  linkedSubject: string | undefined,
  env: Readonly<{ WALDO_OWNER_TELEGRAM_ID?: string }>,
  directoryBacked: boolean,
): number => {
  if (linkedSubject) return Number(linkedSubject);
  if (directoryBacked) return 0;
  return env.WALDO_OWNER_TELEGRAM_ID ? Number(env.WALDO_OWNER_TELEGRAM_ID) : 0;
};

export const telegramSurface: SurfaceDescriptor = {
  name: 'telegram',
  presentation: { surface: 'telegram', delivery: { text: true, approval: 'native_buttons', reactions: true, attachments: false }, commands: ['/stop', '/ledger'] },
  native: false,
  offsetKey: 'offset',
  healthSource: 'telegram',
  transport: ['sendMessage', 'setMessageReaction', 'sendChatAction'],
  presence: 'telegram',
  sendsOwn: true,
  sendTarget: true,
  deskSurface: 'telegram',
  owner: (identity, env) => resolveOwnerTelegramId(identity.get<string>('telegram_subject'), env, consoleAuth(env) !== null),
};

export const surfaceAdapter = (host: SurfaceHost): SurfaceAdapter => {
  const { env, storage } = host;
  const identity = storage.kv;
  const ownerIdentity: NonNullable<SurfaceAdapter['ownerIdentity']> = (turn, scope, owner) => {
    const occurrence = host.activeInbox();
    const doName = identity.get<string>('do_name');
    const subject = identity.get<string>('telegram_subject');
    return async () => {
      scope.admit();
      const currentOwner = telegramSurface.owner(identity, env);
      if (!occurrence || occurrence !== host.activeInbox() || scope !== host.activeScope()
        || occurrence.runId !== scope.runId || occurrence.attempt !== scope.attempt
        || occurrence.subject !== String(owner) || currentOwner !== owner || owner <= 0
        || identity.get<string>('do_name') !== doName || identity.get<string>('telegram_subject') !== subject
        || !turnOnSurface(turn, 'telegram') || turn.conversationRef !== surfaceChatRef('telegram', owner)
        || turn.traceId !== `tg-${occurrence.updateId}`)
        throw new ClosedRunError();
      scope.admit();
    };
  };
  return {
    ...telegramSurface,
    assertConfigured: () => { if (!env.TELEGRAM_BOT_TOKEN) throw new Error('telegram owner runtime is unconfigured'); },
    caller: () => createTelegramCaller(env.TELEGRAM_BOT_TOKEN!),
    traceOccurrences: () => identity.get<InboxRecord[]>(OWNER_INBOX_KEY) ?? [],
    download: createTelegramFileDownloader(env.TELEGRAM_BOT_TOKEN ?? ''),
    consoleLink: ({ owner, routedCall }) => telegramConsoleRoute((body) => routedCall('sendMessage', { chat_id: owner, ...body }), identity),
    ownerIdentity,
    skillHost: ({ owner, probeCapture }, curated) => ({ browserAttachments: scope => host.browserAttachments(scope), prepare: async (turn, contextOwnerId, scope) => {
      if (probeCapture.current !== null) return undefined;
      const occurrence = host.activeInbox();
      const doName = identity.get<string>('do_name');
      const subject = identity.get<string>('telegram_subject');
      const assertOwnerIdentity = ownerIdentity(turn, scope, owner);
      await assertOwnerIdentity();
      const trial = host.browserTrial;
      const admission = trial ? await (async () => {
        try { return await ownerMessageAdmission({
        lookup: browserOwnerBindingReader({ env, storage, actualDoId: host.doId }, doName!, subject!), scope,
        locator: { environment: env.WALDO_ENVIRONMENT ?? '', namespace: env.WALDO_OWNER_DO_NAMESPACE ?? '', doName: doName!, doId: host.doId },
        actualDoId: host.doId, expectedDoId: name => env.OWNER_DO!.idFromName(name).toString(), allowedDoNames: [trial.policy.doName],
        provider: 'telegram', subject: subject!, text: turn.text!, occurrenceKey: occurrence!.id, occurredAt: occurrence!.admittedAt, now: Date.now,
      }); } catch {
          await assertOwnerIdentity();
          // Browser identity failure preserves the existing messaging path.
          // Its fixture principal cannot resolve the canonical browser host.
          console.warn(JSON.stringify({ event: 'browser_owner_admission_unavailable' }));
          return undefined;
        }
      })() : undefined;
      return curated(turn, admission?.invocation.verified_authority.principal_ref ?? contextOwnerId, `telegram:${owner}`, scope, assertOwnerIdentity, admission);
    } }),
    // The owner principal inside every turn. A Telegram turn is admitted through the same surface admission as an app
    // turn, so its tools, cache key and composed context belong to the directory owner, never to the chat id. Without a
    // directory (local development) the fixture admission stands; a turn without text (media only) keeps the legacy path.
    context: ({ healthContext, ownerProfile }) => {
      const telegramContext: OwnerContextIntegration | undefined = consoleAuth(env) !== null ? { contextHost: { prepare: async (turn, scope) => {
        if (!turn.text) return undefined;
        const occurrence = host.activeInbox();
        const doName = identity.get<string>('do_name'), subject = identity.get<string>('telegram_subject');
        if (!occurrence || scope !== host.activeScope() || occurrence.runId !== scope.runId || occurrence.attempt !== scope.attempt || !doName || !subject
          || !turnOnSurface(turn, 'telegram') || turn.traceId !== ownerTurnTrace('telegram', occurrence.updateId) || turn.conversationRef !== surfaceChatRef('telegram', subject)) throw new ClosedRunError();
        const lookup = async () => {
          scope.admit();
          const authority = await commonOwnerAuthority(env).resolve('telegram', subject, doName);
          scope.admit();
          // Compared, never written: the pin also marks an app identity for approvals and keys effect custody.
          const pinned = identity.get<string>('owner_principal_ref');
          if (!authority || (pinned !== undefined && pinned !== ownerPrincipalRef(authority.directoryOwnerId))) throw new ClosedRunError();
          return { ownerId: authority.directoryOwnerId, bindingRef: authority.presenceId, revision: authority.admissionRevision, physicalDoId: host.doId };
        };
        // The composer runs on every tool round; one health read serves the whole turn.
        let health: ReturnType<typeof healthContext.latest> | undefined;
        return createOwnerTurnContext(await surfaceOwnerAdmission({ scope, lookup, expectedPhysicalDoId: host.doId, surface: 'telegram', subject, occurrenceKey: occurrence.id, occurredAt: occurrence.admittedAt, text: turn.text }),
          { conversationRef: ownerChainRef('telegram', subject), health: () => health ??= healthContext.latest(turn.traceId), ownerProfile });
      } } } : undefined;
      return { ...telegramContext, jobHost: host.jobHostFor((_admission, surfaceChain) => surfaceChain), ownerProfile };
    },
    // Freeze the reply text, stable commandId and exact target together with the turn's closure.
    queueFinal: ({ owner, api, probeCapture, turnReceiptUrls, core: { finalOutbox, scheduler } }) => async (turn, payload, emoji) => {
      // Capture probes remain inert and exercise the original immediate mock path.
      if (probeCapture.current !== null) { await api.sendMessage(payload); return; }
      const captured = host.activeInbox();
      if (turn.runScope && (!captured || captured.runId !== turn.runScope.runId || captured.attempt !== turn.runScope.attempt || captured.updateId !== turn.updateId)) throw new ClosedRunError();
      const input = { id: captured ? `turn:${captured.id}` : `turn:${turn.updateId}`, trace: ownerTurnTrace('telegram', turn.updateId), payload: { ...payload, text: redactSecretUrls(payload.text).text },
        ...(captured?.runId && captured.attempt ? { inbox: { id: captured.id, runId: captured.runId, attempt: captured.attempt } } : {}),
        receiptUrls: [...(turnReceiptUrls.get(ownerTurnTrace('telegram', turn.updateId)) ?? [])],
        ownerSubject: String(owner), doName: identity.get<string>('do_name') ?? '',
        ...(turn.messageId === null ? {} : { reaction: { message_id: turn.messageId, emoji } }),
      };
      if (turn.runScope && captured) await finalOutbox.enqueueFenced(input, work => turn.runScope!.commit(() => {
        work(); host.closeRunAtomic(captured, 'final_committed', true);
      }));
      else await finalOutbox.enqueue(input);
      turnReceiptUrls.delete(ownerTurnTrace('telegram', turn.updateId));
      await scheduler.rearm();
    },
  };
};
