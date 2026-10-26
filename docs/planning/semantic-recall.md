# Semantic recall (tracer, behind a flag)

Status: tracer slice built on `feat/semantic-recall`, flag off everywhere. This note is a candidate design, not an ADR.

## Problem

Memory recall is lexical: FTS5 over claims (`claim_recall`) and episodes, plus model-written aliases. "My dentist" does not
reach "Dr Rao does the teeth cleaning". The owner wants recall by meaning now, on Cloudflare.

## Decision: vectors in the owner's Durable Object, embeddings from Workers AI

- **Embedding model:** `@cf/baai/bge-m3` via the `AI` binding (`WORKERS_AI_BGE_M3_EMBEDDING_MODEL` in the contracts roster,
  as `guard-model-ids` requires).
  - Chosen for multilingual input (Hinglish and Indic text), a 60,000-token context and $0.0118 per million input tokens
    (Cloudflare model page, read 26 Oct 2026).
  - Its output width is 1024 [inference: BAAI model card; the Cloudflare page does not state it]. The code does not
    depend on it. Each row stores `model` and `dims`; a response of the wrong shape is refused; a query only scores rows of
    its own model and width.
  - Alternatives on the catalogue: `bge-small/base/large-en-v1.5` (384/768/1024, English only); `qwen3-embedding-0.6b`;
    `embeddinggemma-300m` (beta). Swapping models is a roster pin change: rows of the old model are ignored and re-embedded
    by the sweep.
- **Storage:** a `claim_vectors` table in the owner DO's SQLite: `claim_id` (PK), `model`, `dims`, `vector` (float32 BLOB),
  `embedded_at`. It holds no text. Search is a brute-force cosine scan over that owner's rows; it is cheap at one owner's
  few thousand claims (1024 x 4 bytes = 4 KB a claim).
- **Why not Vectorize**, which the staging env already binds as `waldo-recall`:
  - Forget would be an external, eventually consistent delete instead of a trigger in the forget's own transaction.
  - Owner isolation would rest on a namespace or a metadata filter on every query, instead of being structural. Namespaces
    are capped at 50,000 per index, and a metadata index must exist before the first insert.
  - Index dimensions and metric would become deploy config fixed at creation.
  - This matches the memory v2 proposal (`docs/proposals/MEMORY_V2_2026-10-25.md`, *Recall*), which already chose DO
    SQLite vectors deleted with their row.
  - Revisit if one owner's claims grow past roughly 50k, where a full scan per query starts to cost CPU.
- **What is embedded:** active and promoted claims that are not `untrusted`: their text plus aliases.
  - Episode summaries do not exist: `episodes` is FTS over raw messages. Raw chat is not embedded in this slice. The v2
    journal is the natural next source.

## Privacy

- **Health values:** every text sent to the embedder, claims and queries alike, goes through
  `redactNumericHealth(…, HEALTH_SPAN_MARKER)`. A test proves a claim and a query carrying "58 bpm" leave without the number.
- **Secrets:** text carrying a secret, by the scribe's secret patterns (`carriesSecretOrCanary` with no canary list), is
  never sent. The claim gets a NULL-vector row, so it stays lexical-only and is not retried until its text changes. Turn
  canaries are not checked: they live in the turn's prompt, and a claim or query carrying one is not expected [inference].
- **Owner isolation:** structural. Each owner's vectors live in their own DO, and a query reads only that object's rows.
  A test runs two owner objects with the same claim ids and shows B never gets A's claim.
- **Traces:** the sweep logs counts and a code only (`memory_embed`), never text.
- **Egress and retention:** Workers AI is Cloudflare, already the platform processor. It receives the claim text
  (redacted as above) and the owner's message as the query.
  - Cloudflare's docs say Workers AI does not use customer inputs to train models [inference: confirm against the current
    terms before turning the flag on].
  - The privacy notice draft is not in this repo. Before the flag goes on, it should name embeddings under Cloudflare's
    processing [inference].

## Write path

- **One writer, one retry owner:** `semanticRecall.sync()` is the only writer of `claim_vectors`. Each pass:
  1. selects up to 32 recallable claims with no vector for the current model;
  2. makes one embedding call, outside any transaction;
  3. writes in a short transaction, and only for claims whose text and aliases still match what was embedded.

  A claim forgotten or edited while the call was out gets no vector (tested).
- **Kicks:** the DO's turn setup, each `remember`, and each recall that used the leg call `kick()`. It is single-flight per
  instance and kept alive with `waitUntil`. Every claim writer is covered (remember, nightly, console, migration) without
  hooking each one.
