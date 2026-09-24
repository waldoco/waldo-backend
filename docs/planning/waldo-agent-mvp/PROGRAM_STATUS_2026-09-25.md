# Program status - 2026-09-25 ~03:00 IST (reconciliation pass, owner's pre-sleep ask)

Grading honesty: LIVE-VERIFIED = proven on staging with a packet/trace result on the current
code line. DEPLOYED-UNVERIFIED = on the staging worker/DB but no live proof. COMMITTED = gates
green on beta-mvp, not deployed. CODE-ONLY = written, not committed. NOT-STARTED = no code.

Repo HEAD: 0dc0b63 (beta-mvp). Staging worker: version 57c098ce = commit 68dd014 (broken reply
path - see outage row). Supabase: Waldo-MVP (togds) is the wired project; Woof 1 is stale.

## LIVE-VERIFIED

| What | Evidence | Caveat |
|---|---|---|
| Telegram turn loop (reply, reaction, memory) | P2 PASS 00:25, 13 hops green, on deploy acee4cc8 | REGRESSED on 57c098ce (every reply died pre-flight scribe); fix 05b24d8 awaits morning deploy |
| Google OAuth consent mechanics (button -> Google consent -> linked, 7 scopes) | P3 partial 00:28 | was proven against the STALE project wiring; R2 rewired to togds (steps 0-4 PASS) but the end-to-end re-run (step 6) was blocked by the reply outage - re-verify morning |
| Egress guard + history scrub (S1) | P1 deploy | live redaction box still open |
| Token custody (W2/W3: no token reaches model/DO/worker; proxy-only) | PROGRAM_STATE_2026-09-24 probes | - |
| Langfuse observability (US project, traces flowing) | tonight's RCA ran on live turn traces | environment tag unset (WALDO_ENVIRONMENT) - P3 root cause, unfixed |
| Connector-proxy reachability with own HMAC auth | R2 step 3 probe: unsigned POST gets the function's own 401 'unsigned proxy call', not the gateway's | - |

## DEPLOYED-UNVERIFIED (on staging, no live proof)

| What | State |
|---|---|
| S2 connect_sessions migration + signed RPCs (712e6e2) | migration applied to togds (R2 step 1 PASS); local pgTAP 115 tests, 3 assertion failures pending judgment (2 look like grant-list drift, 1 wording) |
| S3 /c/ticket connect links (06aeee5) | in 57c098ce; live re-run blocked by the outage, then by sleep |
| 12b tool outputs into context composer (a9438d3) | deployed, never exercised live |
| web_search + browse_page/browse_act handlers | keys live on the worker (Brave, Browserbase reconciled tonight); never exercised live |
| RESEND_API_KEY on worker | secret live tonight; console email sign-in code not started |

## COMMITTED, NOT DEPLOYED

| SHA | Slice | Gates |
|---|---|---|
| 05b24d8 | Reply-outage fix: structural scribe denies degrade, ~standard stripped from tool defs | typecheck; contracts 1657/1657; runtime 1433/1433 |
| 0dc0b63 | S4 ConnectIntent contract + responder offerConnect seam | same gate run |

## NOT-STARTED

- Headless scenario harness (owner's top build priority after the outage - spec first, then build; synthetic-webhook telegram testing path folds in).
- B1 minted dashboard link, session list/sign-out, multi-user routing (UNBLOCKED: Resend key live).
- Dashboard P0-P2 (shell, memory explorer, trust mutations, usage) - lo-fi visual bar.
- Gmail live handler for get_communication (google 'mail' infra exists).
- S5-S6 connect-flow remainder per CONNECT_FLOW_DESIGN.
- Waldo Vault spec (Notte-vs-build research; include key-to-sandbox channel as rung-2 unlock).
- Kennel bridge + machine context layer (blocked on Ashish's review).
- HARNESS_COMPARISON doc + tool/connection parity inventory numbers.

## The 2026-09-25 02:06 outage (R2 step 6) - RCA closed

Every reply turn on 57c098ce died pre-flight: sanitiseRequest hard-failed the whole turn on any
structural scribe deny (invalid_payload), so one un-sanitisable string in history/memory/system
killed every turn; reactions kept working (no history). Fix 05b24d8: structural denies degrade
to a reduced re-sanitised request; hard security denies still fail closed. Second real bug found
en route: zod v4 toJSONSchema stamps tool definitions with a non-JSON ~standard marker - stripped
before the wire. Morning: pull, deploy, Telegram 'connect my google' - expect the connect card;
worst case the error now names the exact scribe destination+reason.

## Remaining to the final Waldo agent (owner's morning list)

1. Morning deploy packet + live re-verify (reply turns, connect flow end-to-end, pgTAP verdict).
2. Scenario harness build (spec done tonight, then implementation).
3. B1 + session list + multi-user routing; dashboard P0-P2 behind them.
4. Gmail live handler; S5-S6; parity-gap tools from the comparison work.
5. WALDO_ENVIRONMENT/RELEASE tagging fix (one wrangler vars packet line).
6. Vault spec -> vault slice (owner-confirmed near-term, ahead of dashboard v2.1).
7. Kennel bridge when Ashish's review lands.

## Blocked on the owner (one glance)

1. MORNING: pull beta-mvp, deploy, re-run the live connect proof (~10 min packet).
2. Standing rulings: six eval findings, gpt-5-mini enablement, Langfuse retention, DO token fallback, WhatsApp route.
3. PACKET C1 (June leftovers cleanup, approved 23:02, unrun).
