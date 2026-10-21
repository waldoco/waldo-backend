# RCA: every owner turn reset by the Durable Object CPU limit (staging, 8-9 Oct 2026)

Status tags used below: LOCAL (reproduced or tested on a developer machine), PUSHED, MERGED (in beta-mvp), DEPLOYED (staging serves it), LIVE-PROVEN (a staging trace shows the behaviour). Only a staging trace counts as live.

## Summary

- Symptom: on staging every Telegram turn ended with the generic "request was interrupted, outcome uncertain" reply. Cloudflare logged "Durable Object exceeded its CPU time limit and was reset" on the alarm that ran the turn. Three of three e2e turns failed, then a fourth capture run failed. [LIVE-PROVEN]
- Cause (leading, consistent with every observation): the stored owner conversation (about 1,209 to 1,334 messages) exceeded the sanitiser's 1,024-item cap. The request sanitiser then trimmed the history one message at a time and re-scanned the whole remainder after every drop, so a single turn cost hundreds of full content scans (about 3 ms per 2 KB message each), with heavy allocation. [LOCAL for the cost; LIVE-PROVEN for the precondition and the fix: see Verification]
- Fix: cut the history to the destination's own structural caps before any scan, find the remaining cut by bisection, reject on any hard denial at a probe, and log content-free counts. [MERGED, DEPLOYED]
- Verification: after deploy, one turn on staging logged `reply:messages=1209` (pre-trim) then `reply:gateway_call:messages=1024` (post-trim), returned a real answer, and delivered, with no reset. One turn is not a soak. [LIVE-PROVEN, 1 of 1]

## Timeline (IST)

| When | Event | Stage |
|---|---|---|
| 8 Oct evening | Owner-loop slices merged to beta-mvp; staging deploy at e8a122d2 | MERGED, DEPLOYED |
| 23:05 to 23:11 | Real-Telegram e2e steps 1 to 3 all end in the interrupted fallback; Cloudflare shows CPU resets at 23:05:23, 23:07:32, 23:09:29, 23:09:39 | LIVE-PROVEN failure |
| 23:07 to 23:14 | Hop logs show pickup, receipt, typing, owner_request, health_context, then the reset 0.6 to 1.1 s later, with no model call | LIVE-PROVEN |
| 23:25 | Dashboard figures: 41.24M SQL rows read vs 204.61k written (account-wide, 30 days), stored size 11.07 MB | reading, not storage |
| about 23:30 | Per-phase timing hops merged (context composer phases) | MERGED |
| 00:13 | Capture on the phase-timing build: every composer phase finishes, reset about 0.9 s after the last one, CPU profile 100% garbage collection (isolate-level, not attributed to the object) | LIVE-PROVEN |
| 00:22 | Held-topic reads made once per call (hygiene, not the cause) | MERGED |
| 00:35 to 00:42 | Phase hops added around the model call | MERGED |
| 00:54 to 01:03 | Sanitiser cost measured locally (linear, about 3 ms per message); the trim loop identified; independently reproduced by a second reviewer (311 passes, 30 s CPU, 233 MB at 1,334 messages) | LOCAL |
| 01:14 | Pre-cut plus bisection merged | MERGED |
| 01:21 | Reviewer finds bisection can skip a hard denial; reproduced, fixed red-first | MERGED |
| 01:33 | Fixed head merged; staging deploys it | MERGED, DEPLOYED |
| 01:48 | One staging turn completes in about 5 s of runtime, 1209 to 1024 messages | LIVE-PROVEN |

## How the cause was found

1. Read what Cloudflare actually said. The reset was a CPU-limit reset on the alarm, not a thrown error, so there was no stack to read. The default CPU limit is 30 s and the resets came in about 1 s, so the limit setting was not the lever.
2. Make the turn narrate itself without content. Hops per stage (pickup, receipt, typing, owner_request, health_context) showed the stall sat after context composition and before any model call. Per-phase hops inside the composer showed all phases finishing. Hops around the model call (`reply:enter`, `reply:messages=N`, `reply:gateway_call:messages=M`, `reply:gateway_return`) pinned the step. These hops log names and counts only, never text.
3. Note what the instruments cannot see. In a Worker the clock does not advance during synchronous CPU, so a phase can report 0 ms and still burn. Row order, not milliseconds, was the evidence.
4. Try to reproduce locally with staging-sized state. Fresh-state and moderately large fixtures ran in 37 to 140 ms and found nothing. The reproduction only appeared once the fixture matched the real precondition: a history longer than the sanitiser's item cap.
5. Measure the suspect step in isolation. The sanitiser alone costs about 3 ms per 2 KB message, linear, with heavy allocation. The trim loop multiplied that by the number of dropped messages.
6. Cross-review. An independent reviewer reproduced the same loop from the code and the numbers. A second review of the fix then found a safety hole in the first fix (below).

## False leads (and why each was ruled out)

