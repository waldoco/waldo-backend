import type { LLMAttachment } from '@waldo/contracts';
import { onlyArtifacts, quarantineArtifacts } from '../../security/artifact-hygiene';
import { ownerTurnAttachments, type OwnerTurnEnvelope, type ReplyContext } from '../owner-turn-envelope';
import type { RunEffectScope } from '../run-effect-scope';
import { splitTelegramText } from '../telegram-api';
import type { WhatsAppCall, WaIngressMessage } from '../whatsapp-api';

// Pure transport adapter, not an owner-authentication or approval boundary. Core must
// admit the sender/occurrence first and supply its own RunEffectScope and resolved media.
export type WhatsAppSurfaceMessage = WaIngressMessage & Readonly<{
  document?: { id?: string; caption?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
}>;
export type WhatsAppAdmittedUpdate = Readonly<{
  message: WhatsAppSurfaceMessage;
  traceId: string;
  runScope: RunEffectScope;
  attachments?: readonly LLMAttachment[];
  transcript?: string;
  mediaNote?: string;
  replyTo?: ReplyContext;
}>;
export type WhatsAppSurfaceOutput =
  | Readonly<{ kind: 'reply'; text: string }>
  | Readonly<{ kind: 'card'; text: string; choices: readonly Readonly<{ id: string; title: string }>[]; listTitle?: string }>
  | Readonly<{ kind: 'file'; mediaId: string; filename: string }>;
export type WhatsAppSurfaceReceipt = Readonly<{ providerMessageId: string }>;
export class WhatsAppSurfaceSendError extends Error {
  constructor(readonly receipts: readonly WhatsAppSurfaceReceipt[], readonly failedPart: number, cause: unknown) {
    super(`WhatsApp send uncertain: ${cause instanceof Error ? cause.message : 'provider call failed'}`, { cause });
  }
}

// Provider constraints, not task/permission gates. Sources:
// https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages/
// https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages/
// Use the conservative 1,024 interactive body bound for both card forms.
export const WHATSAPP_SURFACE_LIMITS = Object.freeze({ textMax: 4096, buttons: 3, listRows: 10, interactiveTextMax: 1024, attachmentsOut: true });
const bounded = (value: string | undefined, max: number, field: string): string => {
  if (!value?.trim() || value.length > max) throw new Error(`WhatsApp invalid ${field}`);
  return value;
};
const cleanOwnerText = (text: string): string => {
  const q = quarantineArtifacts(text);
  return q.kinds.length === 0 ? text : onlyArtifacts(q) ? `[quarantined: ${q.kinds.join('/')} artifact - see your WhatsApp thread]` : q.text;
};

// Selection ids are transport data only. Core resolves them against a current,
// owner-bound proposal. The user-visible label never becomes approval evidence.
export const whatsappSelection = (message: WhatsAppSurfaceMessage): Readonly<{ id: string; messageId: string }> | undefined => {
  if (message.type !== 'interactive') return undefined;
  const interactive = message.interactive;
  const selection = interactive?.type === 'button_reply' ? interactive.button_reply : interactive?.type === 'list_reply' ? interactive.list_reply : undefined;
  if (!selection) throw new Error('WhatsApp unsupported interactive selection');
  return { id: bounded(selection.id, interactive?.type === 'button_reply' ? 256 : 200, 'selection id'), messageId: bounded(message.id, Number.MAX_SAFE_INTEGER, 'message id') };
};
const providerReceipt = (ack: unknown): WhatsAppSurfaceReceipt => {
  if (!ack || typeof ack !== 'object') throw new Error('invalid WhatsApp acknowledgement');
  const messages = (ack as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length !== 1 || !messages[0] || typeof messages[0] !== 'object') throw new Error('invalid WhatsApp acknowledgement');
  const id = (messages[0] as { id?: unknown }).id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('invalid WhatsApp acknowledgement');
  // Acceptance is not delivery. Delivery/quality status remains Core's receipt watcher.
  return { providerMessageId: id };
};

export const createWhatsAppSurfaceAdapter = (options: Readonly<{ call: WhatsAppCall; recipient: string; conversationRef: string }>) => {
  const recipient = bounded(options.recipient, Number.MAX_SAFE_INTEGER, 'recipient');
  const conversationRef = bounded(options.conversationRef, Number.MAX_SAFE_INTEGER, 'conversation');
  return {
    surface: 'whatsapp' as const,
    limits: WHATSAPP_SURFACE_LIMITS,
    toEnvelope(update: WhatsAppAdmittedUpdate): OwnerTurnEnvelope {
      const { message } = update;
      if (message.from !== recipient) throw new Error('WhatsApp sender does not match admitted route');
      bounded(update.traceId, Number.MAX_SAFE_INTEGER, 'trace id');
      const id = bounded(message.id, Number.MAX_SAFE_INTEGER, 'message id');
      let text: string;
      if (message.type === 'text') text = bounded(message.text?.body, Number.MAX_SAFE_INTEGER, 'inbound text');
      else if (message.type === 'image' || message.type === 'document') {
        if (!update.attachments?.length) throw new Error('WhatsApp media must be host-resolved');
        text = (message.type === 'image' ? message.image?.caption : message.document?.caption) ?? '';
      } else if (message.type === 'audio') {
        if (update.transcript === undefined && !update.mediaNote) throw new Error('WhatsApp voice must be host-resolved');
        text = update.transcript ?? '';
      } else throw new Error('WhatsApp turn type requires host handling');
      const envelope: OwnerTurnEnvelope = {
        traceId: update.traceId, conversationRef, surface: 'whatsapp', service: 'WhatsApp',
        presentation: { surface: 'whatsapp', delivery: { text: true, approval: 'native_buttons', reactions: false, attachments: true }, commands: [] },
        text: cleanOwnerText(text), runScope: update.runScope, messageRef: { id, conversationRef },
        ...(update.attachments ? { attachments: update.attachments } : {}),
        ...(update.mediaNote ? { mediaNote: update.mediaNote } : {}),
        ...(update.replyTo ? { replyTo: update.replyTo } : {}),
      };
      ownerTurnAttachments(envelope);
      return envelope;
    },
    async render(targetConversationRef: string, output: WhatsAppSurfaceOutput): Promise<readonly WhatsAppSurfaceReceipt[]> {
      if (targetConversationRef !== conversationRef) throw new Error('WhatsApp conversation does not match admitted route');
      // Build and validate the complete send plan before the first external call.
      const plan: object[] = [];
      const addText = (text: string): void => { for (const body of splitTelegramText(text, WHATSAPP_SURFACE_LIMITS.textMax)) plan.push({ to: recipient, type: 'text', text: { body } }); };
      if (output.kind === 'reply') addText(bounded(output.text, Number.MAX_SAFE_INTEGER, 'reply text'));
      else if (output.kind === 'file') {
        plan.push({ to: recipient, type: 'document', document: { id: bounded(output.mediaId, Number.MAX_SAFE_INTEGER, 'media id'), filename: bounded(output.filename, Number.MAX_SAFE_INTEGER, 'filename') } });
      } else if (output.kind === 'card') {
        const { choices } = output;
        if (choices.length === 0 || choices.length > WHATSAPP_SURFACE_LIMITS.listRows) throw new Error('WhatsApp invalid choice count');
        const buttons = choices.length <= WHATSAPP_SURFACE_LIMITS.buttons;
        const ids = new Set<string>(), titles = new Set<string>();
        const rows = choices.map(choice => {
          const id = bounded(choice.id, buttons ? 256 : 200, 'choice id');
          if (id.trim() !== id) throw new Error('WhatsApp invalid choice id');
          const title = bounded(choice.title, buttons ? 20 : 24, 'choice title');
          if (ids.has(id) || (buttons && titles.has(title))) throw new Error('WhatsApp duplicate choice');
          ids.add(id); titles.add(title);
          return { id, title };
        });
        const action = buttons ? { buttons: rows.map(reply => ({ type: 'reply', reply })) } : { button: bounded(output.listTitle ?? 'Choose', 20, 'list title'), sections: [{ rows }] };
        const chunks = splitTelegramText(bounded(output.text, Number.MAX_SAFE_INTEGER, 'card text'), WHATSAPP_SURFACE_LIMITS.interactiveTextMax);
        for (const chunk of chunks.slice(0, -1)) addText(chunk);
        plan.push({ to: recipient, type: 'interactive', interactive: { type: buttons ? 'button' : 'list', body: { text: chunks[chunks.length - 1]! }, action } });
      } else throw new Error('WhatsApp unsupported surface output');
      const receipts: WhatsAppSurfaceReceipt[] = [];
      for (let part = 0; part < plan.length; part++) {
        try { receipts.push(providerReceipt(await options.call(plan[part]!))); }
        catch (cause) { throw new WhatsAppSurfaceSendError([...receipts], part, cause); }
      }
      return receipts;
    },
  };
};
