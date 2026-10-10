import { appMessagePartV1Schema } from '../../../contracts/src/app/core';
import type { AppMessage } from './app-api';
import type { AppInboxRecord } from './app-inbox';
import type { ConversationEntry } from '@waldo/contracts';
import { appReplayQueryV1Schema, type AppReplayResultV1 } from '../../../contracts/src/app/replay';
import { appInboxConversationMatches, type AppConversationSelection } from './app-inbox';
import { redactSecretUrls } from './egress-guard';
import { sha256Hex, stableJson } from '../context-composer/canonical';
import type { RunEffectScope } from './run-effect-scope';

export type AppDeliveredMessage = { sequence: number; id: string; text: string; parent_id: string | null; approval_ids: string[]; at: number; conversationRef?: string; parts?: AppMessage['parts'] };
export type AppDeliveryOptions = Readonly<{
  conversationRef?(): string | undefined;
  scope?(): RunEffectScope | undefined;
  deliveryKey?(): string | null;
  // The host rejects volatile health-source payloads by provenance, never by guessing from text.
  assertPersistable?(): void;
  now?(): number;
}>;
const key = (sequence: number) => `app:delivery:${String(sequence).padStart(12, '0')}`;
export const appDeliveryJournal = (storage: DurableObjectStorage, parent: () => string | null, expectedSubject: number, options: AppDeliveryOptions = {}) => ({
  async call(method: string, raw: unknown): Promise<unknown> {
    if (method !== 'sendMessage') return undefined;
    if (!raw || typeof raw !== 'object') throw new Error('invalid app delivery');
    const body = raw as { chat_id?: number; text?: string; parts?: AppMessage['parts']; reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } };
    if (body.chat_id !== expectedSubject || typeof body.text !== 'string') throw new Error('app delivery owner mismatch');
    const scope = options.scope?.(); scope?.admit();
    options.assertPersistable?.();
    const conversationRef = options.conversationRef?.(), parentId = parent(), text = redactSecretUrls(body.text).text;
    if (conversationRef !== undefined && (!conversationRef || conversationRef.length > 256 || /[\u0000-\u001f]/.test(conversationRef))) throw new Error('invalid app delivery conversation');
    const approvalIds = [...new Set((body.reply_markup?.inline_keyboard ?? []).flat().flatMap(button => {
      const match = /^(?:a|s|u):([A-Za-z0-9_-]{1,80})$/.exec(button.callback_data ?? '');
      return match ? [match[1]!] : [];
    }))];
    const parts = body.parts?.map(part => appMessagePartV1Schema.parse(part));
    if (parts?.some(part => part.type !== 'protected_health') || (parts && body.text !== '')) throw new Error('invalid protected app metadata');
    const deliveryKey = options.deliveryKey?.();
    if (deliveryKey && deliveryKey.length > 256) throw new Error('invalid app delivery identity');
    const receiptKey = deliveryKey ? `app:delivery-receipt:${await sha256Hex(deliveryKey)}` : null;
    const digest = receiptKey ? await sha256Hex(stableJson({ text, parentId, conversationRef: conversationRef ?? null, approvalIds, parts: parts ?? null })) : null;
    // The acknowledgement names an actual durable inbox item, not provider delivery.
    const publish = () => {
      options.assertPersistable?.();
      if (receiptKey) {
        const receipt = storage.kv.get<{ digest: string; sequence: number }>(receiptKey);
        if (receipt) {
          if (receipt.digest !== digest || !storage.kv.get(key(receipt.sequence))) throw new Error('app delivery identity conflict');
          return { message_id: receipt.sequence, chat: { id: expectedSubject }, custody: 'owner_app_inbox' as const };
        }
      }
      const sequence = (storage.kv.get<number>('app:delivery:sequence') ?? 0) + 1;
      const message: AppDeliveredMessage = { sequence, id: `app-delivery-${sequence}`, text, parent_id: parentId, approval_ids: approvalIds, at: options.now?.() ?? Date.now(), ...(conversationRef ? { conversationRef } : {}), ...(parts ? { parts } : {}) };
      storage.kv.put(key(sequence), message); storage.kv.put('app:delivery:sequence', sequence);
      if (receiptKey) storage.kv.put(receiptKey, { digest, sequence });
      return { message_id: sequence, chat: { id: expectedSubject }, custody: 'owner_app_inbox' as const };
    };
    return scope ? scope.commit(publish) : storage.transactionSync(publish);
  },
  messages(selection?: AppConversationSelection): AppDeliveredMessage[] { return [...storage.kv.list<AppDeliveredMessage>({ prefix: 'app:delivery:' })].filter(([name]) => name !== 'app:delivery:sequence')
    .map(([, value]) => value).filter(row => !selection || row.conversationRef === selection.conversationRef || (!row.conversationRef && selection.includeLegacyMain === true)).sort((a, b) => a.sequence - b.sequence); },
  replay(cursor: string | null, limit = 50, selection?: AppConversationSelection): AppReplayResultV1 {
    const query = appReplayQueryV1Schema.parse({ ...(cursor !== null ? { cursor } : {}), limit });
    const after = query.cursor ? Number(query.cursor) : 0;
    const rows = this.messages(selection).filter(row => row.sequence > after).slice(0, query.limit!);
    return { version: 1, events: rows.map(row => ({ sequence: row.sequence, type: 'message' as const, occurred_at: row.at, approval_ids: row.approval_ids,
      message: { id: row.id, role: 'assistant' as const, text: row.text, channel: 'app', parent_id: row.parent_id, parts: row.parts ?? [{ type: 'text' as const, text: row.text }] } })), next_cursor: String(rows.at(-1)?.sequence ?? after) };
  },
  eraseConversation(conversationRef: string): number {
    return storage.transactionSync(() => {
      const rows = this.messages({ conversationRef });
      const sequences = new Set(rows.map(row => row.sequence));
      for (const row of rows) storage.kv.delete(key(row.sequence));
      for (const [name, receipt] of storage.kv.list<{ sequence: number }>({ prefix: 'app:delivery-receipt:' })) if (sequences.has(receipt.sequence)) storage.kv.delete(name);
      return rows.length;
    });
  },
});

export function appOperationMessages(entries: readonly ConversationEntry[], operations: readonly AppInboxRecord[], selection?: AppConversationSelection): AppMessage[] {
  return operations.filter(row => row.state !== 'completed' && !row.erased && appInboxConversationMatches(row, selection)).flatMap(row => {
    const messages: AppMessage[] = [];
    if (row.text && !entries.some(entry => entry.id === row.id)) messages.push({ id: row.id, role: 'user', text: row.text, parts: [{ type: 'text', text: row.text }], channel: 'app', parent_id: null });
    if (row.state === 'interrupted' || row.state === 'revoked') {
      const message = row.state === 'revoked' ? 'This queued turn stopped because its session was revoked or expired.'
        : row.closedReason === 'cancelled' || row.closedReason === 'archived' || row.closedReason === 'thread_changed'
          ? `This turn stopped because its thread ${row.closedReason === 'archived' ? 'was archived' : row.closedReason === 'thread_changed' ? 'changed' : 'was cancelled'}.${row.effectsUnconfirmed ? ' Effects already attempted remain unconfirmed and will not be replayed automatically.' : ' Execution did not begin.'}`
          : 'This turn was interrupted. Its effects are unconfirmed; completed actions will not be replayed automatically.';
      messages.push({ id: `${row.id}:status`, role: 'assistant', text: message, parts: [{ type: 'operation', operation_id: row.id, state: row.state, message }], channel: 'app', parent_id: row.id });
    }
    return messages;
  });
}
