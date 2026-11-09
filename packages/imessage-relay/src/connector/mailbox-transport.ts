import { z } from 'zod';
import { disabledIMessageCapabilities, iMessageCommandSchema, iMessageEventSchema, opaqueIMessageIdSchema, type IMessageCommand, type IMessageResult } from '@waldo/contracts';
import type { IMessageTransport } from '../transport';
import type { RelayStore } from '../store';
import type { RelayHeaders } from '../relay';
import { CommandMailbox } from './mailbox';
import { textOnlyRefusal } from './outbound';
import type { SignedMailboxCommand } from './mailbox-store';
const policySchema = z.strictObject({ deliveryDeadlineMs: z.int().positive(), relayMutationDeadlineMs: z.int().positive(), source: opaqueIMessageIdSchema })
    .refine(p => p.deliveryDeadlineMs < p.relayMutationDeadlineMs, 'delivery deadline must precede relay deadline');
export type HostMailboxPolicy = z.infer<typeof policySchema>;
export class HostMailboxTransport implements IMessageTransport {
    readonly policy: HostMailboxPolicy;
    constructor(private mailbox: CommandMailbox, private relayStore: Pick<RelayStore, 'snapshot'>, private bridgeId: string, private accountId: string, policy: HostMailboxPolicy, private signed?: SignedMailboxCommand) {
        opaqueIMessageIdSchema.parse(bridgeId);
        opaqueIMessageIdSchema.parse(accountId);
        this.policy = policySchema.parse(policy);
    }
    /** An immutable per-execution envelope prevents concurrent submissions replacing signed bytes. */
    forSignedCommand(body: string, headers: RelayHeaders): IMessageTransport {
        return new HostMailboxTransport(this.mailbox, this.relayStore, this.bridgeId, this.accountId, this.policy, { body, headers: structuredClone(headers) });
    }
    async probe() {
        return this.mailbox.capabilities(this.bridgeId, this.accountId)
            ?? { ...disabledIMessageCapabilities(this.bridgeId, this.accountId), readiness: 'offline' as const };
    }
    async history(generation: string, cursor: string | null) {
        // Cloud admission view only: acknowledged bodies are unavailable, never native Mac history.
        const state = this.relayStore.snapshot(), stream = state.streams.find(s => s.bridgeId === this.bridgeId && s.accountId === this.accountId);
        if (!stream || stream.generation !== generation)
            throw new Error('cloud history generation mismatch');
        const rows = state.events.filter(e => e.bridgeId === this.bridgeId && e.accountId === this.accountId && e.generation === generation);
        // Cursors are opaque. Locate an exact retained cursor in persisted admission order.
        const retained = rows.flatMap(row => row.body ? [{ row, event: iMessageEventSchema.parse(JSON.parse(row.body)) }] : []);
        const index = cursor === null ? -1 : retained.findIndex(e => e.event.cursor.value === cursor);
        if (cursor !== null && index < 0 && cursor !== stream.cursor)
            throw new Error('cloud history cursor mismatch');
        const events = cursor === stream.cursor ? [] : retained.slice(index + 1).filter(e => e.row.state === 'pending').map(e => e.event);
        return { generation, cursor: events.at(-1)?.cursor.value ?? cursor, events };
    }
    async execute(input: IMessageCommand): Promise<IMessageResult> {
        const command = iMessageCommandSchema.parse(input), refused = textOnlyRefusal(command);
        if (refused)
            return refused;
        if (!this.signed || JSON.stringify(iMessageCommandSchema.parse(JSON.parse(this.signed.body))) !== JSON.stringify(command)
            || command.binding.bridgeId !== this.bridgeId || command.binding.accountId !== this.accountId)
            throw new Error('signed_command_required');
        const delivery = this.mailbox.enqueue(this.signed.body, this.signed.headers);
        await this.mailbox.awaitDelivery(delivery.deliveryId, this.policy.deliveryDeadlineMs);
        // Withdraw rechecks atomically: a pull winning this race makes the effect uncertain.
        if (this.mailbox.withdraw(delivery.deliveryId))
            return { version: 1, commandId: command.commandId, target: command.target, state: 'rejected', disposition: 'not_started', reason: 'host_not_pulled' };
        const result = await this.mailbox.awaitResult(delivery.deliveryId, this.policy.relayMutationDeadlineMs);
        // The wire accepts S0 delivered evidence, but this text sender never claims delivery.
        if (result.state === 'delivered')
            throw new Error('delivery_requires_receipt_event');
        return result;
    }
}
