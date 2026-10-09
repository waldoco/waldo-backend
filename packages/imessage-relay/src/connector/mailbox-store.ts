import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { iMessageCommandSchema, iMessageCapabilitiesSchema, iMessageResultSchema, opaqueIMessageIdSchema as id } from '@waldo/contracts';
import type { RelayHeaders } from '../relay';
export const mailboxHeadersSchema = z.strictObject({ version: z.literal(1), bridgeId: id, accountId: id, atMs: z.int().nonnegative(), nonce: id, signature: z.string().regex(/^[a-f0-9]{64}$/) });
const digest = z.string().regex(/^[a-f0-9]{64}$/), time = z.int().nonnegative();
const deliverySchema = z.strictObject({ identity: id, bridgeId: id, accountId: id, deliveryId: id, commandId: id, commandDigest: digest, body: z.string(), headers: mailboxHeadersSchema, state: z.enum(['queued', 'delivered', 'resulted', 'withdrawn']), attempt: z.int().nonnegative(), result: iMessageResultSchema.optional(), createdAtMs: time, deliveredAtMs: time.optional() }).superRefine((row, ctx) => {
    const command = iMessageCommandSchema.safeParse(JSON.parse(row.body));
    if (!command.success || row.identity !== JSON.stringify([row.bridgeId, row.accountId, row.commandId]) || row.commandDigest !== createHash('sha256').update(row.body, 'utf8').digest('hex') || row.headers.bridgeId !== row.bridgeId || row.headers.accountId !== row.accountId || command.data.commandId !== row.commandId || command.data.binding.bridgeId !== row.bridgeId || command.data.binding.accountId !== row.accountId || (row.state === 'resulted') !== !!row.result || row.result && (row.result.commandId !== row.commandId || JSON.stringify(row.result.target) !== JSON.stringify(command.data.target) || ['queued', 'started'].includes(row.result.state)))
        ctx.addIssue({ code: 'custom', message: 'mailbox delivery inconsistent' });
});
const stateSchema = z.strictObject({
    deliveries: z.array(deliverySchema),
    capabilities: z.array(z.strictObject({ bridgeId: id, accountId: id, report: iMessageCapabilitiesSchema, receivedAtMs: time })),
    nonces: z.array(z.strictObject({ bridgeId: id, accountId: id, nonce: id, expiresAtMs: time })),
    sentMessages: z.array(z.strictObject({ bridgeId: id, accountId: id, messageGuid: id, commandId: id, state: z.enum(['local_recorded', 'delivered']) })),
    conflicts: z.array(z.strictObject({ identity: id, bridgeId: id, accountId: id, deliveryId: id, resultDigest: digest, result: iMessageResultSchema, createdAtMs: time })),
});
export type MailboxState = z.infer<typeof stateSchema>;
export type MailboxDelivery = MailboxState['deliveries'][number];
export type MailboxStoragePolicy = {
    maxRecords: number;
    maxBytes: number;
    source: string;
};
const storagePolicy = z.strictObject({ maxRecords: z.int().positive(), maxBytes: z.int().positive(), source: id });
export class MailboxStore {
    private db: DatabaseSync;
    private closed = false;
    private listeners = new Set<() => void>();
    readonly policy: MailboxStoragePolicy;
    constructor(path: string, policy: MailboxStoragePolicy) {
        this.policy = storagePolicy.parse(policy);
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS deliveries(identity TEXT PRIMARY KEY,bridgeId TEXT NOT NULL,accountId TEXT NOT NULL,deliveryId TEXT UNIQUE NOT NULL,commandId TEXT NOT NULL,commandDigest TEXT NOT NULL,body TEXT NOT NULL,headersJson TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','delivered','resulted','withdrawn')),attempt INTEGER NOT NULL,resultJson TEXT,createdAtMs INTEGER NOT NULL,deliveredAtMs INTEGER);
   CREATE UNIQUE INDEX IF NOT EXISTS outstanding_account ON deliveries(bridgeId,accountId) WHERE state IN ('queued','delivered');
   CREATE TABLE IF NOT EXISTS capabilities(bridgeId TEXT,accountId TEXT,reportJson TEXT NOT NULL,receivedAtMs INTEGER NOT NULL,PRIMARY KEY(bridgeId,accountId));
   CREATE TABLE IF NOT EXISTS nonces(bridgeId TEXT,accountId TEXT,nonce TEXT,expiresAtMs INTEGER NOT NULL,PRIMARY KEY(bridgeId,accountId,nonce));
   CREATE TABLE IF NOT EXISTS sent_messages(bridgeId TEXT,accountId TEXT,messageGuid TEXT,commandId TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(bridgeId,accountId,messageGuid));
   CREATE TABLE IF NOT EXISTS result_conflicts(identity TEXT PRIMARY KEY,bridgeId TEXT NOT NULL,accountId TEXT NOT NULL,deliveryId TEXT NOT NULL,resultDigest TEXT NOT NULL,resultJson TEXT NOT NULL,createdAtMs INTEGER NOT NULL);`);
        this.snapshot();
    }
    snapshot(): MailboxState {
        const deliveries = (this.db.prepare('SELECT * FROM deliveries ORDER BY rowid').all() as Array<Record<string, unknown>>).map(({ headersJson, resultJson, deliveredAtMs, ...row }) => ({ ...row, headers: JSON.parse(headersJson as string), ...(resultJson !== null ? { result: JSON.parse(resultJson as string) } : {}), ...(deliveredAtMs !== null ? { deliveredAtMs } : {}) }));
        const capabilities = (this.db.prepare('SELECT * FROM capabilities ORDER BY rowid').all() as Array<Record<string, unknown>>).map(({ reportJson, ...row }) => ({ ...row, report: JSON.parse(reportJson as string) }));
        const conflicts = (this.db.prepare('SELECT * FROM result_conflicts ORDER BY rowid').all() as Array<Record<string, unknown>>).map(({ resultJson, ...row }) => ({ ...row, result: JSON.parse(resultJson as string) }));
        return stateSchema.parse({ deliveries, capabilities, conflicts, nonces: this.db.prepare('SELECT * FROM nonces ORDER BY rowid').all(), sentMessages: this.db.prepare('SELECT * FROM sent_messages ORDER BY rowid').all() });
    }
    transaction<T>(work: (state: MailboxState) => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        let result: T;
        try {
            const state = this.snapshot();
            result = work(state);
            const valid = stateSchema.parse(state);
            const records = Object.values(valid).reduce((n, rows) => n + rows.length, 0);
            if (records > this.policy.maxRecords || Buffer.byteLength(JSON.stringify(valid), 'utf8') > this.policy.maxBytes)
                throw new Error('mailbox_backpressure');
            this.db.exec('DELETE FROM deliveries; DELETE FROM capabilities; DELETE FROM nonces; DELETE FROM sent_messages; DELETE FROM result_conflicts;');
            const delivery = this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
            for (const d of valid.deliveries)
                delivery.run(d.identity, d.bridgeId, d.accountId, d.deliveryId, d.commandId, d.commandDigest, d.body, JSON.stringify(d.headers), d.state, d.attempt, d.result ? JSON.stringify(d.result) : null, d.createdAtMs, d.deliveredAtMs ?? null);
            const capability = this.db.prepare('INSERT INTO capabilities VALUES(?,?,?,?)');
            for (const c of valid.capabilities)
                capability.run(c.bridgeId, c.accountId, JSON.stringify(c.report), c.receivedAtMs);
            const nonce = this.db.prepare('INSERT INTO nonces VALUES(?,?,?,?)');
            for (const n of valid.nonces)
                nonce.run(n.bridgeId, n.accountId, n.nonce, n.expiresAtMs);
            const sent = this.db.prepare('INSERT INTO sent_messages VALUES(?,?,?,?,?)');
            for (const s of valid.sentMessages)
                sent.run(s.bridgeId, s.accountId, s.messageGuid, s.commandId, s.state);
            const conflict = this.db.prepare('INSERT INTO result_conflicts VALUES(?,?,?,?,?,?,?)');
            for (const c of valid.conflicts)
                conflict.run(c.identity, c.bridgeId, c.accountId, c.deliveryId, c.resultDigest, JSON.stringify(c.result), c.createdAtMs);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        for (const listener of [...this.listeners])
            listener();
        return result;
    }
    /** Notifications accelerate same-process waits; each waiter rechecks persisted state. */
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    close() { if (this.closed)
        return; this.closed = true; for (const listener of [...this.listeners])
        listener(); this.listeners.clear(); this.db.close(); }
}
export type SignedMailboxCommand = {
    body: string;
    headers: RelayHeaders;
};
