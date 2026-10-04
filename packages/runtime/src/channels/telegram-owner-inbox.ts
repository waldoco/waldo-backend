// An inbox record is admission evidence, not evidence that an effect completed.
export const OWNER_INBOX_KEY = 'telegram_owner_inbox_v1';
export const OWNER_INBOX_DUE_KEY = 'telegram_owner_inbox_due_v1';
const RETENTION_MS = 25 * 60 * 60_000;
const CAPACITY = 512;
export type InboxBinding = { bot: string; subject: string; doName: string };
export type InboxRecord = InboxBinding & {
  id: string; digest: string; sequence: number; updateId: number; body: string;
  admittedAt: number; state: 'admitted' | 'claimed' | 'awaiting_delivery' | 'consumed' | 'completed' | 'quarantined';
  attempt?: string; runId?: string; deadline?: number; reason?: string; closedAt?: number; outcomeNoticeQueued?: boolean;
  outcomeNoticeBlocked?: 'owner_binding' | 'notice_identity' | 'invalid_record';
  control?: { kind: 'stop' | 'steer'; targetRun: string };
};
export const needsRecoveryNotice = (row: InboxRecord): boolean => row.state === 'quarantined' && !row.outcomeNoticeQueued && !row.outcomeNoticeBlocked
  && (row.control?.kind === 'steer' && ['not_consumed', 'consumed_target_outcome_uncertain', 'recovered_uncertain'].includes(row.reason ?? '')
    || row.control === undefined && ['recovered_uncertain', 'execution_closed', 'owner_stopped'].includes(row.reason ?? ''));
