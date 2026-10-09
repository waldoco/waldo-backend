# Agent loop and final-state plan review

8 October 2026. Base `e4c03010` (main). Source inspection only. No tests were run, no staging traffic was sent, and no code was changed.

Labels:
- **[verified]** means I read the code at this SHA.
- **[reported]** means a subagent traced or simulated it and I did not re-read it.
- **[inference]** means a judgement drawn from the evidence.

Assumptions:
- `COMMON_OWNER_TASKS` is unset on staging. It is not in `wrangler.jsonc` and secrets are not visible from the repo. The live reply path is therefore the legacy `channels/owner-turn.ts` path.
- Instinct's internals were not researched. "Parity" below means the capability list the owner supplied.

## Verdict

The model is not the bottleneck; the harness around it is. Waldo's live turn passes through roughly a dozen layers that make judgement calls deterministically:
- a second LLM classifier that decides which tools may run;
- a keyword prompt-injection scorer applied to the owner's own words;
- regex memory filters;
- size caps that drop the whole system prompt or the whole history;
- taint that spreads from Waldo's own memory reads;
- a forget barrier that disables recall.

Each layer is locally defensible. Together they produce three effects:
- canned "interrupted / did not finish" replies;
- silent amnesia;
- blocked Gmail sends.

A great deal of recent effort has gone into fencing machinery rather than capability [inference]. Of roughly 1,000 non-merge commits since 20 September, about 96 match fence/lease/canonical/custody/authority and about 63 match "forget". These are crude keyword buckets, so treat them as a signal, not a measurement.

The open-source harnesses that work in 2026 make the opposite trade:
- a small, stable prompt and toolset;
- memory as small editable records;
- skills loaded on demand;
- deterministic enforcement only at the execution boundary (sandbox and egress, secrets, owner binding, approval on outbound, share and spend);
- everything else left to the model.

Waldo's own CLAUDE.md already states this split ("Judgment belongs to the model"). The code does not follow it.

## 1. Loop blockers on the live Telegram turn (ranked)

