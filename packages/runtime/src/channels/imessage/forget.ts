import { literalTextRedactor } from '@waldo/contracts';
import type { RunEffectScope } from '../run-effect-scope';
import { IMessageFinalOutbox } from './final-outbox';
import { IMessageOwnerInbox } from './owner-inbox';

/**
 * Literal owner forget for the iMessage owner-side KV records (`imessage:inbox-record:*`,
 * `imessage:outbox-record:*`). Runs in the forgetting turn's commit when there is one. The bridge Durable
 * Object's own copies (deliveries, held events) are separate custody and are not reached here.
 */
export const redactIMessageEntries = (storage: DurableObjectStorage, texts: readonly string[], marker: string, scope?: RunEffectScope): Readonly<{ rewritten: number; remaining: number }> => {
  const needles = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  if (!needles.length) return { rewritten: 0, remaining: 0 };
  const redact = literalTextRedactor(needles, marker);
  const holds = (text: string) => needles.some((needle) => text.toLowerCase().includes(needle.toLowerCase()));
  let out = { rewritten: 0, remaining: 0 };
  const work = () => {
    const inbox = new IMessageOwnerInbox(storage).forget(redact, holds), outbox = new IMessageFinalOutbox(storage).forget(redact, holds);
    out = { rewritten: inbox.rewritten + outbox.rewritten, remaining: inbox.remaining + outbox.remaining };
  };
  if (scope) scope.commit(work); else storage.transactionSync(work);
  return out;
};
