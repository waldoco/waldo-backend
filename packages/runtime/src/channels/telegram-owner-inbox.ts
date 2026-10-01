// An inbox record is admission evidence, not evidence that an effect completed.
export const OWNER_INBOX_KEY = 'telegram_owner_inbox_v1';
export const OWNER_INBOX_DUE_KEY = 'telegram_owner_inbox_due_v1';
const RETENTION_MS = 25 * 60 * 60_000;
const CAPACITY = 512;
export type InboxBinding = { bot: string; subject: string; doName: string };
export type InboxRecord = InboxBinding & {
  id: string; digest: string; sequence: number; updateId: number; body: string;
  admittedAt: number; state: 'admitted' | 'claimed' | 'consumed' | 'completed' | 'quarantined';
  attempt?: string; runId?: string; deadline?: number; reason?: string;
  control?: { kind: 'stop' | 'steer'; targetRun: string };
};
export type Admission = 'admitted' | 'duplicate' | 'conflict' | 'capacity';
type Storage = Pick<DurableObjectStorage, 'transaction' | 'get'>;
export class TelegramOwnerInbox {
  constructor(private readonly storage: Storage, private readonly persist: (txn: DurableObjectTransaction, rows: InboxRecord[], due: number | null) => Promise<void>, private readonly now: () => number = Date.now) {}
  async records(): Promise<InboxRecord[]> { return (await this.storage.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? []; }
  private due(rows: InboxRecord[]): number | null {
    const due = rows.flatMap(r => r.state === 'admitted' ? [this.now() + 250] : r.state === 'claimed' || r.state === 'consumed' ? [r.deadline ?? this.now() + 250] : r.state === 'completed' ? [r.admittedAt + RETENTION_MS] : []);
    return due.length ? Math.min(...due) : null;
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
      const retained = rows.filter(r => r.state === 'admitted' || r.state === 'claimed' || r.state === 'consumed' || r.state === 'quarantined' || r.admittedAt + RETENTION_MS > this.now());
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
  async transition(id: string, attempt: string, state: 'consumed' | 'completed' | 'quarantined', reason?: string): Promise<boolean> {
    return this.storage.transaction(async txn => {
      const rows = (await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? [];
      const row = rows.find(r => r.id === id);
      if (!row || row.attempt !== attempt || (row.state !== 'claimed' && row.state !== 'consumed')) return false;
      row.state = state; if (reason) row.reason = reason;
      if (state !== 'consumed') row.body = '';
      await this.persist(txn, rows, this.due(rows)); return true;
    });
  }
  async recover(liveAttempts: ReadonlySet<string>): Promise<void> {
    await this.storage.transaction(async txn => {
      const rows = ((await txn.get<InboxRecord[]>(OWNER_INBOX_KEY)) ?? []).filter(r => r.state === 'admitted' || r.state === 'claimed' || r.state === 'consumed' || r.state === 'quarantined' || r.admittedAt + RETENTION_MS > this.now());
      for (const row of rows) if ((row.state === 'claimed' || row.state === 'consumed') && (!row.attempt || !liveAttempts.has(row.attempt))) {
        row.state = 'quarantined'; row.reason = 'recovered_uncertain'; row.body = '';
      }
      await this.persist(txn, rows, this.due(rows));
    });
  }
}
