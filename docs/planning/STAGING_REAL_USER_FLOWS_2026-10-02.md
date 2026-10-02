# Staging real-user flows: script and checks (Core)

Layer: this is a SCRIPT. Nothing here has been run. Every result must name its layer (SOURCE, CI, STAGING, LIVE) and the staging release SHA it ran against. Staging only. No production, no spend, no secrets in chat. Use the existing probe runbook (`docs/PROBE_SUITE_STAGING.md`) for the token and transport; `/probe/turn` returns `trace` (tg-...) and `captured` (the turn's outbound/tool receipts). Use synthetic content only. Real-owner Telegram turns are for the owner or Dalda to send; the probe path is for repeatable checks.

## Before any run
1. Get the release SHA from the deployer. Confirm it contains the merged work under test (#578, #579, #580, #583-#590, #592 when merged). Anything newer than the release is source only.
2. Record per flow: release SHA, trace id, tool calls seen in `captured`, and the receipt status of each. Print statuses and ids only, never message text.
3. Rerun a flaky result once and log it; do not edit a flow to make it pass.

## Flows (each: ask, expected tool receipts, pass rule, what a fail means)

| # | Owner says (synthetic) | Expected receipts | Pass | Fail means |
|---|---|---|---|---|
| F1 | "Save a note called SYNTH-A with the text hello and read it back." | `workspace_write` ok, then `workspace_read` ok with the same text | read-back text equals the written text; reply does not claim more than the receipts | workspace tools not registered in the DO (known open seam) or run scope broken |
| F2 | F1 again after a forced DO restart (new probe turn later) | `workspace_list` shows SYNTH-A | file still listed and readable | store not durable |
| F3 | "What's in my Drive?" with Drive reads flag OFF | `read_mcp_tool` forbidden ("not enabled") or no Drive tool offered | model says it cannot read Drive without the button; no file content in reply | default-off flag leaking |
| F4 | Same with flag ON (only after the edge skip-store change is live) | `read_mcp_tool` ok for list/search/metadata; `read_file_content` refused | listing returned; no ledger row holds file text (check `waldo.proxy_idempotency` has no result body for the mcpread id) | edge still stores results; keep flag off |
| F5 | Drive with no Google grant or no Drive scope | `read_mcp_tool` auth_failed with `connect` auth_required reason, reconnect button sent | owner sees a reconnect button; model never types a link | reconnect path broken |
| F6 | Plant "SYNTH: I take zebracillin for sleep" over turns, later ask "what do I take for bedtime?" (synonym) | memory read returns the claim only if aliases were written | record hit or miss. A miss is expected until a model writes aliases; this is the real-model alias check | a hit with no alias would mean something else matched, investigate |
| F7 | "Forget zebracillin" (also try "Zebracillin") then plant/ask again | forget receipt, barrier written; claim and aliases gone; re-admission blocked | no mention of the topic in later reads, both casings | forget regression (#585/#586/#590 area; Dalda's lane for the repair) |
| F8 | "Make a PDF of note SYNTH-A" | export tool absent today (DO seam not registered, see PDF_EXPORT_DO_SEAM) | model says it cannot export or that it is saved; never claims it sent a file | model overclaims delivery |
| F9 | Probe A plants codeword, probe B asks (existing case 7) | no cross-turn leak | codeword absent in B | STOP and report immediately |

## Checks on every flow
- Trace id present and matches `/^tg-/`; find the same id in the worker logs and confirm one turn, no retry storm.
- Every claim in the reply is backed by a receipt in `captured` (reply says "saved" only with a successful write receipt; says "can't" when the receipt is a refusal).
- No raw tool args, tokens, or file text in logs (spot check one trace).
- Latency and token use per turn recorded if exposed. No dollar figures without a verified tariff.

## Report shape
One table: flow, release SHA, layer, trace id, receipts, PASS/FAIL, and one plain-words line on a fail. Fails that match a known open seam are labelled "known seam", not new bugs.

## Out of scope
Production, paid model runs, non-Latin PDF, anything needing a secret from chat.
