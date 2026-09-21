export type ConversationRequest = Readonly<{
  ownerId: string;
  key: string;
  bytes: string;
}>;

export type ConversationProvider = Readonly<{
  complete(request: ConversationRequest): Promise<string>;
}>;

export type ConversationResult =
  | Readonly<{ status: 'completed' | 'replayed'; value: string }>
  | Readonly<{ status: 'stale' }>;

export type ConversationRecord = Readonly<{
  bytes: string;
  value: string;
}>;

export class ConversationCore {
  private readonly generations = new Map<string, number>();
  private readonly records: Map<string, ConversationRecord>;
  private readonly pending = new Map<string, {
    bytes: string;
    promise: Promise<ConversationResult>;
  }>();

  constructor(
    private readonly provider: ConversationProvider,
    records: Map<string, unknown> = new Map(),
  ) {
    this.records = records as Map<string, ConversationRecord>;
    for (const [key, record] of records) {
      this.parseRecordKey(key);
      if (!this.isRecord(record)) throw new Error('invalid conversation record');
    }
  }

  generation(ownerId: string): number {
    return this.generations.get(ownerId) ?? 0;
  }

  async complete(request: ConversationRequest): Promise<ConversationResult> {
    const recordKey = this.recordKey(request.ownerId, request.key);
    const existing = this.records.get(recordKey);
    if (existing) {
      if (existing.bytes !== request.bytes) throw new Error('conversation request bytes mismatch');
      return { status: 'replayed', value: existing.value };
    }
    const pending = this.pending.get(recordKey);
    if (pending) {
      if (pending.bytes !== request.bytes) throw new Error('conversation request bytes mismatch');
      return pending.promise;
    }

    const snapshot = { ...request };
    const generation = this.generation(request.ownerId);
    const promise = this.completeFresh(snapshot, recordKey, generation);
    this.pending.set(recordKey, { bytes: snapshot.bytes, promise });
    void promise.then(() => {
      if (this.pending.get(recordKey)?.promise === promise) this.pending.delete(recordKey);
    }, () => {
      if (this.pending.get(recordKey)?.promise === promise) this.pending.delete(recordKey);
    });
    return promise;
  }

  has(request: ConversationRequest): boolean {
    return this.records.has(this.recordKey(request.ownerId, request.key));
  }

  cancel(ownerId: string): void {
    this.bump(ownerId);
  }

  delete(ownerId: string): void {
    this.bump(ownerId);
    this.deleteOwnerRecords(ownerId);
  }

  revoke(ownerId: string): void {
    this.bump(ownerId);
    this.deleteOwnerRecords(ownerId);
  }

  private bump(ownerId: string): void {
    this.generations.set(ownerId, this.generation(ownerId) + 1);
    for (const key of this.pending.keys()) {
      if (this.parseRecordKey(key)[0] === ownerId) this.pending.delete(key);
    }
  }

  private deleteOwnerRecords(ownerId: string): void {
    for (const key of this.records.keys()) {
      if (this.parseRecordKey(key)[0] === ownerId) this.records.delete(key);
    }
  }

  private recordKey(ownerId: string, key: string): string {
    return JSON.stringify([ownerId, key]);
  }

  private parseRecordKey(key: string): [string, string] {
    try {
      const parsed: unknown = JSON.parse(key);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        typeof parsed[1] !== 'string'
      ) throw new Error();
      return [parsed[0], parsed[1]];
    } catch {
      throw new Error('invalid conversation record');
    }
  }

  private isRecord(record: unknown): record is ConversationRecord {
    const candidate = record as { bytes?: unknown; value?: unknown };
    return (
      typeof record === 'object' &&
      record !== null &&
      typeof candidate.bytes === 'string' &&
      typeof candidate.value === 'string'
    );
  }

  private async completeFresh(
    request: ConversationRequest,
    recordKey: string,
    generation: number,
  ): Promise<ConversationResult> {
    const value = await this.provider.complete({ ...request });
    if (generation !== this.generation(request.ownerId)) return { status: 'stale' };
    this.records.set(recordKey, { bytes: request.bytes, value });
    return { status: 'completed', value };
  }
}