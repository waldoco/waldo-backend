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

- **Reply-turn outage FIXED in sandbox, awaiting morning deploy** (02:45 IST): every reply turn on deploy 57c098ce died pre-flight on a structural scribe deny (sanitiseRequest fail-closed on false-positive shapes); fix 05b24d8 degrades structural denies and strips zod's ~standard from tool definitions. Gates green; live proof = morning deploy + 'connect my google'.

- **Google data-path RCA - VERDICT DELIVERED** (lane's dashboard RCA, ~01:30 IST): the worker's
  SUPABASE_PROJECT_URL secret points at a stale third project - togds shows zero connector-proxy
  calls in the exchange window and zero connection rows; Woof 1 has no waldo schema. Turns stayed
  green via the single-owner routing fallback, masking the break. Second bug: connector-proxy
  deployed with the gateway JWT check on (runbook lacked --no-verify-jwt). Fix + live re-run:
  PACKET_R2_2026-09-25.md, awaits the owner.
- S4 (ConnectIntent contract + responder offerConnect): COMMITTED and pushed (this push). Live verification folds into the morning deploy + 'connect my google' re-run.

## Remaining from the original MVP plan (BUILD_ORDER)

| Item | What | Blocked on |
|---|---|---|
| 3-5 | B1 minted console link, session list, multi-user routing | console email sign-in (needs Resend key) |
| 6-9 | Dashboard P0-P2 (shell, memory explorer, trust mutations, usage) | item 3 + owner picked lo-fi visuals; build pending |
| 13 | Kennel bridge + machine context layer (minimi parity S1-S8) | Ashish's review |

## Discovered along the way (additions since the plan)

- Connect-flow redesign S1-S6 (born from the 22:35 live failure): S1-S4 committed, S5-S6 pending.
- Debugging DevX program (Rung 0 instrumentation, Rung 1 browser dashboards, deploys stay Mac-only).
- Packet hygiene law + bug-log discipline (after the P3 packet bug).
- Token-efficiency groundwork, WALDO_ENVIRONMENT/RELEASE tagging (root-caused tonight: vars unset).
- **Waldo Vault** (owner call 01:16, confirmed 01:28 - build it, near-term, ahead of dashboard v2.1):
  per-owner encrypted credential store, fill-only browser access (values never reach the model),
  dashboard management, revocation = delete, takeover-mode fallback for sites that block automated
  login. Evaluate Notte's vault as the base/service vs building on Supabase. Spec: lane research
  queued after the RCA close.

## Blocked on the owner (one glance)

1. Run PACKET R2 (~10 min: rewire secrets, redeploy connector-proxy, ship.sh, optional pgTAP, live connect re-run) - fixes the RCA, verifies google connect end-to-end.
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