| # | Blocker | Where | What the owner sees | Evidence |
|---|---|---|---|---|
| 1 | Keyword injection scorer runs on all text, including the owner's messages and Waldo's replies, whatever the taint. Matches are pooled across the payload. "dan" and "grandma" weigh 0.45, "system " 0.35, and block is 0.7. A block is the hard reason `untrusted_instruction`. | `contracts/src/memory/sanitise.ts:403-485`, `scribe/sanitiser.ts:874-916,1114`, `llm/provider.ts:1310-1315` | "Call Dan about the system update" fails the whole turn with the canned notice. While both words remain in history, later turns fail too. Matches below the block threshold are rewritten to `[REDACTED_INSTRUCTION]` ("Meeting with [REDACTED_INSTRUCTION] tomorrow"). | [verified] |
| 2 | 32,768-char scribe caps. An oversize system prompt is set to `undefined` (the model runs with no instructions). Oversize history collapses to the current message only. The 100k-token window in `conversation/window.ts` never takes effect. | `llm/provider.ts:1401-1420`, `sanitise.ts` `internal_context`/`system_prompt` `max_chars: 32_768` | Silent amnesia after about 8k tokens of chat. If the prompt grows (skills plus memory), the persona and rules disappear. | [verified] |
| 3 | Per-turn task-source LLM classifier fences tool families. Tools with `requires_connector` and no family mapping need all 10 families. | `channels/task-source-scope.ts:183-205`, `owner-turn.ts:536-538`, always built at `telegram-owner-do.ts:1961` | `send_email` and `draft_email` (and any other unmapped connector tool) return "This source is outside the current owner task" in ordinary mail tasks. Classifier calls also spend tool rounds (`owner-turn.ts:601`). | [verified] |
| 4 | 4,096-char `owner_reply` policy applied to the reply text and to every emitted tool call's arguments. | `hooks/registry.ts:498-510,765-797`, `sanitise.ts` `owner_reply.max_chars` | A long answer, or a `draft_email`/`workspace_write`/artifact body over about 4 KB, fails the turn rather than being chunked. | [verified] code path; [inference] that no test covers it |
| 5 | History is flattened into one `input_text` with `role: content` prefixes. | `llm/openai.ts:111-113` | The model never sees real turns. This weakens reference resolution ("that one") and forfeits structured-message caching. | [verified] |
| 6 | Model settings: reasoning effort `low`, `max_output_tokens` 4096 including reasoning, `incomplete` treated as failure, 30 s timeout, 0 retries; the "reduced_context" retry re-sends an identical request. | `llm/openai.ts`, `llm/provider.ts:1098` | Tool-heavy or long turns fail outright instead of degrading. | [reported]; 4096 [verified] at `owner-turn.ts` |
| 7 | Taint spreads from Waldo's own reads. `read_owner_context`, `search_episodes`, `workspace_*`, `get_tasks` and `delegate_task` count as external origin. A reply-to-quote seeds taint at turn start. After that, `PRIVILEGED_ACTION_TOOLS` refuse (send_message, call_mcp_tool, update_memory, draft_document, skills_install/disable and others; `contracts/src/tools/handler.ts:142-160`, enforced at `hooks/registry.ts:420`). Gmail `send_email` is **not** on that list; it goes through its approval card. | `contracts/src/tools/handler.ts:98-125`, `conversation/tool-loop.ts:136-138`, `owner-turn.ts:624,651` | "external-tainted privileged action blocked", or a bare "hook halted" the model cannot recover from. | [verified] chain; consequence narrowed after the Instinct check |
| 8 | Memory regex gates: <ul><li>`FORGET_INTENT`: "don't forget to call mom" opens forget; "wipe what I said about X" does not.</li><li>`looksTransient`: drops "Reply in Hindi when I write Hindi", "Use my work email for client mail", and anything ending in "?".</li><li>Correction word-overlap: "works at Google" → "employed by Microsoft" is skipped.</li><li>Recall stopwords and a 3-char floor: "What do I like?" yields zero terms and then "do not guess".</li><li>A 12-char evidence floor: "I'm vegan" is downgraded.</li></ul> | `memory/claims.ts:87-88,320-331,420,997,1160,1184-1199` | Preferences are not stored, corrections are ignored, recall fails, forget fires when it shouldn't and misses when it should. | [verified] FORGET_INTENT and looksTransient; others [reported] |
| 9 | Forget barrier. While any forget is "incomplete": <ul><li>history is cut to the last message;</li><li>recall, standing orders and open loops are withheld;</li><li>every prompt, tool argument and tool result is rewritten through a literal redactor.</li></ul> `owner-turn.ts` mentions "forget" 127 times in 1,141 lines. | `owner-turn.ts:239-320,664-676`, `memory/forget-guard.ts` | One stuck forget makes Waldo forget everything. | [verified] |
| 10 | Health free-text deny on inbound text, a hard `health_value_leak`. It matches "form 16", "load 40 pallets", "Motion 3 carried" and "Next steps: 1". | `scribe/sanitiser.ts:69-79`, `sanitise.ts:296-330` | Ordinary mail or web reads fail as `forbidden`. Drafts containing these phrases are refused. | Regex [verified]; false positives [reported] (simulated) |

Next in line:
- **Whole-email OTP quarantine.** "postal code: 560001" wipes the whole mail and relays a fake code (`security/artifact-hygiene.ts:43`, `tools/live/google.ts:78-88`). [reported]
- **Media and voice turns lose all source scope.** History is cut and every source read is rejected (`telegram-owner-do.ts:1974`, `telegram-turn.ts:28`). [reported]
- **Offloaded large results get persistence-grade PII redaction.** `[REDACTED_EMAIL]` appears in threads larger than 16 KB (`scribe/sanitiser.ts:1054`). [verified]
- **Browser `IRREVERSIBLE` word list.** It blocks "Book reviews" and "Remove filter" and lets "Place" and "Apply" through (`tools/live/browser.ts:172-178`). [reported]
- **Prompt size and patches.** The messaging prompt is about 14.6 KB with about 40 "never/do not" lines, several of them patches for single incidents. When a skill loads, the DOING and HEALTH blocks are appended again (`prompt/messaging-behavior.ts`). [verified] size; duplication [reported]

