import { iMessageEventSchema, type IMessageEvent } from '@waldo/contracts';
import type { MailboxStore } from './mailbox-store';
export function classifyInboundEvent(input: IMessageEvent): 'turn' | 'receipt' | 'ignorable' | 'unsupported' {
    const event = iMessageEventSchema.parse(input);
    if (event.kind === 'receipt')
        return 'receipt';
    if (event.kind === 'unsupported')
        return 'unsupported';
    return event.kind === 'message' && !event.isGroup && !event.isFromMe && event.service === 'iMessage' ? 'turn' : 'ignorable';
}
export function correlateReceipt(store: Pick<MailboxStore, 'snapshot'>, input: IMessageEvent): {
    commandId: string | null;
} {
    const event = iMessageEventSchema.parse(input);
    if (event.kind !== 'receipt')
        return { commandId: null };
    const row = store.snapshot().sentMessages.find(m => m.bridgeId === event.bridgeId && m.accountId === event.accountId && m.messageGuid === event.target.messageGuid);
    return { commandId: row?.commandId ?? null };
}
