import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { iMessageBindingSchema, iMessageCapabilitiesSchema, iMessageCommandSchema, iMessageResultSchema, opaqueIMessageIdSchema as id, type IMessageCapabilities } from '@waldo/contracts';
import { signRelayRequest, type TrustedRelayAccount, type RelayHeaders } from '../relay';
import { MailboxStore, mailboxHeadersSchema, type MailboxState, type MailboxDelivery } from './mailbox-store';
const policySchema = z.strictObject({ signatureMaxAgeMs: z.int().positive(), maxRecords: z.int().positive(), maxRequestBytes: z.int().positive(), pullMaxWaitMs: z.int().nonnegative(), capabilityMaxAgeMs: z.int().positive(), source: id });
export type MailboxPolicy = z.infer<typeof policySchema>;
const scope = { version: z.literal(1), bridgeId: id, accountId: id };
const resultEnvelope = z.strictObject({ ...scope, deliveryId: id, commandId: id, commandDigest: z.string().regex(/^[a-f0-9]{64}$/), result: iMessageResultSchema });
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const same = (a: {
    bridgeId: string;
    accountId: string;
}, b: {
    bridgeId: string;
    accountId: string;
}) => a.bridgeId === b.bridgeId && a.accountId === b.accountId;
export class CommandMailbox {
    readonly policy: MailboxPolicy;
    constructor(readonly store: MailboxStore, policy: MailboxPolicy, private account: (bridgeId: string, accountId: string) => TrustedRelayAccount | null, private now = () => Date.now()) {
        this.policy = policySchema.parse(policy);
        if (this.policy.maxRecords !== store.policy.maxRecords)
            throw Error('mailbox_policy_mismatch');
    }
    private authenticate(body: string, headers: unknown) {
        if (Buffer.byteLength(body, 'utf8') + Buffer.byteLength(JSON.stringify(headers) ?? '', 'utf8') > this.policy.maxRequestBytes)
            throw Error('mailbox_request_too_large');
        const h = mailboxHeadersSchema.parse(headers), trusted = this.account(h.bridgeId, h.accountId);
        if (!trusted || !trusted.key || !same(trusted.binding, h))
            throw Error('mailbox_authentication_failed');
        iMessageBindingSchema.parse(trusted.binding);
        if (!timingSafeEqual(Buffer.from(h.signature, 'hex'), Buffer.from(signRelayRequest(body, h, trusted.key).signature, 'hex')))
            throw Error('mailbox_authentication_failed');
        if (h.atMs > this.now() || this.now() - h.atMs > this.policy.signatureMaxAgeMs)
            throw Error('mailbox_stale_signature');
        return { h, trusted };
    }
    private nonce(state: MailboxState, h: RelayHeaders) {
        state.nonces = state.nonces.filter(n => n.expiresAtMs >= this.now());
        if (state.nonces.some(n => same(n, h) && n.nonce === h.nonce))
            throw Error('mailbox_nonce_replay');
        state.nonces.push({ bridgeId: h.bridgeId, accountId: h.accountId, nonce: h.nonce, expiresAtMs: h.atMs + this.policy.signatureMaxAgeMs });
    }
    reportCapabilities(body: string, headers: unknown) {
        const { h } = this.authenticate(body, headers), report = iMessageCapabilitiesSchema.parse(JSON.parse(body));
        if (!same(report, h))
            throw Error('mailbox_account_mismatch');
        this.store.transaction(state => { this.nonce(state, h); const row = { bridgeId: h.bridgeId, accountId: h.accountId, report, receivedAtMs: this.now() }; const old = state.capabilities.findIndex(c => same(c, h)); if (old < 0)
            state.capabilities.push(row);
        else
            state.capabilities[old] = row; });
        return { version: 1 as const, accepted: true as const };
    }
    capabilities(bridgeId: string, accountId: string): IMessageCapabilities | null {
        const row = this.store.snapshot().capabilities.find(c => same(c, { bridgeId, accountId }));
        if (!row || this.now() < row.receivedAtMs || this.now() - row.receivedAtMs > this.policy.capabilityMaxAgeMs || !same(row.report, { bridgeId, accountId }))
            return null;
        return iMessageCapabilitiesSchema.parse(row.report);
    }
    enqueue(body: string, headers: unknown): MailboxDelivery {
        const { h, trusted } = this.authenticate(body, headers), command = iMessageCommandSchema.parse(JSON.parse(body));
        if (!same(command.binding, h) || JSON.stringify(command.binding) !== JSON.stringify(iMessageBindingSchema.parse(trusted.binding)))
            throw Error('mailbox_binding_mismatch');
        return this.store.transaction(state => {
            const identity = JSON.stringify([h.bridgeId, h.accountId, command.commandId]), prior = state.deliveries.find(d => d.identity === identity);
            if (prior) {
                if (prior.commandDigest !== hash(body))
                    throw Error('mailbox_command_conflict');
                return structuredClone(prior);
            }
            if (state.deliveries.some(d => same(d, h) && ['queued', 'delivered'].includes(d.state)))
                throw Error('mailbox_outstanding_command');
            this.nonce(state, h);
            const row: MailboxDelivery = { identity, bridgeId: h.bridgeId, accountId: h.accountId, deliveryId: randomUUID(), commandId: command.commandId, commandDigest: hash(body), body, headers: h, state: 'queued', attempt: 0, createdAtMs: this.now() };
            state.deliveries.push(row);
            return structuredClone(row);
        });
    }
    async pull(body: string, headers: unknown, options: {
        waitMs: number;
    }) {
        const { h } = this.authenticate(body, headers), request = z.strictObject(scope).parse(JSON.parse(body));
        if (!same(request, h))
            throw Error('mailbox_account_mismatch');
        if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > this.policy.pullMaxWaitMs)
            throw Error('mailbox_wait_invalid');
        this.store.transaction(state => this.nonce(state, h));
        const find = () => this.store.snapshot().deliveries.find(d => same(d, h) && ['queued', 'delivered'].includes(d.state));
        if (!find() && options.waitMs > 0)
            await this.wait(() => !!find(), options.waitMs);
        const delivery = this.store.transaction(state => { const d = state.deliveries.find(d => same(d, h) && ['queued', 'delivered'].includes(d.state)); if (!d)
            return null; d.state = 'delivered'; d.attempt++; d.deliveredAtMs ??= this.now(); return { deliveryId: d.deliveryId, attempt: d.attempt, body: d.body, headers: structuredClone(d.headers) }; });
        return { version: 1 as const, delivery };
    }
    postResult(body: string, headers: unknown) {
        const { h } = this.authenticate(body, headers), request = resultEnvelope.parse(JSON.parse(body));
        if (!same(request, h) || ['queued', 'started'].includes(request.result.state))
            throw Error('mailbox_result_invalid');
        const conflict = this.store.transaction(state => {
            const d = state.deliveries.find(d => same(d, h) && d.deliveryId === request.deliveryId), command = d ? iMessageCommandSchema.parse(JSON.parse(d.body)) : null;
            if (!d || !command || d.state === 'queued' || d.state === 'withdrawn' || d.commandId !== request.commandId || d.commandDigest !== request.commandDigest || request.result.commandId !== d.commandId || JSON.stringify(request.result.target) !== JSON.stringify(command.target))
                throw Error('mailbox_result_mismatch');
            if (d.result && JSON.stringify(d.result) === JSON.stringify(request.result)) {
                if (!state.nonces.some(n => same(n, h) && n.nonce === h.nonce)) this.nonce(state, h);
                return false;
            }
            this.nonce(state, h);
            if (d.result) {
                const resultDigest = hash(JSON.stringify(request.result)), identity = JSON.stringify([d.deliveryId, resultDigest]);
                if (!state.conflicts.some(c => c.identity === identity))
                    state.conflicts.push({ identity, bridgeId: d.bridgeId, accountId: d.accountId, deliveryId: d.deliveryId, resultDigest, result: request.result, createdAtMs: this.now() });
                return true;
            }
            d.result = request.result;
            d.state = 'resulted';
            if (request.result.state === 'local_recorded' || request.result.state === 'delivered') {
                const message = { bridgeId: d.bridgeId, accountId: d.accountId, messageGuid: request.result.messageGuid, commandId: d.commandId, state: request.result.state };
                const old = state.sentMessages.find(m => same(m, d) && m.messageGuid === message.messageGuid);
                if (old && old.commandId !== message.commandId)
                    throw Error('mailbox_message_conflict');
                if (!old)
                    state.sentMessages.push(message);
            }
            return false;
        });
        if (conflict)
            throw Error('mailbox_result_conflict');
        return { version: 1 as const, accepted: true as const };
    }
    withdraw(deliveryId: string): boolean { return this.store.transaction(state => { const d = state.deliveries.find(d => d.deliveryId === deliveryId); if (!d || d.state !== 'queued')
        return false; d.state = 'withdrawn'; return true; }); }
    delivery(deliveryId: string) { return this.store.snapshot().deliveries.find(d => d.deliveryId === deliveryId) ?? null; }
    async awaitDelivery(deliveryId: string, waitMs: number) { await this.wait(() => this.delivery(deliveryId)?.state !== 'queued', waitMs); return this.delivery(deliveryId); }
    async awaitResult(deliveryId: string, waitMs: number) { await this.wait(() => !!this.delivery(deliveryId)?.result, waitMs); const result = this.delivery(deliveryId)?.result; if (!result)
        throw Error('mailbox_result_unavailable'); return iMessageResultSchema.parse(result); }
    private wait(ready: () => boolean, waitMs: number): Promise<void> {
        if (!Number.isSafeInteger(waitMs) || waitMs < 0)
            throw Error('mailbox_wait_invalid');
        if (ready())
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe = () => { };
            const finish = (error?: unknown) => { if (timer)
                clearTimeout(timer); unsubscribe(); error ? reject(error) : resolve(); };
            const check = () => { try {
                if (ready())
                    finish();
            }
            catch (e) {
                finish(e);
            } };
            unsubscribe = this.store.subscribe(check);
            timer = setTimeout(() => finish(), waitMs);
            check();
        });
    }
}
