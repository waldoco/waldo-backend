# Staging E2E: cost ledger on

Flag: `WALDO_COST_LEDGER_SYNC` in `env.staging.vars` of `packages/runtime/wrangler.jsonc`. Rollback: set it to `"off"` and redeploy; nothing else changes, and rows already written stay.

Run after the staging deploy that carries the flip, on the owner's account.

1. Note the deploy time `T` (UTC).
2. In the Waldo console chat, send three ordinary messages a minute apart, for example "what's on today", "anything I owe anyone this week", "thanks". Send one more on Telegram.
3. In the Supabase SQL editor for staging (service role), run:

   ```sql
   select o.do_name, l.day, l.kind, l.model, l.calls, l.input_tokens, l.cached_tokens, l.usd_estimate, l.updated_at
   from waldo.cost_ledger_daily l join waldo.owners o on o.id = l.owner_id
   where l.updated_at >= '<T>' order by l.updated_at desc;
   ```

   Expect: rows for the owner's DO name on today's UTC day, kind `turn`, the chat model (`gpt-6.1-sol` unless the router says otherwise), `calls` at least 4, and `usd_estimate` above 0.
4. In Cloudflare logs for `waldo-runtime-staging`, filter `"hop":"cost_ledger"` since `T`. Expect none. A `sync_failed` line means the signed router rail refused the batch; the deltas stay in the DO and resend, so read its `error`.
5. In Langfuse (staging project), open the four traces. Each generation names the chat model, not `gpt-6-luna`: the owner is below the staging ceiling (USD 250), so no turn is clamped.
6. Run the report for the baseline every later cost change is judged against:

   ```bash
   node scripts/cost-report.mjs --window <today>..<today> --baseline <7 days ago>..<yesterday> --ledger ledger.json --langfuse
   ```

   `ledger.json` is the single cell the query in the script header returns. Langfuse needs `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. Keep the output; it is the "before" for the caching and tool search changes.

   The report prints owner ids (Langfuse `userId` values and DO names). Keep the raw output out of PRs, issues and chat; paste only totals or per-day figures with the ids removed.

   A line starting `Unpriced:` means some calls had tokens and no price in `llm/pricing.ts`; their USD is counted as $0, so the totals are a floor.

Pass when steps 3 to 5 hold. The ledger has no "before" (it was off); Langfuse's baseline window is the before.