| Lead | Why it looked plausible | Why it was ruled out |
|---|---|---|
| Data size ("41M") | The dashboard shows 41.24M | That figure is account-wide rows read over 30 days. Stored size is 11.07 MB, 80 claims, 9 short held topics, 17 small skills. [dashboard, read-only SQL] |
| CPU limit too low | The reset says CPU limit | Default is 30 s, resets came in about 1 s; the limit was never the constraint. Raising it was left as an optional side test. |
| Zod just-in-time compile / schema churn | Version note about a newer release; GC-heavy profile | Not measured as the cause. Zod parsing is a multiplier inside the trim loop, not a separate cause. No dependency change was made. |
| Held-topic table reads per claim | Read amplification (3,013 reads for 1,500 claims) | Real inefficiency, fixed, but staging has 80 claims, so it could not explain the reset. |
| Long stored conversation alone | 1,400 stored entries | A turn on 1,400 entries of 12 KB each took 114 ms locally. The cost needed the sanitiser trim path, not the stored rows alone. |
| Dirty or wrong build deployed | Different bytes on staging | Retained bundle sources matched the commit; clean rebuild matched. |

## Why it slipped through

- Two limits in two places. The context window counts tokens; the sanitiser caps items (1,024) and characters (400,000). Short messages fit the token window and still exceed the item cap. [LOCAL, code]
- Expensive before cheap. The sanitiser scanned content before checking size, and the trim re-ran that scan per dropped message. The cheap structural check that would have rejected the excess ran last. [LOCAL, code]
- Tests used tiny histories. No test ran a turn with more than a handful of messages through the real provider path. [LOCAL, test review]
- Unmeasured per-turn cost. No budget existed for CPU per turn, number of sanitiser passes, or rows read per turn, so a quadratic path produced no failing signal until a long history met it on staging.
- Replaced behaviour was not re-measured. The previous single-pass fallback was replaced by a drop-and-rescan loop and the item cap was raised, with equivalence tested only on small inputs.

## The fix, and the hole found in it

- Pre-cut: keep only the newest messages inside the destination policy's item cap and derived character budget (sized by serialised length), before any content scan. Structural size only; no meaning heuristics. [MERGED, DEPLOYED]
- Bisection: a shorter suffix never fails where a longer one passes, so the smallest passing cut is found in about log2(n) passes. [MERGED, DEPLOYED]
- Hole found by review: bisection could probe a later passing suffix and silently exclude a history message that carried a canary, where the old trim rejected. Reproduced red-first, fixed so a hard denial at any probe rejects. [MERGED, DEPLOYED]
- Remaining hole, owner decision recorded: the sanitiser reports a structural denial before a canary, so a canary older than the soft message that forced the cut is dropped, not reported. Policy B was approved for later: scan only what is sent, log a content-free `history_hard_dropped` hop, remove the masked prefix check, add a test. [NOT STARTED, scheduled after the core fix is proven]

## Not fixed yet

- Every turn still loads all stored conversation rows (rows-read cost). [NOT STARTED]
- The sanitised history is re-scanned each tool round within a turn; a within-turn cache was suggested, a cross-turn cache was advised against. [NOT STARTED]
- About 35K tokens of raw history per turn (about 7 s gateway time, 10 s delivery); a token-sized window plus retrieval is the design direction, to be done behind regression scenarios for older content. [NOT STARTED]
- Sanitiser check order inside the sanitiser itself (size before content) outside this destination. [NOT STARTED]

## Prevention checklist

1. Staging-sized fixture: keep a seeded fixture that matches staging (history above every cap, claims, held topics, skills) and run one real-path turn against it in CI. [TO DO]
2. Pass-count tests: assert the number of sanitiser passes for long histories (done for two cases: at most 3 and at most 12). [MERGED, LOCAL/CI]
3. Per-turn budget: assert upper bounds on sanitiser passes, rows read and model-bound message count per turn, and fail CI when exceeded. [TO DO]
4. Content-free phase hops by default: names and counts only, at every stage boundary and around each model call; read order, not milliseconds. [MERGED for composer and model call]
5. Cheap before expensive: any validator must check structure and size before scanning content; any loop that re-runs a validator must be bounded or bisected. [TO DO, review rule]
6. One source for limits: the window and the sanitiser should read the same caps. [TO DO]
7. When replacing a fallback, measure the new path at the largest realistic input, not only the failing case. [TO DO, review rule]
8. Verify on staging with the hops: pre-trim count, post-trim count, and a delivered answer; report merged, deployed and live-proven separately. [followed here]

## Verification record

- Staging release at the time of the proof turn: 473be9aa (health check).
- Proof turn trace (newest first): turn delivered; outbox_delivery; respond 8.3 s; llm_reply 7.3 s; `reply:gateway_return`; `reply:gateway_call:messages=1024`; `reply:procedure_checked`; `reply:messages=1209`; `reply:enter`; composer phases with `owner_binding` 138 ms and the rest 0 ms.
- One turn. A soak and the full e2e script are still to run. [NOT YET]
