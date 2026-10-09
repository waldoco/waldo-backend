import { expect, it, vi } from 'vitest';
import { iMessageCommandSchema } from '@waldo/contracts';
import { fixture } from './connector-fixtures';
import { buildSendCommand, signAndExecute } from '../src/connector/outbound';
import { HostMailboxTransport } from '../src/connector/mailbox-transport';
it('O1 strict builder, stable id, no fallback and whitespace refusal', () => { const f = fixture(); const c = buildSendCommand({ binding: f.account.binding, commandId: 'synthetic-stable', text: 'synthetic-text' }); expect(iMessageCommandSchema.parse(c)).toEqual(c); expect(c.allowSMSFallback).toBe(false); expect(c.commandId).toBe('synthetic-stable'); expect(() => buildSendCommand({ binding: f.account.binding, commandId: 'synthetic-id', text: '  ' })).toThrow('empty_text'); });
it('O2 all non-text features refuse distinctly before enqueue', async () => {
    const f = fixture();
    const t = new HostMailboxTransport(f.mailbox, f.relayStore, f.account.binding.bridgeId, f.account.binding.accountId, { deliveryDeadlineMs: 20, relayMutationDeadlineMs: 80, source: 'synthetic-policy' });
    const enqueue = vi.spyOn(f.mailbox, 'enqueue');
    const base = f.command();
    const send = { ...base, operation: 'send' as const, text: 'synthetic', attachments: [] };
    const target = { ...base.target, messageGuid: 'synthetic-parent', partIndex: 0 };
    const commands = [{ ...send, attachments: [{ reference: 'synthetic-ref', sourceMessageGuid: 'synthetic-parent', filename: 'synthetic-file', mimeType: 'synthetic/type', byteLength: 0, sha256: '0'.repeat(64), kind: 'file', nativeVoice: false }] }, { ...send, formatting: [{ start: 0, length: 1, style: 'bold' }] }, { ...send, effect: 'synthetic-effect' }, { ...send, target }, { ...base, operation: 'react', target, reaction: { kind: 'standard', type: 'love' }, action: 'add', text: undefined, attachments: undefined }, { ...base, operation: 'edit', target, text: 'synthetic', attachments: undefined }, { ...base, operation: 'unsend', target, text: undefined, attachments: undefined }, { ...base, operation: 'typing', active: true, text: undefined, attachments: undefined }, { ...base, operation: 'read', text: undefined, attachments: undefined }].map(c => JSON.parse(JSON.stringify(c)));
    const reasons = [];
    for (const c of commands) {
        const result = await signAndExecute(f.relay, t, f.account, iMessageCommandSchema.parse(c), () => f.clock.now, 'synthetic-nonce');
        expect(result).toMatchObject({ state: 'rejected', disposition: 'not_started' });
        if (result.state === 'rejected')
            reasons.push(result.reason);
    }
    expect(new Set(reasons).size).toBe(9);
    expect(enqueue).not.toHaveBeenCalled();
});
it('O3 group refuses before enqueue', async () => { const f = fixture(); const t = new HostMailboxTransport(f.mailbox, f.relayStore, f.account.binding.bridgeId, f.account.binding.accountId, { deliveryDeadlineMs: 20, relayMutationDeadlineMs: 80, source: 'synthetic-policy' }); const spy = vi.spyOn(f.mailbox, 'enqueue'); expect(await signAndExecute(f.relay, t, f.account, { ...f.command(), binding: { ...f.account.binding, conversationKind: 'group' } }, () => f.clock.now, 'synthetic-nonce')).toMatchObject({ reason: 'group_send_unavailable' }); expect(spy).not.toHaveBeenCalled(); });
