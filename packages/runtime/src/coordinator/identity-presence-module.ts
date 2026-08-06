export type OwnerRoot = Readonly<{ ownerId: string }>;

type OwnerRootRow = { owner_id: string };

/** Sole writer for the per-Durable-Object owner identity binding. */
export class IdentityPresenceModule {
  constructor(private readonly storage: DurableObjectStorage) {}

  bindOrAssertOwnerRootInCurrentTransaction(ownerId: string, at: string): OwnerRoot {
    const existing = this.readRoot();
    if (existing !== undefined) {
      if (existing.owner_id !== ownerId) throw new Error('owner authority root mismatch');
      return Object.freeze({ ownerId });
    }
    this.storage.sql.exec(
      'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
      ownerId,
      at,
    );
    return Object.freeze({ ownerId });
  }

  assertOwnerRoot(ownerId: string): OwnerRoot {
    const existing = this.readRoot();
    if (existing === undefined || existing.owner_id !== ownerId) {
      throw new Error('owner authority root mismatch');
    }
    return Object.freeze({ ownerId });
  }

  private readRoot(): OwnerRootRow | undefined {
    return this.storage.sql.exec<OwnerRootRow>(
      'SELECT owner_id FROM owner_roots WHERE root_key = 1',
    ).toArray()[0];
  }
}
