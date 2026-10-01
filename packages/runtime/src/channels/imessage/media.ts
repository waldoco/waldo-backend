import { iMessageAttachmentSchema, iMessageBindingSchema, llmAttachmentSchema, LLM_ATTACHMENTS_MAX, type IMessageEvent, type LLMAttachment } from '@waldo/contracts';
import type { IMessageAdmissionGrant } from './admission';
import { ownerTurnAttachments } from '../owner-turn-envelope';
import { toBase64 } from '../telegram-media';

type File = ReturnType<typeof iMessageAttachmentSchema.parse>;
export type IMessageMediaScope = Readonly<{
  grant: IMessageAdmissionGrant; databaseGeneration: string; eventId: string;
  messageGuid: string; partIndex: number; file: File;
}>;
export const mediaScope = (grant: IMessageAdmissionGrant, event: IMessageEvent, file: File): IMessageMediaScope => Object.freeze({
  grant: Object.freeze({ binding: Object.freeze(iMessageBindingSchema.parse(grant.binding)), revision: grant.revision, doName: grant.doName }),
  databaseGeneration: event.cursor.databaseGeneration, eventId: event.eventId,
  messageGuid: event.messageGuid, partIndex: event.partIndex, file: Object.freeze(iMessageAttachmentSchema.parse(file)),
});
export type IMessageMediaTicket = Readonly<Record<string, never>>;
type ReadMedia = Readonly<{ bytes: Uint8Array; mimeType: string; kind: File['kind'] }>;
export type IMessageMediaStore = Readonly<{
  issue(scope: IMessageMediaScope): Promise<IMessageMediaTicket>;
  read(ticket: IMessageMediaTicket, scope: IMessageMediaScope): Promise<ReadMedia>;
}>;
type ContentResult = Readonly<{ mimeType: string; kind: File['kind'] }> & (
  Readonly<{ state: 'loaded'; attachment: LLMAttachment }> | Readonly<{ state: 'unsupported'; reason: string }>
);
export type IMessageMediaStatus = Readonly<{ scope: IMessageMediaScope; state: 'loaded' | 'unsupported'; reason?: string }>;
export type IMessageMediaDeps = Readonly<{
  store: IMessageMediaStore;
  content(scope: IMessageMediaScope, bytes: Uint8Array): Promise<ContentResult>;
}>;
const scopeKey = (scope: IMessageMediaScope) => JSON.stringify(['owners', scope.grant.binding.ownerId, scope]);

export const createFixtureIMessageMediaStore = (sources: readonly (ReadMedia & { scope: IMessageMediaScope })[],
  current: (grant: IMessageAdmissionGrant) => boolean = () => false): IMessageMediaStore => {
  const rows = new Map(sources.map(source => [scopeKey(source.scope), { bytes: source.bytes.slice(), mimeType: source.mimeType, kind: source.kind }]));
  const tickets = new WeakMap<IMessageMediaTicket, string>();
  return {
    async issue(scope) {
      if (current(scope.grant) !== true) throw new Error('iMessage media ticket rejected');
      const key = scopeKey(scope);
      if (!rows.has(key)) throw new Error('iMessage media unavailable');
      const ticket = Object.freeze({}); tickets.set(ticket, key); return ticket;
    },
    async read(ticket, scope) {
      if (current(scope.grant) !== true) throw new Error('iMessage media ticket rejected');
      const key = scopeKey(scope);
      if (tickets.get(ticket) !== key) throw new Error('iMessage media ticket rejected');
      tickets.delete(ticket);
      const row = rows.get(key);
      if (!row) throw new Error('iMessage media unavailable');
      return { ...row, bytes: row.bytes.slice() };
    },
  };
};

export const loadIMessageMedia = async (event: Extract<IMessageEvent, { kind: 'message' }>, grant: IMessageAdmissionGrant,
  deps: IMessageMediaDeps, current: () => void) => {
  if (event.attachments.length > LLM_ATTACHMENTS_MAX) throw new Error('iMessage excess media');
  if (new Set(event.attachments.map(file => file.reference)).size !== event.attachments.length) throw new Error('iMessage ambiguous media');
  const attachments: LLMAttachment[] = [];
  const statuses: IMessageMediaStatus[] = [];
  for (const file of event.attachments) {
    if (file.nativeVoice && file.kind !== 'audio') throw new Error('iMessage media mismatch');
    const scope = mediaScope(grant, event, file);
    current();
    const ticket = await deps.store.issue(scope); current();
    const source = await deps.store.read(ticket, scope); current();
    const bytes = source.bytes.slice();
    if (bytes.length !== file.byteLength || source.mimeType !== file.mimeType || source.kind !== file.kind) throw new Error('iMessage media mismatch');
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer); current();
    const hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== file.sha256) throw new Error('iMessage media mismatch');
    const result = await deps.content(scope, bytes.slice()); current();
    if (result.mimeType !== file.mimeType || result.kind !== file.kind) throw new Error('iMessage media mismatch');
    if (result.state === 'unsupported') {
      if (!result.reason.trim()) throw new Error('iMessage media mismatch');
      statuses.push({ scope, state: 'unsupported', reason: result.reason }); continue;
    }
    const attachment = llmAttachmentSchema.parse(result.attachment);
    if (!['image', 'document', 'file'].includes(file.kind) || file.nativeVoice ||
      attachment.kind !== (file.kind === 'image' ? 'image' : 'file') || attachment.mime_type !== file.mimeType ||
      attachment.filename !== file.filename || attachment.data_base64 !== toBase64(bytes)) throw new Error('iMessage media mismatch');
    attachments.push(attachment); statuses.push({ scope, state: 'loaded' });
  }
  ownerTurnAttachments({ surface: 'imessage', traceId: event.eventId, conversationRef: event.chatGuid, text: event.text, attachments });
  current();
  return { attachments, statuses };
};