### Keep these (hard boundaries)

- Webhook secret, owner directory and DO binding, private-chat rule, tenant isolation.
- Secret and canary detection.
- Approval cards on send, share, invite and spend, bound to the exact payload digest.
- Egress SSRF blocking. Widen the allowlist; do not remove the guard.
- Artifact-link guard.
- Fence-closer and `role_tag` escaping.
- Provenance grounding of memory quotes.
- Browser `SAFE_METHODS` default-deny.
- The OTP pattern itself (narrow its reach, keep the check).
- Intent-before-I/O plus readback for external writes.

## 2. Capability gaps against the six priorities

| Area | State | Main gap |
|---|---|---|
| Google connect | Wired. PKCE, one consent with many scopes, several accounts stored. | <ul><li>Each call uses the first healthy account (`telegram-owner-do.ts:1693`); the model cannot choose.</li><li>Mail results don't name the account.</li><li>The app is unverified, so only listed test users can connect.</li></ul> |
| Gmail read | Wired. | <ul><li>Body capped at 4,000 chars, `text/plain` only; HTML-only mail falls back to the snippet (`connectors/google.ts:256-265`) [verified].</li><li>Only `get_communication` paginates.</li></ul> |
| Writes | `send_email` works through a digest-bound approval card, but is blocked by #3. | <ul><li>No In-Reply-To/References, so replies may not thread.</li><li>No readback after a clean send.</li><li>Calendar create takes title/start/end only (no attendees or invites); updates only move times.</li><li>No Drive/Docs/Sheets writes (read-only scopes).</li></ul> |
| Approvals | One card per effect, 12 h TTL. | <ul><li>No standing grants, autonomy modes or revoke.</li><li>`autonomy_level` L0–L3 exists only in contracts, pinned to L0.</li></ul> |
| Scheduling | Wired and restart-safe; reminders and standing orders can be cancelled. | <ul><li>Reminders are one-off or `daily` only, so "every Monday" is impossible (`contracts/src/tools/schemas/reminders.ts:8`).</li><li>The cron contract exists, but no tool exposes it.</li></ul> |
| Event wakes | Polling only: a 10-minute sweep with a cheap deterministic diff before the LLM. | <ul><li>No Gmail `watch`/Pub/Sub and no Calendar push.</li><li>`/events/<source>` only sends a note; it never starts a turn.</li></ul> |
| Follow-through | open_loop/close_loop, mail follow-up nudges. | <ul><li>Update cards and mail nudges send only if `card:brief` already went out today (`telegram-owner-do.ts:2392`) [verified]; with the brief off, follow-through goes silent.</li><li>No typed "tell me when X replies" watch.</li></ul> |
| Memory | FTS5 claims and episodes, correction and forget. | <ul><li>`VECTORIZE` is bound but never used.</li><li>No compaction or summarization.</li><li>`read_memory`/`update_memory` exist in schemas and allowlists but have no handlers. They are dead config, not model-visible tools.</li><li>The model cannot write memory directly; it goes through post-turn extraction plus the regex gates in #8.</li></ul> |
| Skills | 6 instruction-only skills (each under 600 chars, inside TS), loaded through `skills_load`. | <ul><li>Not enabled by default; needs `/skills install`.</li><li>Text turns only.</li><li>Not files, so they cannot be authored or patched by the agent.</li></ul> |
| Browser | Code wired; effectively broken on staging. | <ul><li>The `BROWSER` binding is deliberately absent.</li><li>Egress allows 6 demo hosts.</li><li>Logged-in sessions are module-only.</li><li>No vault and no MFA handoff.</li></ul> |
| Files | PDF/DOCX render; delivered as an owner-session link. | <ul><li>No Telegram `sendDocument`.</li><li>No XLSX/PPTX.</li><li>PDF supports Latin text only.</li></ul> |
| Attachments and voice | Images and docs in; STT in. | No TTS. |
| Parallel work | `delegate_task`: depth 1, 3 children, 10 rounds each, read-only tools. | <ul><li>No shared todo list.</li><li>No background workers.</li></ul> |
| Web | Brave search, snippets only. | <ul><li>Page reads depend on the broken browser.</li><li>`read_document` has no handler.</li></ul> |
| Models and cost | Single pinned chat model. | <ul><li>No per-owner ledger or ceiling.</li><li>The roster is used only by the held RunLoop path.</li></ul> |
| Evals | Scripted-gateway scenarios in CI. | <ul><li>The 14-query search-vs-browse set is not in the repo.</li><li>No live-model eval runs on deploy.</li></ul> |

