import { REPLY_TEXT_MAX_CHARS, replyApprovalPartV1Schema } from '@waldo/contracts';
import type { z } from 'zod';
import { ownerChainRef, surfaceChatRef } from '../../context-composer/owner-turn';
import { canonicalOwnerConversationStore } from '../../conversation/canonical-owner-store';
import { appSubjectFor } from '../app-api';
import { recallReach, threadOfChain } from '../app-threads';
import { indexedConversationStore } from '../episodes';
import { ownerTurnTrace } from '../owner-turn-envelope';
import { turnOnSurface, type SurfaceAdapter, type SurfaceDescriptor, type SurfaceHost } from '../owner-runtime';
import { ClosedRunError } from '../run-effect-scope';

export type AppApprovalPart = z.infer<typeof replyApprovalPartV1Schema>;
export const APP_REVIEW_MAX_CHARS = REPLY_TEXT_MAX_CHARS;

// The app's form of an approval card, checked against the pinned contract. A card that does not
// parse is never presented, so it can never open a row.
export const appApprovalPart = (part: AppApprovalPart): AppApprovalPart => replyApprovalPartV1Schema.parse(part);
export const appApprovalLink = (approvalId: string): string => `waldo://approvals/${approvalId}`;
// What a chat turn on the app tells the model when a tool needs Google: the app connects from its own screen.
export const APP_CONNECT_GUIDANCE = 'No connect button was sent: the app chat has none. Tell the owner to go back to Home, open the menu at the top left, tap Connections and connect Google there - never quote or retype any link yourself.';

// A turn's reply reaches the app through the transcript its own turn writes, so a plain send during a
// turn is accepted and goes nowhere else. Scheduled work has no turn: while the alarm holds a delivery,
// the text is written to the transcript, and a failed write throws so the job fails instead of recording
// a message the owner never got. Its receipt names the Main chat row it wrote. A keyboard, with decision or
// link buttons, is an affordance the app cannot render from this path; it is never acknowledged as shown,
// nor written as plain text.
export const appCaller = (scheduledDelivery: () => ((text: string) => Promise<string>) | null = () => null) => async (method: string, body: unknown): Promise<unknown> => {
  if (method !== 'sendMessage') return undefined;
  const { chat_id: chatId, text, reply_markup: markup } = body as { chat_id?: number; text?: string; reply_markup?: { inline_keyboard?: readonly (readonly unknown[])[] } };
  if ((markup?.inline_keyboard ?? []).some(row => row.length > 0)) return undefined;
  const deliver = scheduledDelivery();
  const row = deliver ? await deliver(text ?? '') : undefined;
  return { message_id: 1, chat: { id: chatId ?? 0 }, ...(row === undefined ? {} : { app_row_id: row }) };
};

export const appSurface: SurfaceDescriptor = {
  name: 'app',
  presentation: { surface: 'app', delivery: { text: true, approval: 'native_buttons', reactions: false, attachments: false }, commands: [] },
  native: true,
  offsetKey: 'app_offset',
  healthSource: 'console',
  transport: ['sendMessage'],
  // The app is never a send destination.
  sendsOwn: false,
  sendTarget: false,
  deskSurface: 'app',
  owner: (identity) => Number(identity.get<string>('app_subject') ?? '0') || 0,
};

export const surfaceAdapter = (host: SurfaceHost): SurfaceAdapter => {
  const { storage } = host;
  const identity = storage.kv;
  // An app turn's identity binds to the admitted inbox record and this run scope, as the Telegram host binds to its
  // inbox occurrence.
  const ownerIdentity: NonNullable<SurfaceAdapter['ownerIdentity']> = (turn, scope) => {
    const record = host.activeApp();
    const doName = identity.get<string>('do_name');
    return async () => {
      scope.admit();
      if (!record || record !== host.activeApp() || scope !== host.activeScope() || record.id !== scope.runId || record.attempt !== scope.attempt
        || identity.get<string>('do_name') !== doName || !turnOnSurface(turn, 'app') || turn.text !== record.text
        || turn.conversationRef !== surfaceChatRef('app', appSubjectFor(record.owner)) || turn.traceId !== ownerTurnTrace('app', record.updateId)) throw new ClosedRunError();
      scope.admit();
    };
  };
  return {
    ...appSurface,
    assertConfigured: () => undefined,
    caller: () => appCaller(() => host.scheduledAppDelivery()),
    traceOccurrences: () => [],
    download: async (): Promise<Uint8Array> => { throw new Error('app chat has no attachments'); },
    consoleLink: () => ({ unsupported: 'app_unsupported' }),
    connectGuidance: APP_CONNECT_GUIDANCE,
    ownerIdentity,
    // An app turn's skill owner is the canonical principal its admission verified (the context host hands it over); the
    // custody falls back to that principal, so an app-first owner's book is keyed by identity.
    skillHost: ({ probeCapture }, curated) => ({ prepare: async (turn, contextOwnerId, scope) => {
      if (probeCapture.current !== null) return undefined;
      const assertOwnerIdentity = ownerIdentity(turn, scope, 0);
      await assertOwnerIdentity();
      return curated(turn, contextOwnerId, contextOwnerId, scope, assertOwnerIdentity);
    } }),
    context: ({ healthContext, ownerProfile, core: { episodes } }) => ({
      contextHost: { prepare: async (turn, scope) => {
        const record = host.activeApp();
        if (!record || record.id !== scope.runId || record.attempt !== scope.attempt || turn.text !== record.text) throw new ClosedRunError();
        // The composer runs on every tool round; one health read serves the whole turn.
        let health: ReturnType<typeof healthContext.latest> | undefined;
        const context = await host.appContext(record.owner, record.sessionHash, record.text, record.id, record.admittedAt, scope, { health: () => health ??= healthContext.latest(turn.traceId), ownerProfile, ...(threadOfChain(record.conversationRef) ? { conversationRef: record.conversationRef } : {}) });
        if (context.conversationRef !== record.conversationRef) throw new ClosedRunError();
        return context;
      } },
      history: context => ({ ...indexedConversationStore(canonicalOwnerConversationStore(storage, context, host.logSkippedLoad, threadOfChain(context.conversationRef) ?? undefined), episodes, () => Date.now()),
        noteUnfinished: (line, scope) => host.appInbox().noteLanded(scope.runId, scope.attempt, line),
        recalls: recallReach(identity, context.invocation.verified_authority.principal_ref, threadOfChain(context.conversationRef)) }),
      jobHost: host.jobHostFor(admission => ownerChainRef('app', admission.invocation.verified_authority.principal_ref)),
      ownerProfile,
    }),
  };
};
