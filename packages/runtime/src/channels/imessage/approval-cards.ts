import type { RunEffectScope } from '../run-effect-scope';
import { sha256Hex } from './crypto';
import { IMessageFinalOutbox, targetOf } from './final-outbox';
import type { IMessageInboxRecord } from './owner-inbox';

export type IMessageRunningTurn = Readonly<{ record: IMessageInboxRecord; scope: RunEffectScope }>;

// The approval desk's caller on iMessage. A card is its own message to the sender the running turn answers, frozen under that
// turn's scope beside its reply, so the outbox drain after the turn hands it to the bridge ahead of the reply. Outside a turn
// there is no sender to answer, so it returns no message and the desk keeps the card for the owner's next iMessage.
// iMessage shows no buttons: a card that asks for any is refused, never sent without them.
export const iMessageApprovalCaller = (storage: DurableObjectStorage, running: () => IMessageRunningTurn | null) => async (method: string, body: unknown): Promise<unknown> => {
  if (method !== 'sendMessage') return undefined;
  const { text, reply_markup: markup } = body as { text?: string; reply_markup?: { inline_keyboard?: readonly (readonly unknown[])[] } };
  const turn = running();
  if (!turn || !text || (markup?.inline_keyboard ?? []).some(row => row.length > 0)) return undefined;
  const { record, scope } = turn;
  const outbox = new IMessageFinalOutbox(storage), prefix = `proactive:card:${record.id}:`;
  const index = outbox.records().filter(row => row.replyRef.startsWith(prefix)).length + 1;
  const commandId = `wac_${(await sha256Hex(`card\u0000${record.dedupKey}\u0000${index}`)).slice(0, 40)}`;
  scope.commit(() => outbox.freezeProactive(`card:${record.id}:${index}`, commandId, targetOf(record), text));
  return { messages: [{ id: commandId }] };
};
