import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { disabledIMessageCapabilities, type IMessageCapabilities } from '@waldo/contracts';
import { syntheticIMessageBinding, syntheticIMessageCommand } from '../../contracts/src/channels/imessage-v1-fixtures';
import { signRelayRequest, SignedRelay } from '../src/relay';
import { RelayStore } from '../src/store';
import { MailboxStore } from '../src/connector/mailbox-store';
import { CommandMailbox } from '../src/connector/mailbox';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse())
    close(); });
export const relayPolicy = { maxRecords: 256, maxSpoolBytes: 1000000, maxRequestBytes: 16000, signatureMaxAgeMs: 1000, heartbeatExpiryMs: 1000, mutationDeadlineMs: 80, source: 'synthetic test policy' };
export const mailboxPolicy = { signatureMaxAgeMs: 1000, maxRecords: 256, maxRequestBytes: 16000, pullMaxWaitMs: 100, capabilityMaxAgeMs: 500, source: 'synthetic test policy' };
export const storagePolicy = { maxRecords: 256, maxBytes: 1000000, source: 'synthetic test policy' };
export const digest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
export function fixture(storage = storagePolicy) {
    const dir = mkdtempSync(join(tmpdir(), 'waldo-connector-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const clock = { now: 1000 }, account = { binding: structuredClone(syntheticIMessageBinding), key: 'synthetic-connector-key' };
    const resolve = () => account;
    const mailboxStore = new MailboxStore(join(dir, 'mailbox.sqlite'), storage);
    cleanup.push(() => mailboxStore.close());
    const mailbox = new CommandMailbox(mailboxStore, { ...mailboxPolicy, maxRecords: storage.maxRecords }, resolve, () => clock.now);
    const relayStore = new RelayStore(join(dir, 'relay.sqlite'));
    cleanup.push(() => relayStore.close());
    const relay = new SignedRelay(relayStore, relayPolicy, resolve, () => clock.now);
    let nonce = 0;
    const signed = (input: unknown, patch: Record<string, unknown> = {}) => { const body = typeof input === 'string' ? input : JSON.stringify(input); const headers = signRelayRequest(body, { version: 1, bridgeId: account.binding.bridgeId, accountId: account.binding.accountId, atMs: clock.now, nonce: 'synthetic-nonce-' + (++nonce), ...patch }, account.key); return { body, headers }; };
    const pullRequest = () => signed({ version: 1, bridgeId: account.binding.bridgeId, accountId: account.binding.accountId });
    const caps = (): IMessageCapabilities => { const c = disabledIMessageCapabilities(account.binding.bridgeId, account.binding.accountId); return { ...c, transport: 'imsg', readiness: 'ready', features: { ...c.features, text: { receive: true, send: true, verified: true, exactTarget: true, probeReference: 'synthetic-probe' } } }; };
    const report = (c = caps()) => { const r = signed(c); return mailbox.reportCapabilities(r.body, r.headers); };
    const heartbeat = () => { const r = signed({ version: 1, bridgeId: account.binding.bridgeId, accountId: account.binding.accountId, databaseGeneration: 'fixture-generation', status: 'online' }); relay.heartbeat(r.body, r.headers); };
    const command = (commandId = 'synthetic-command') => ({ ...syntheticIMessageCommand(), commandId });
    return { dir, clock, account, resolve, mailboxStore, mailbox, relayStore, relay, signed, pullRequest, caps, report, heartbeat, command };
}
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
