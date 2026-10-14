import { canonicalOwnerConversationStore } from '../../conversation/canonical-owner-store';
import { rearmSharedAlarm } from '../../scheduler/alarm-slot';
import { recallReach } from '../app-threads';
import { redactSecretUrls } from '../egress-guard';
import { iMessageComposition } from '../imessage/bridge-do';
import { iMessageConsoleRoute } from '../imessage/console-link';
import { IMessageFinalOutbox } from '../imessage/final-outbox';
import { IMessageOwnerInbox } from '../imessage/owner-inbox';
import { drainIMessageOutbox, iMessageOwnerContext } from '../imessage/owner-runtime';
import type { SurfaceAdapter, SurfaceDescriptor, SurfaceHost } from '../owner-runtime';
import { ClosedRunError } from '../run-effect-scope';
import { appCaller } from './app';

// iMessage is plain text and can never approve: its turns use the app's desk rules, so cards show only in the app.
export const imessageSurface: SurfaceDescriptor = {
  name: 'imessage',
  presentation: { surface: 'imessage', delivery: { text: true, approval: 'none', reactions: false, attachments: false }, commands: [] },
  native: true,
  offsetKey: 'imessage_offset',
  healthSource: 'console',
  transport: ['sendMessage'],
  sendsOwn: true,
  sendTarget: false,
  deskSurface: 'app',
  owner: (identity) => Number(identity.get<string>('imessage_subject') ?? '0') || 0,
};

// The sender-to-owner mapping is the bridge's admission (imessage/owner-runtime); this adapter only binds a turn to the
// record that admission wrote.
export const surfaceAdapter = (host: SurfaceHost): SurfaceAdapter => {
  const { storage } = host;
  return {
    ...imessageSurface,
    assertConfigured: () => undefined,
    caller: () => appCaller(),
    traceOccurrences: () => [],
    download: async (): Promise<Uint8Array> => { throw new Error('imessage chat has no attachments'); },
    consoleLink: () => iMessageConsoleRoute(storage, () => host.activeIMessage()),
    context: ({ ownerProfile }) => ({
      contextHost: { prepare: async (turn, scope) => {
        const record = host.activeIMessage();
        if (!record || record.id !== scope.runId || record.attempt !== scope.attempt || turn.text !== record.text) throw new ClosedRunError();
        return iMessageOwnerContext(host.imessageHost(), record, scope, { ownerProfile });
      } },
      history: context => ({ ...canonicalOwnerConversationStore(storage, context), recalls: recallReach(storage.kv, context.invocation.verified_authority.principal_ref, null) }),
      ownerProfile,
    }),
    queueFinal: () => async (turn, payload) => {
      const record = host.activeIMessage();
      if (!turn.runScope || !record || record.id !== turn.runScope.runId || record.attempt !== turn.runScope.attempt || record.updateId !== turn.updateId) throw new ClosedRunError();
      const text = redactSecretUrls(payload.text).text;
      turn.runScope.commit(() => { new IMessageFinalOutbox(storage).freeze(record, text); new IMessageOwnerInbox(storage).closeFinal(record); });
      host.waitUntil(host.serial(() => drainIMessageOutbox(host.imessageHost(), iMessageComposition(host.imessageHost().env)?.policy.replyHandoffMaxAgeMs ?? 0).then(() => rearmSharedAlarm(storage, null, Date.now()))).catch(() => { console.error('imessage outbox drain deferred'); }));
    },
  };
};