export const ownerInboxDue = (rows: InboxRecord[], now: number): number | null => {
  const due = rows.flatMap(row => row.state === 'admitted' ? [now + 250] : row.state === 'claimed' || row.state === 'consumed'
    ? [row.deadline ?? now + 250] : needsRecoveryNotice(row) ? [now + 250] : row.state === 'completed' ? [row.admittedAt + RETENTION_MS] : []);
  return due.length ? Math.min(...due) : null;
};
const ordinaryAdmission = (row: InboxRecord): void => {
  row.state = 'admitted';
  delete row.control; delete row.attempt; delete row.runId; delete row.deadline; delete row.reason; delete row.closedAt; delete row.outcomeNoticeQueued; delete row.outcomeNoticeBlocked;
};
export type Admission = 'admitted' | 'duplicate' | 'conflict' | 'capacity';
type Storage = Pick<DurableObjectStorage, 'transaction' | 'get'>;
export class TelegramOwnerInbox {
  constructor(private readonly storage: Storage, private readonly persist: (txn: DurableObjectTransaction, rows: InboxRecord[], due: number | null) => Promise<void>, private readonly now: () => number = Date.now) {}
  async records(): Promise<InboxRecord[]> { return (await this.storage.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? []; }
  private due(rows: InboxRecord[]): number | null {
    return ownerInboxDue(rows, this.now());
  }
  async admit(binding: InboxBinding, updateId: number, body: string, control?: InboxRecord['control']): Promise<Admission> {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(x => x.toString(16).padStart(2, '0')).join('');
    const id = `${binding.bot}:telegram:${updateId}`;
    return this.storage.transaction(async txn => {
      const subject = await txn.get<string>('telegram_subject');
      const doName = await txn.get<string>('do_name');
      if ((subject && subject !== binding.subject) || (doName && doName !== binding.doName) || await txn.get<boolean>('telegram_unlinked')) throw new Error('owner binding conflict');
      const rows = (await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? [];
      const prior = rows.find(r => r.id === id);
      if (prior) return prior.digest === digest && prior.subject === binding.subject && prior.doName === binding.doName ? 'duplicate' : 'conflict';
      const retained = rows.filter(r => r.state === 'admitted' || r.state === 'claimed' || r.state === 'awaiting_delivery' || r.state === 'consumed' || r.state === 'quarantined' || r.admittedAt + RETENTION_MS > this.now());
      if (retained.length >= CAPACITY) return 'capacity';
      const sequence = ((await txn.get<number>('telegram_owner_inbox_sequence_v1')) ?? 0) + 1;
      retained.push({ ...binding, id, digest, sequence, updateId, body, admittedAt: this.now(), state: 'admitted', ...(control ? { control } : {}) });
      await txn.put({ telegram_owner_inbox_sequence_v1: sequence, telegram_subject: binding.subject, do_name: binding.doName });
      await this.persist(txn, retained, this.due(retained));
      return 'admitted';
    });
  }
  async claim(id: string, attempt: string, runId: string, deadline: number): Promise<InboxRecord | null> {
    return this.storage.transaction(async txn => {
      const rows = (await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? [];
      const row = rows.find(r => r.id === id);
      if (!row || row.state !== 'admitted') return null;
      row.state = 'claimed'; row.attempt = attempt; row.runId = runId; row.deadline = deadline;
      await this.persist(txn, rows, this.due(rows)); return structuredClone(row);
    });
  }
  // Only a steering message proven never consumed can become its original ordinary FIFO turn.
  async returnUnconsumedSteer(id: string, attempt?: string): Promise<boolean> {
    return this.storage.transaction(async txn => {
      const rows = (await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? [];
      const row = rows.find(r => r.id === id);
      if (!row || row.control?.kind !== 'steer' || row.closedAt !== undefined
        || (row.state !== 'admitted' && row.state !== 'claimed') || row.attempt !== attempt) return false;
      ordinaryAdmission(row);
      await this.persist(txn, rows, this.due(rows)); return true;
    });
  }
  // Caller work is restricted to this transaction. No provider I/O belongs here.
  async commitIfLive(run: InboxRecord, work: (txn: DurableObjectTransaction) => void): Promise<boolean> {
    return this.storage.transaction(async txn => {
      const rows = (await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? [];
      const row = rows.find(r => r.id === run.id);
      const subject = await txn.get<string>('telegram_subject');
      const name = await txn.get<string>('do_name');
      const unlinked = await txn.get<boolean>('telegram_unlinked');
      if (!row || row.state !== 'claimed' || row.closedAt !== undefined || row.runId !== run.runId || row.attempt !== run.attempt
        || row.bot !== run.bot || row.subject !== run.subject || row.doName !== run.doName
        || subject !== run.subject || name !== run.doName || unlinked || !row.deadline || this.now() >= row.deadline) return false;
      // Admission and issuance of transaction writes share one synchronous boundary.
      // The callback must not await: delayed work must request a new fence.
      const result = work(txn) as unknown;
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('fenced commit must be synchronous');
      return true;
    });
  }
  async close(run: InboxRecord, reason: string): Promise<boolean> {
    return this.storage.transaction(async txn => {
      const rows = (await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? [];
      const row = rows.find(r => r.id === run.id);
      if (!row || row.runId !== run.runId || row.attempt !== run.attempt) return false;
      if (row.closedAt !== undefined) return true;
      row.closedAt = this.now();
      if (row.state === 'claimed') { row.state = 'quarantined'; row.body = ''; row.reason = reason; }
      await this.persist(txn, rows, this.due(rows));
      return true;
    });
  }
  async transition(id: string, attempt: string, state: 'awaiting_delivery' | 'consumed' | 'completed' | 'quarantined', reason?: string): Promise<boolean> {
    return this.storage.transaction(async txn => {
      const rows = (await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? [];
      const row = rows.find(r => r.id === id);
      if (!row || row.attempt !== attempt || (row.state !== 'claimed' && row.state !== 'awaiting_delivery' && row.state !== 'consumed')) return false;
      row.state = state; if (reason) row.reason = reason;
      if (state !== 'consumed') row.body = '';
      await this.persist(txn, rows, this.due(rows)); return true;
    });
  }
  async recover(liveAttempts: ReadonlySet<string>): Promise<void> {
    await this.storage.transaction(async txn => {
      const rows = ((await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? []).filter(r => r.state === 'admitted' || r.state === 'claimed' || r.state === 'awaiting_delivery' || r.state === 'consumed' || r.state === 'quarantined' || r.admittedAt + RETENTION_MS > this.now());
      for (const row of rows) if ((row.state === 'claimed' || row.state === 'consumed') && (!row.attempt || !liveAttempts.has(row.attempt))) {
        if (row.state === 'claimed' && row.control?.kind === 'steer' && row.closedAt === undefined) ordinaryAdmission(row);
        else { row.state = 'quarantined'; row.reason = 'recovered_uncertain'; row.body = ''; }
      }
      await this.persist(txn, rows, this.due(rows));
    });
  }
}
