import { WORKERS_AI_BGE_M3_EMBEDDING_MODEL } from '@waldo/contracts';
import { carriesSecretOrCanary, HEALTH_SPAN_MARKER, redactNumericHealth } from '../scribe/sanitiser';
import { NODE_STATEMENT } from './node-sources';

// Semantic recall: a meaning-based leg beside the claims FTS index, so "my dentist" can reach "Dr Rao, who does my teeth".
// Vectors live in the owner's own Durable Object next to the claims they describe, so a claim's vector goes with it in the
// same transaction (triggers below) and no other owner's rows exist to be reached. Only the embedding call leaves the
// object, to Workers AI, and it never runs inside a SQLite transaction. The vector leg only ranks: callers hand its ids to
// ClaimStore.recall, which re-reads each claim under the same filters as the words leg, and every view filters after that.

export type Embedder = Readonly<{ model: string; embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> }>;

// The slice of the Workers AI binding this module calls.
export type EmbeddingRunner = Readonly<{ run(model: typeof WORKERS_AI_BGE_M3_EMBEDDING_MODEL, input: { text: string[] }): Promise<unknown> }>;

export const EMBED_TIMEOUT_MS = 1_500;
// One embedding call per sweep batch; the backfill runs at most SYNC_ROUNDS batches per kick.
export const SYNC_BATCH = 32;
export const SYNC_ROUNDS = 8;
// Candidates the vector leg offers per query, and the cosine floor below which a vector is not a match at all. The floor
// is a starting value for bge-m3 [inference]; the paraphrase eval sets it.
export const NEAR_LIMIT = 8;
export const MIN_SIMILARITY = 0.5;
// Reciprocal rank fusion constant (Cormack et al., 2009).
const RRF_K = 60;

// What may leave for the embedder: health readings withheld, as in traces; null for text that carries a secret (token,
// key, bearer credential), which never leaves.
export const embeddingText = (text: string): string | null =>
  carriesSecretOrCanary(text) ? null : redactNumericHealth(text, HEALTH_SPAN_MARKER);

const claimInput = (text: string, aliases: string | null): string => (aliases ? `${text}\n${aliases}` : text);

export const workersAiEmbedder = (ai: EmbeddingRunner, timeoutMs = EMBED_TIMEOUT_MS): Embedder => ({
  model: WORKERS_AI_BGE_M3_EMBEDDING_MODEL,
  async embed(texts) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('embedding timed out')), timeoutMs); });
    const result = await Promise.race([ai.run(WORKERS_AI_BGE_M3_EMBEDDING_MODEL, { text: [...texts] }), timeout]).finally(() => clearTimeout(timer));
    const data = (result as { data?: unknown } | null)?.data;
    const width = Array.isArray(data) && Array.isArray(data[0]) ? data[0].length : 0;
    if (!Array.isArray(data) || data.length !== texts.length || width === 0
      || !data.every((row): row is number[] => Array.isArray(row) && row.length === width && row.every(Number.isFinite))) throw new Error('embedding response malformed');
    return data;
  },
});

// Ranked lists fused by reciprocal rank; an item in several lists counts once, and ties keep first appearance.
export const fuseRanked = <T, K>(lists: readonly (readonly T[])[], key: (item: T) => K): T[] => {
  const scored = new Map<K, { item: T; score: number; first: number }>();
  let order = 0;
  for (const list of lists) list.forEach((item, rank) => {
    const entry = scored.get(key(item)) ?? { item, score: 0, first: order++ };
    entry.score += 1 / (RRF_K + rank + 1);
    scored.set(key(item), entry);
  });
  return [...scored.values()].sort((a, b) => b.score - a.score || a.first - b.first).map((entry) => entry.item);
};

