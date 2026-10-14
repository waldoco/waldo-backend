import { ownerChainRef, surfaceChatRef } from '../../context-composer/owner-turn';
import { canonicalOwnerConversationStore } from '../../conversation/canonical-owner-store';
import { appSubjectFor } from '../app-api';
import { recallReach, threadOfChain } from '../app-threads';
import { indexedConversationStore } from '../episodes';
import { ownerTurnTrace } from '../owner-turn-envelope';
import { turnOnSurface, type SurfaceAdapter, type SurfaceDescriptor, type SurfaceHost } from '../owner-runtime';
import { ClosedRunError } from '../run-effect-scope';
import { APP_CONNECT_GUIDANCE, appCaller } from './app';

// The app's surface adapter lives apart from app.ts: approvals.ts reads the card helpers there, and this file's
// imports reach the console modules that import approvals.
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