Capability status is [reported] unless marked otherwise. I spot-checked the 4,000-char body cap, the brief-gated update cards, the 10-family send rule and the missing memory handlers.

## 3. Two loops (decided: common DO is the one loop)

Owner direction 11:12, recorded in #913's `COMMON_LOOP_MIGRATION_PLAN_2026-10-08.md`: one loop, the common DO; delete legacy.

**What is live today [verified]:** the legacy loop answers. Common runs only when all of these hold:
- `COMMON_OWNER_TASKS=1`
- the environment is staging
- the owner's DO has no `owner_task_source_scope` rows

Otherwise it throws `legacy task source disposition required` (`common-owner-host.ts:15`, `telegram-owner-do.ts:267-273`). The 8 Oct sweep traces log legacy `task_source_custody`.

The earlier "freeze common" suggestion in this review is withdrawn. Its intent was to stop running two loops, which the decision satisfies.

Conditions for the migration to pay off:
1. **Common must become surface- and media-neutral before legacy is deleted.** Today it closes any turn that is not Telegram text: `turn.surface !== 'telegram' || turn.attachment || turn.mediaNote` throws `ClosedRunError` (`telegram-owner-do.ts:268-269`). WhatsApp currently enters through `TelegramOwnerDO` on the legacy loop. The #913 slices have no surface, attachment or voice slice.
2. **Common recall is a stub that returns `status:'failed'`** (`common-owner-host.ts:44`). Slice 4 must replace it with real recall, not port it.
3. **Slice 8 (delete custody, lease and per-call re-verification) is the payoff.** Most fencing lives on the common side. Without slice 8, users move from one gated loop to a more gated one.

## 4. What the best open-source harnesses do (sources in the research notes)

- **Small, stable prompt and toolset.** pi runs about 1k tokens and 4 tools. Anthropic lists bloated toolsets as a top failure mode. Manus masks tools rather than adding and removing them, to keep the KV cache.
- **Memory as small capped files plus search.** Examples: OpenClaw `MEMORY.md`/`USER.md`/daily notes, Hermes frozen snapshot with forced consolidation, Letta MemFS, the Claude memory tool. The agent writes memory itself. There is a memory flush before compaction and consolidation in the background.
- **Skills as files with progressive disclosure.** Only name and description are resident. Hermes lets the agent author and patch skills after corrections.
- **Proactivity.** A heartbeat with NO_REPLY as the default, a cheap model, active hours and a busy guard. Events via Gmail Pub/Sub `watch` (renew within 7 days, `history.list` fallback). Notify now, batch or stay silent is a model decision.
- **Approvals.**
  - Deterministic for outbound, irreversible and spend actions.
  - "Allow always" is bound to an exact shape (OpenClaw binds to exact argv and cwd).
  - Escalations go to a reviewer model, not the human (Claude Code auto mode, Codex auto_review).
  - Approval rate is measured per action type, and a prompt that is approved close to 100% of the time becomes a grant candidate.
- **Prompt injection.**
  - Do not use keyword detectors as guarantees; Willison: "95% is a failing grade".
  - Break the lethal trifecta structurally instead: fix the recipient or plan before reading untrusted content, and use a low-privilege reader for untrusted inboxes.
  - Taint should raise the approval bar on outbound actions, not block the agent's own reads.
