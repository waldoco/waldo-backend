// Test-only, suite-neutral source world. No provider account or network call is possible.
// The oracle/approval grader stays outside this world; fixture text is untrusted data.
export type SourceRow = Readonly<{ owner_id: string; id: string; [key: string]: unknown }>;
export type Revision = Readonly<{ at: string; owner_id: string; source: string; id: string; patch: Readonly<Record<string, unknown>> }>;
export type InterceptedEffect = Readonly<{ owner_id: string; kind: string; target: string; payload: unknown; idempotency_key: string; at: string }>;
export type WorldFixture = Readonly<{
  clock: string;
  owners: readonly Readonly<{ id: string }>[];
  sources: Readonly<Record<string, readonly SourceRow[]>>;
  revisions?: readonly Revision[];
}>;

const copy = <T>(value: T): T => structuredClone(value);
const atTime = (date: string): number => {
  const time = Date.parse(date);
  if (!Number.isFinite(time)) throw new Error('invalid fixture time');
  return time;
};

export class IsolatedSourceWorld {
  private readonly owners: Set<string>;
  private readonly rows: Map<string, Map<string, Map<string, SourceRow>>> = new Map();
  private readonly revisions: readonly Revision[];
  private readonly effects: InterceptedEffect[] = [];
  private nowMs: number;

  constructor(fixture: WorldFixture) {
    this.nowMs = atTime(fixture.clock);
    const ids = fixture.owners.map((owner) => owner.id);
    this.owners = new Set(ids);
    if (this.owners.size !== ids.length || ids.some((id) => !id)) throw new Error('duplicate or empty owner');
    for (const [source, entries] of Object.entries(fixture.sources)) {
      const byOwner = new Map<string, Map<string, SourceRow>>();
      for (const entry of entries) {
        this.checkOwner(entry.owner_id);
        let store = byOwner.get(entry.owner_id);
        if (!store) { store = new Map(); byOwner.set(entry.owner_id, store); }
        if (store.has(entry.id)) throw new Error(`duplicate ${source} source ID`);
        store.set(entry.id, copy(entry));
      }
      this.rows.set(source, byOwner);
    }
    this.revisions = [...(fixture.revisions ?? [])].sort((a, b) => atTime(a.at) - atTime(b.at));
    for (const revision of this.revisions) {
      this.checkOwner(revision.owner_id);
      if (!this.rows.get(revision.source)?.get(revision.owner_id)?.has(revision.id)) throw new Error('revision target missing');
      if ('owner_id' in revision.patch || 'id' in revision.patch) throw new Error('revision cannot change source identity');
      atTime(revision.at);
    }
  }

  private checkOwner(owner: string): void { if (!this.owners.has(owner)) throw new Error('unknown owner'); }
  now(): string { return new Date(this.nowMs).toISOString(); }
  read(owner: string, source: string, id: string): SourceRow | null {
    this.checkOwner(owner);
    const row = this.rows.get(source)?.get(owner)?.get(id);
    return row ? copy(row) : null;
  }
  list(owner: string, source: string): readonly SourceRow[] {
    this.checkOwner(owner);
    return [...(this.rows.get(source)?.get(owner)?.values() ?? [])].map(copy);
  }
  advance(to: string): void {
    const next = atTime(to);
    if (next < this.nowMs) throw new Error('world clock cannot go backward');
    for (const revision of this.revisions) {
      const at = atTime(revision.at);
      if (at <= this.nowMs || at > next) continue;
      const store = this.rows.get(revision.source)?.get(revision.owner_id);
      const prior = store?.get(revision.id);
      if (!prior) throw new Error('revision target missing');
      store!.set(revision.id, { ...prior, ...copy(revision.patch) });
    }
    this.nowMs = next;
  }
  intercept(effect: Omit<InterceptedEffect, 'at'>): InterceptedEffect {
    this.checkOwner(effect.owner_id);
    if (!effect.kind || !effect.target || !effect.idempotency_key) throw new Error('effect must be typed and identified');
    const key = `${effect.owner_id}:${effect.kind}:${effect.idempotency_key}`;
    const old = this.effects.find((item) => `${item.owner_id}:${item.kind}:${item.idempotency_key}` === key);
    if (old) {
      if (JSON.stringify(old.payload) !== JSON.stringify(effect.payload) || old.target !== effect.target) throw new Error('idempotency collision');
      return copy(old);
    }
    const record = { ...copy(effect), at: this.now() };
    this.effects.push(record);
    return copy(record);
  }
  outbox(owner: string): readonly InterceptedEffect[] {
    this.checkOwner(owner);
    return this.effects.filter((effect) => effect.owner_id === owner).map(copy);
  }
}
