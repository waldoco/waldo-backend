import { iMessageBindingSchema, iMessageCommandSchema, type IMessageBinding, type IMessageCommand, type IMessageResult } from '@waldo/contracts';
import { signRelayRequest, type SignedRelay, type TrustedRelayAccount } from '../relay';
import type { HostMailboxTransport } from './mailbox-transport';
export function buildSendCommand(input: {
    binding: IMessageBinding;
    commandId: string;
    text: string;
}): IMessageCommand {
    if (!input.text.trim())
        throw new Error('empty_text');
    const binding = iMessageBindingSchema.parse(input.binding);
    return iMessageCommandSchema.parse({ version: 1, commandId: input.commandId, ownerId: binding.ownerId, binding,
        target: { bridgeId: binding.bridgeId, accountId: binding.accountId, chatGuid: binding.chatGuid }, service: 'iMessage', allowSMSFallback: false,
        operation: 'send', text: input.text, attachments: [] });
}
export function textOnlyRefusal(input: IMessageCommand): IMessageResult | null {
    const c = iMessageCommandSchema.parse(input);
    const reason = c.binding.conversationKind !== 'direct' ? 'group_send_unavailable'
        : c.operation !== 'send' ? c.operation + '_unavailable'
            : c.attachments.length ? 'attachment_transfer_unavailable'
                : c.formatting?.length ? 'formatting_unavailable'
                    : c.effect !== undefined ? 'effect_unavailable'
                        : c.target.messageGuid !== undefined ? 'reply_guid_unavailable' : null;
    return reason ? { version: 1, commandId: c.commandId, target: c.target, state: 'rejected', disposition: 'not_started', reason } : null;
}
export async function signAndExecute(relay: SignedRelay, transport: HostMailboxTransport, account: TrustedRelayAccount, input: IMessageCommand, now: () => number, nonce: string): Promise<IMessageResult> {
    const command = iMessageCommandSchema.parse(input), refused = textOnlyRefusal(command);
    if (refused)
        return refused;
    const body = JSON.stringify(command), headers = signRelayRequest(body, { version: 1, bridgeId: command.binding.bridgeId,
        accountId: command.binding.accountId, atMs: now(), nonce }, account.key);
    return relay.execute(body, headers, transport.forSignedCommand(body, headers));
}