- **Browser.** Persisted browser contexts for logins, credentials injected from a vault and never in the prompt, MFA handed off to the owner's device.

## 5. Redline of the final-state plan

The final-state document is a good north star but a bad launch contract. Its density ("bind", "fence", "revalidate", "reconcile" on every surface) is the same mindset that produced the gates above. Proposed changes:

1. **Split it.** Write a one-page **launch contract** plus a **later** appendix. Nothing is deleted; scope moves.
2. **The launch contract** covers four joined journeys, through Telegram, each surviving one transient failure:
   - inbox-to-action
   - prepare-and-schedule
   - daily open-loops brief
   - sourced research-to-file

   It also covers the six priority areas:
   - Workspace end-to-end
   - follow-through
   - memory and continuity
   - skills
   - browser for connector gaps
   - trustworthy completion

   It also includes standing grants, plus signup, two-user isolation, a per-owner cost ceiling and restore.
3. **Scope (owner correction, 8 Oct): nothing in the final state is deferred.** These have their own owners and stay in scope:
   - Spots/Constellations (existing implementation)
   - WhatsApp/iMessage (other developers)
   - Kennel ambient capture (other developer)
   - browser (Codex)
   - payments, which stay last in delivery order

   This review covers the general-purpose agent core only.
4. **Rewrite these requirements, which breed gates:**
   - **"Replace meaning-related heuristics one slice at a time, compare old/new decisions in shadow."** Shadow comparison only where sends, spend or credential custody are involved. Owner-text keyword scoring, memory filters and recall stopwords involve none of those: delete them with a paired regression test.
   - **"Restarts, compaction … must not create a second execution of the same action."** Scope it to external effects. Reads and drafts need no fencing.
   - **Forget propagation "across summaries, indexes, caches, embeddings, active context".** Make it a tombstone plus read-time filter plus async purge, with an honest scope statement. Don't rewrite every in-flight prompt. This is what produced the forget barrier.
   - **The 11-field watch record.** Reduce it to owner, trigger, action, expiry, and grant reference.
   - **"Sensitive chat is classified at ingress"** and ADR-0081's free-text health scan. Apply the scan at persistence destinations and third-party egress, not to inbound mail going into the owner's own prompt. This needs an ADR amendment.
5. **Acceptance.**
   - Replace "one Telegram trace for each of 27 procedures" as a gate with the four journeys plus a live eval set of about 40 scenarios built from real failures, including every blocker in §1. Run it on every deploy.
   - Run the 14-query Instinct comparison per release, not per deploy, once the original queries are recovered. They are not in the repo.

## 6. Proposed sequence

**PR 1: unblock the loop (one bounded PR, a regression test for each item).**
1. **Injection scorer.** Stop scoring null-taint owner text, history and owner replies. For external content keep fencing and `role_tag` escaping, and drop the keyword weights from hard-block. Test: "Call Dan about the system update" gets a normal reply.
2. **Prompt and history caps.**
   - Never drop the system prompt.
   - Trim history oldest-first to a token budget, rather than collapsing to the last message.
   - Align the scribe cap with `window.ts`.
   - Test: a 60-message conversation still sees the earlier messages.
3. **Real multi-turn roles** in `responsesInput`. Test: a "that one" reference across 3 turns.
4. **Send-family mapping.** Map `send_email`, `draft_email` and `propose_calendar_change` to the `mail`/`calendar` families; keep their approval cards. Test: "reply to Sam's thread" gets as far as the approval card.
5. **Size limits.**
   - Check tool-call arguments only at each tool's own PreToolUse destination.
   - Chunk replies over 4 KB rather than failing.
   - Raise `max_output_tokens`; return partial output on `incomplete`.
6. **Taint.** The owner's own memory, episode, workspace and task reads are not external. Test: recall, then `send_message` reaches an approval card instead of a block.
7. **Media turns** keep source scope and history.

