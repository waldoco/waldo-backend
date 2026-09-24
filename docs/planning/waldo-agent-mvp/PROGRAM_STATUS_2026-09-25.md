# Program status - 2026-09-25 ~01:10 IST

Owner ask: the whole program on one page - built vs remaining vs blocked-on-him, against the
original MVP plan plus every addition since. Evidence honesty: "live" = proven on staging with a
packet result; "committed" = gates green on beta-mvp, not yet deployed/proven live.

HEAD: d75266b (beta-mvp). Staging worker runs 1cce32b (deployed 23:49, version acee4cc8).

## Verified LIVE on staging

| What | Evidence |
|---|---|
| Telegram bot turn loop (reply, reaction, memory) | P2 PASS 00:25, 13 hops green |
| Google OAuth consent itself (button -> consent -> linked, 7 scopes) | P3 partial 00:28 |
| Egress guard + history scrub deployed (S1) | P1 deploy; live redaction box open |
| Evals v0 on the real responder (42 cases) | W7 runs, results doc |
| Console auth, token custody (W2/W3 lines) | per PROGRAM_STATE_2026-09-24 |

## Committed, NOT yet live (deploy + proof pending)

| SHA | Slice | Needs |
|---|---|---|
| a9438d3 | 12b tool outputs into context composer | redeploy |
| 712e6e2 | S2 connect_sessions migration + signed RPCs | db push + pgTAP (PACKET 4) |
| 06aeee5 | S3 /c/ticket connect links | S2 applied + redeploy + P3 re-run |
| f218740 | packet hygiene fixes (P3 packet bug) | - |
| d75266b | DEBUGGING_DEVX spec | owner review |

## In flight right now

- **Google data-path RCA** (consent links but calendar/mail fail; no connections row on the
  inspected project): report delivered, PACKET R1 (read-only diagnostic) awaits the owner. Top
  hypothesis: Supabase project mismatch; the row's own last_error column will name the failure.
- S4 (ConnectIntent contract + responder offerConnect): parked mid-build, unblocked, no decisions needed.

## Remaining from the original MVP plan (BUILD_ORDER)

| Item | What | Blocked on |
|---|---|---|
| 3-5 | B1 minted console link, session list, multi-user routing | console email sign-in (needs Resend key) |
| 6-9 | Dashboard P0-P2 (shell, memory explorer, trust mutations, usage) | item 3 + owner picked lo-fi visuals; build pending |
| 13 | Kennel bridge + machine context layer (minimi parity S1-S8) | Ashish's review |

## Discovered along the way (additions since the plan)

- Connect-flow redesign S1-S6 (born from the 22:35 live failure): S1-S3 committed, S4 parked, S5-S6 pending.
- Debugging DevX program (Rung 0 instrumentation, Rung 1 browser dashboards, deploys stay Mac-only).
- Packet hygiene law + bug-log discipline (after the P3 packet bug).
- Token-efficiency groundwork, WALDO_ENVIRONMENT/RELEASE tagging (root-caused tonight: vars unset).

## Blocked on the owner (one glance)

1. Run PACKET R1 (2 min, read-only) - settles the RCA.
2. Fill 3 vault links (Langfuse / Supabase / Cloudflare dashboard logins) - unlocks lane self-serve debugging.
3. Resend API key - unblocks console email sign-in (items 3-5).
4. Run PACKET C1 (June leftovers cleanup, already approved 23:02).
5. Browserbase free-plan signup - unblocks P6 browser live proof.
6. Standing rulings: six eval findings, gpt-5-mini enablement, Langfuse retention, DO token fallback, WhatsApp route.

## Standing bars (unchanged)

Production-grade backend under lo-fi UI (owner's call 21:16); per-slice benchmarking vs top
open-source tools reported; every library usage verified against current official docs; every bug
gets adversarial test + checklist line + bug-log row in the same commit; nothing counts as done on
tests-only claims - the living checklist carries live-vs-committed status per slice.