- **Failure:** a failed or timed-out call (1.5 s) writes nothing. Lexical recall is untouched, and the next kick retries.
- **Backfill:** the same sweep. Each kick runs up to 8 batches, 256 claims, so existing owners fill in over their first
  few turns.

## Forget

- Triggers on `claims` delete the vector in the writer's own transaction:
  - `AFTER DELETE`;
  - `AFTER UPDATE OF text, aliases`, which covers a forget's redaction;
  - a status or origin change that leaves recall.

  This covers `forget_memory`, the forget purge job's `everywhere` pass, nightly forgets and console deletes. No new
  `ForgetStore` is needed, since the vector never outlives its row.
- The read path also re-reads every candidate through `ClaimStore.recall`, so the status and `untrusted` filters apply.
  Each view's filter then applies: held topics (`barrierMemory`), outside-content jobs dropping health claims, and the
  decision path's owner-only view.
- `claim_vectors` is listed as PURGED in `forget-store-table`, with `forget-semantic-recall.test.ts` as its proof.

## Read path

- **Hybrid:** `ClaimStore.recall(query, limit, near)` takes the semantic leg's ranked claim ids, re-reads them under the
  words leg's filter, and fuses both lists by reciprocal rank (k = 60). Each claim appears once.
- The model still sees one `<recalled>` list. Its header says "shared words or meaning" when the meaning leg contributed.
  `read_memory` fuses the same way, with its result schema unchanged.
- **Failure:** the semantic leg fails open, and the turn trace names it (`recall_failed: semantic`).
- **Relevance floor:** a cosine floor of 0.5 [inference] keeps the nearest-but-unrelated claims out. It is a retrieval
  threshold, not a judgment, and the paraphrase eval should set it.

## Cost and latency

- **Cost:** about 30 tokens a claim and 50 a query. At $0.0118 per million tokens, 1,000 claims cost under $0.001 to
  backfill, and a query under $0.000001.
- **Latency:** one embedding call per owner turn, before the reply's model call: about 50–200 ms [inference; measure on
  staging], capped by the 1.5 s timeout. The scan is about 1 ms for 2,000 claims [inference].

## Risks

- A slow embedder adds up to 1.5 s before the reply on each owner turn.
- Embedding calls are not in the cost ledger or the owner spend ceiling.
- A batch the embedder refuses whole is retried whole on every kick, so claims behind it wait. Claims are short, so this
  is unlikely with bge-m3's 60,000-token context; isolating a failed batch is a follow-up.
- Each owner-DO setup builds its own instance and kicks a sweep, so two can embed the same claims. It is idempotent and
  costs little.

## Flag and rollback

- `MEMORY_SEMANTIC_RECALL` is `"0"` in both wrangler var blocks, and a test pins it. The leg runs only when it is `"1"`
  and `AI` is bound (staging only; `guard-wrangler-local-bindings` keeps `ai` off the top level).
- **Rollback:** set the flag to `"0"`. Recall returns to words only at once.
  - `claim_vectors` and its triggers stay. The triggers keep deleting vectors with their claims, so a later re-enable
    starts clean.
  - Dropping the table is a separate, inventoried change.

## Deploy setup (for the gate and owner)

- No Vectorize index is needed.
- **Workers AI:** the existing `env.staging` `"ai": { "binding": "AI" }` is enough.
- **Flag:** set `MEMORY_SEMANTIC_RECALL` to `"1"` in `env.staging.vars` only when turning it on.
- **Open:** the staging `VECTORIZE` binding to `waldo-recall` is unused by this design. Keep it or remove it (owner
  decision). Its index dimensions and metric are not recorded anywhere in the repo.

## Tests

- `test/semantic-recall.test.ts`:
  - write: once, idempotent, no text column;
  - health redaction of claim and query;
  - secrets withheld;
  - failure and retry;
  - malformed response;
  - forget and edit races;
  - triggers;
  - hybrid recall and dedupe;
  - fail-open;
  - view filters (health for outside-content jobs, untrusted, held topics);
  - owner isolation;
  - the owner responder reaching the model with a paraphrase, and an outside-content job still getting no health claim;
  - flag wiring and its wrangler pin.

  The owner DO's own wiring (`memoryHooks` into the turn, `semantic` into the memory tools) is typechecked, not exercised
  by a test.
- `test/forget-semantic-recall.test.ts`, through the real tools with the flag on:
  - `remember` embeds after commit;
  - `read_memory` finds the claim by paraphrase;
  - `forget_memory` removes the vector, and no paraphrase returns the claim;
  - the purge job's topic pass drops vectors.
- The embedding fake maps words to concept dimensions. It proves the plumbing, not model quality. Model quality needs the
  paraphrase eval (MEMORY_ROADMAP stage 13) on staging.