**Phase 2: memory and continuity.**
- A real `memory` tool: the model reads and writes claims directly and gives a durable reason. Host checks stay (owner, grounding quote, revision).
- Remove the `FORGET_INTENT`, `looksTransient`, overlap and stopword gates.
- Forget becomes a tombstone plus filter; remove the barrier.
- Compaction with a memory flush.
- Hybrid FTS and Vectorize recall.

**Phase 3: Workspace writes.**
- Threading headers and readback receipts.
- Calendar attendees and invites, and edits beyond time.
- An account parameter, and the account named in every result.
- HTML bodies and pagination.
- Paged Drive reads.
- Docs/Sheets writes with `drive.file` scope.

**Phase 4: follow-through.**
- Gmail `watch`, Calendar push, and `/events` starting turns.
- Cron recurrence in the reminder tool.
- A typed reply watch.
- Decouple updates from the brief.
- A notify/batch/silent model decision.
- Standing grants per action type and recipient, with revoke.

**Phase 5: skills.**
- SKILL.md files, enabled by default.
- Grow from 6 to about 15 procedures.
- Agent-authored patches subject to owner approval.

**Phase 6: browser.**
- Bind a working browser and replace the 6-host allowlist with SSRF blocking plus an optional denylist.
- Persisted contexts, a credential vault and an MFA handoff.
- Host-classified commit steps instead of the word list.

**Phase 7: parallel workers and files.**
- Background workers with a shared todo.
- Telegram `sendDocument`, XLSX/PPTX, TTS.

**Throughout:**
- A per-owner cost ledger and ceiling.
- A trimmed system prompt: remove incident patches and the duplicated DOING/HEALTH blocks; target under 6 KB.

## 6b. Corrections after independent verification (Instinct, 8 Oct)

- **Blocker #7 narrowed.** Taint from Waldo's own reads blocks `PRIVILEGED_ACTION_TOOLS`, not Gmail sends.
- **Blocker #8 example corrected.** `TRANSIENT_IMPERATIVE` needs `use (your|the|a|my)`, so "Use metric units" does not match.
- **OTP whole-mail quarantine stands.** The pattern is in `security/artifact-hygiene.ts:43`, not the scribe: bare `code|otp|passcode` then `:` then 4–8 digits. `tools/live/google.ts:78-88` replaces both subject and body and relays the match. "postal code: 560001" matches [verified by reading, not executed].
- **Tool-arg 4 KB cap stands.** The PostLLMCall hook passes `owner_reply` (`hooks/registry.ts:510`), and each tool call is checked with that same destination (`checkExecutableArgs`, `:771,797`). Needs a 5 KB `workspace_write` regression test.
- **"Moot once legacy is deleted" is wrong.** Common mode is not a separate responder. `TelegramOwnerDO` builds one responder (`telegram-owner-do.ts:1923` → `telegram-turn.ts:29` → `createOwnerResponder` in `owner-turn.ts`). Common mode only adds an `execution` binding, `memoryRead` and `forgetting` (`telegram-owner-do.ts:1961-1972`). Common mode also still builds a task-source scope (`commonTaskSourcesForTurn`). `RunLoopDO` imports the same hooks, provider and scribe (`run-loop/do.ts:85,124,133`), and `common-owner-memory.ts` uses `memory/claims.ts`. Deleting legacy removes branches, not this code. Every blocker in §1 needs an explicit fix.

## 7. Reconciliation with #913, the eight Instinct changes and the 8 Oct sweep