const cosine = (a: Float32Array, b: readonly number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

type Snapshot = Readonly<{ id: number; text: string; aliases: string | null }>;
export type SemanticLog = (event: Readonly<{ hop: 'memory_embed'; ok: boolean; code?: string; detail: string }>) => void;

// Precondition: the claims table exists (claimStore has run on this sql).
export const semanticRecall = ({ sql, transaction, embedder, defer, log }: Readonly<{
  sql: Pick<SqlStorage, 'exec'>;
  transaction: <T>(work: () => T) => T;
  embedder: Embedder;
  // Keeps a background sweep alive past the request that kicked it (ctx.waitUntil).
  defer?: (work: Promise<unknown>) => void;
  // Content-free: counts and a code, never a text.
  log?: SemanticLog;
}>) => {
  // vector NULL: the claim's text may not leave (a secret); it stays lexical-only until its text changes.
  sql.exec('CREATE TABLE IF NOT EXISTS claim_vectors (claim_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB, embedded_at INTEGER NOT NULL)');
  // A vector never outlives the words it was made from: a delete, a text or alias edit (a forget's redaction included) and
  // a claim leaving recall drop it in the writer's own transaction.
  sql.exec('CREATE TRIGGER IF NOT EXISTS claim_vectors_delete AFTER DELETE ON claims BEGIN DELETE FROM claim_vectors WHERE claim_id = old.id; END');
  sql.exec('CREATE TRIGGER IF NOT EXISTS claim_vectors_text AFTER UPDATE OF text, aliases ON claims BEGIN DELETE FROM claim_vectors WHERE claim_id = old.id; END');
  sql.exec("CREATE TRIGGER IF NOT EXISTS claim_vectors_status AFTER UPDATE OF status, origin ON claims WHEN new.status NOT IN ('active', 'promoted') OR COALESCE(new.origin, '') = 'untrusted' BEGIN DELETE FROM claim_vectors WHERE claim_id = old.id; END");
  const model = embedder.model;
  const RECALLABLE = `c.status IN ('active', 'promoted') AND COALESCE(c.origin, '') != 'untrusted' AND c.kind != '${NODE_STATEMENT}'`;

  // One bounded pass: embed recallable claims with no vector for this model. It is the only writer of claim_vectors and the
  // only retry owner; a failed call leaves the rows missing, and the next kick picks them up. Lexical recall never waits on it.
  const syncOnce = async (batch: number): Promise<Readonly<{ embedded: number; withheld: number; due: number }>> => {
    const due = sql.exec<Snapshot>(`SELECT c.id AS id, c.text AS text, c.aliases AS aliases FROM claims c LEFT JOIN claim_vectors v ON v.claim_id = c.id AND v.model = ?
      WHERE v.claim_id IS NULL AND ${RECALLABLE} ORDER BY c.id LIMIT ?`, model, batch).toArray();
    if (!due.length) return { embedded: 0, withheld: 0, due: 0 };
    const inputs = due.map((row) => embeddingText(claimInput(row.text, row.aliases)));
    const sending = due.flatMap((row, index) => inputs[index] === null ? [] : [{ row, input: inputs[index]! }]);
    const vectors = sending.length ? await embedder.embed(sending.map((each) => each.input)) : [];
    const at = Date.now();
    let embedded = 0, withheld = 0;
    // The claim may have been forgotten, corrected or retired while the call was out: write only for the words embedded.
    transaction(() => {
      const current = (row: Snapshot) => sql.exec<Snapshot>(`SELECT c.id AS id, c.text AS text, c.aliases AS aliases FROM claims c WHERE c.id = ? AND ${RECALLABLE}`, row.id).toArray()[0];
      const unchanged = (row: Snapshot) => { const live = current(row); return live !== undefined && live.text === row.text && live.aliases === row.aliases; };
      due.forEach((row, index) => {
        if (inputs[index] !== null || !unchanged(row)) return;
        sql.exec('INSERT OR REPLACE INTO claim_vectors (claim_id, model, dims, vector, embedded_at) VALUES (?, ?, 0, NULL, ?)', row.id, model, at);
        withheld += 1;
      });
      sending.forEach(({ row }, index) => {
        if (!unchanged(row)) return;
        const vector = new Float32Array(vectors[index]!);
        sql.exec('INSERT OR REPLACE INTO claim_vectors (claim_id, model, dims, vector, embedded_at) VALUES (?, ?, ?, ?, ?)', row.id, model, vector.length, vector.buffer, at);
        embedded += 1;
      });
    });
    return { embedded, withheld, due: due.length };
  };

  // The backfill and the write hook are the same sweep, bounded per kick.
  const sync = async (batch = SYNC_BATCH, rounds = SYNC_ROUNDS): Promise<Readonly<{ embedded: number; withheld: number }>> => {
    let embedded = 0, withheld = 0;
    for (let round = 0; round < rounds; round += 1) {
      const pass = await syncOnce(batch);
      embedded += pass.embedded; withheld += pass.withheld;
      if (pass.due < batch) break;
    }
    return { embedded, withheld };
  };

  let running: Promise<unknown> | undefined;
  const kick = (): void => {
    if (running) return;
    running = sync().then(
      (done) => { if (done.embedded || done.withheld) log?.({ hop: 'memory_embed', ok: true, detail: `embedded=${done.embedded} withheld=${done.withheld}` }); },
      () => log?.({ hop: 'memory_embed', ok: false, code: 'embed_failed', detail: 'sweep' }),
    ).finally(() => { running = undefined; });
    defer?.(running);
  };

  // Claim ids nearest in meaning to the query, best first, within this owner's own vectors. Throws when the embedder does;
  // the caller fails open to the words leg.
  const near = async (query: string, limit = NEAR_LIMIT): Promise<readonly number[]> => {
    const input = embeddingText(query);
    if (!input?.trim()) return [];
    const [target] = await embedder.embed([input]);
    if (!target) return [];
    const rows = sql.exec<{ claim_id: number; vector: ArrayBuffer }>(`SELECT v.claim_id AS claim_id, v.vector AS vector FROM claim_vectors v JOIN claims c ON c.id = v.claim_id
      WHERE v.model = ? AND v.dims = ? AND v.vector IS NOT NULL AND ${RECALLABLE}`, model, target.length).toArray();
    const ranked = rows.map((row) => ({ id: row.claim_id, score: cosine(new Float32Array(row.vector), target) }))
      .filter((row) => row.score >= MIN_SIMILARITY).sort((a, b) => b.score - a.score || a.id - b.id);
    kick();
    return ranked.slice(0, limit).map((row) => row.id);
  };

  return { sync, kick, near };
};
export type SemanticRecall = ReturnType<typeof semanticRecall>;

// Off unless the deploy sets MEMORY_SEMANTIC_RECALL=1 and binds Workers AI.
export const semanticRecallFromEnv = (env: Readonly<{ MEMORY_SEMANTIC_RECALL?: string; AI?: EmbeddingRunner }>, deps: Omit<Parameters<typeof semanticRecall>[0], 'embedder'>): SemanticRecall | undefined =>
  env.MEMORY_SEMANTIC_RECALL === '1' && env.AI ? semanticRecall({ ...deps, embedder: workersAiEmbedder(env.AI) }) : undefined;
