import type { ConsoleLinkRoute } from '../console-link';
import { ClosedRunError } from '../run-effect-scope';
import type { ConsoleLinkTurn } from '../../tools/live/console-link';
import { sha256Hex } from './crypto';
import { IMessageFinalOutbox } from './final-outbox';
import type { IMessageInboxRecord } from './owner-inbox';

// The link answers the inbound message that asked for it: a server-originated record frozen on that message's own bridge,
// binding and revision, which the bridge rechecks before it publishes. The outbox drain that follows every iMessage turn
// hands it over ahead of the reply to the same message, which was frozen after it.
const COMMAND_PREFIX = { console: 'wcl', connect: 'wcn' } as const;
export const iMessageConsoleRoute = (storage: DurableObjectStorage, running: () => IMessageInboxRecord | null, kind: 'console' | 'connect' = 'console'): ConsoleLinkRoute => {
  const current = (turn: ConsoleLinkTurn): IMessageInboxRecord & { attempt: string } => {
    const record = running();
    if (!turn.runScope || !record?.attempt || record.id !== turn.runScope.runId || record.attempt !== turn.runScope.attempt) throw new ClosedRunError();
    return record as IMessageInboxRecord & { attempt: string };
  };
  return {
    surface: 'imessage',
    sent: (turn) => new IMessageFinalOutbox(storage).get(`${kind}:${current(turn).id}`) !== null,
    async deliver(text, turn) {
      const record = current(turn);
      const commandId = `${COMMAND_PREFIX[kind]}_${(await sha256Hex(`${kind}\u0000${record.dedupKey}`)).slice(0, 40)}`;
      turn.runScope!.commit(() => new IMessageFinalOutbox(storage).freeze({ ...record, commandId }, text, kind));
      return true;
    },
  };
};