The 8 Oct sweep (32 prompts) had 13 pass, 3 partial and 16 fail. 10 of the 16 failures are the task-source classifier (§1 #3), which confirms the top-ranked blocker on staging.

#913's slices 1–9 already cover these items from §1 and §6:
- the classifier (slice 1)
- the inbound scribe and canary (slice 2)
- the forget barrier as a note (slice 4)
- approvals only at the tool boundary (slice 7)
- custody deletion (slice 8)

Open PRs #910 (lenient `internal_context`), #892 (mail family for drafts and sends), #905 and #907 (Gmail reply and Calendar journeys), and #912 (circuit break) cover parts of §1 #2, #3 and §2 Writes. §6 "PR 1" is therefore superseded where these land.

The eight Instinct changes are broadly agreed, with three notes:
- **Canaries.** CLAUDE.md lists canaries as an allowed hard boundary. Keep a cheap canary check at egress destinations and delete the canary threading through composition. Owner call.
- **Responsibility record (change 3).** Keep the schema minimal so it does not become the next custody ledger.
- **Inbound health regex deletion (change 6).** Needs an ADR-0081 amendment.

### Gaps no current plan covers (general-agent core)

| # | Gap | Evidence | Fix |
|---|---|---|---|
| G1 | Common accepts Telegram text only | `telegram-owner-do.ts:268-269` | Surface-neutral turns (WhatsApp/iMessage) plus attachments and voice, before slice 8 |
| G2 | Common recall stub | `common-owner-host.ts:44` | Real recall in slice 4 |
| G3 | Two LLM calls run sequentially before the reply (classifier, then memory writer), plus a reaction call. This drives the 40–60 s latency. | `owner-turn.ts:1024,1036,1129` | Classifier: slice 1. Memory writer: make memory a tool in the main loop (remember/correct/forget with a receipt in the same turn). Reaction off the critical path. |
| G4 | History flattened into one `input_text` | `llm/openai.ts:111-113` | Real multi-turn items. Likely contributes to the bare "yes" losing context (T03, T30) [inference]. |
| G5 | Reasoning `low`, 4096 output tokens including reasoning, `incomplete` treated as failure, 0 retries | `llm/openai.ts` | Budget per turn type, partial output on `incomplete`, retry on transient errors |
| G6 | Memory regex gates (FORGET_INTENT, looksTransient, overlap, stopwords, 12-char floor). `read_memory`/`update_memory` have no handlers even though slice 4 lists `read_memory`. | `memory/claims.ts`, `hooks/tool-replay-class.ts:25,45` | Model-decided durability, correction and forget, with host grounding checks. Build a real memory tool. |
| G7 | PostLLMCall `owner_reply` policy applies a 4 KB cap and injection scoring to replies and tool-call arguments. Slice 2 names only "inbound". | `hooks/registry.ts:498-510,797` | Include PostLLMCall in slice 2. Check tool args only at their own PreToolUse destination. |
| G8 | Taint from Waldo's own reads blocks privileged tools | `conversation/tool-loop.ts:136-138`, `contracts/src/tools/handler.ts:98-125` | Own reads are not external. Taint should raise the approval bar, not block. |
| G9 | No compaction or summary of long history | `conversation/window.ts` | Compaction with a memory flush |
| G10 | Skills: 6 under 600 chars each, off by default, not files | `skills/curated-catalog.ts` | SKILL.md files, enabled by default, about 15 procedures, agent-proposed patches |
| G11 | Live eval set of about 40 scenarios on every deploy (agreed) | none in repo | Seed from the 32-prompt sweep plus §1 blockers. Grade traces, not reply text. |
| G12 | Recurrence only once or daily (T25); update cards gated on the brief; Gmail body capped at 4,000 chars, `text/plain` only; first-healthy-account selection | `reminders.ts:8`, `telegram-owner-do.ts:2392,1693`, `connectors/google.ts:256` | Cron recurrence, decouple from the brief, HTML bodies and paging, an account parameter |
| G13 | About 14.6 KB prompt, DOING and HEALTH repeated when a skill loads | `prompt/messaging-behavior.ts` | Trim to a stable core under 6 KB |
| G14 | No per-owner cost ledger or ceiling | — | A ledger per turn and per background job |

## Unverified

- Whether `COMMON_OWNER_TASKS` or the browser and search API keys are set as staging secrets.
- Live behaviour of every blocker above. These come from code reading and regex simulation, not from staging traces. PR 1's regression tests are the proof step.
- The chat model's identity and settings (`gpt-6-luna`, 30 s, 0 retries) beyond the 4096 output cap.
- Instinct's actual implementation.
