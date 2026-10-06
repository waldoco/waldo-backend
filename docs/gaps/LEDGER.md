# Gap ledger

Last updated: 2026-10-05 · audit read at `f38971d5`; G3 rows re-read at `beta-mvp` tip `82b423e7` (includes #798) · staging serves `e3adf20a` · latest audit: [2026-10-05-f38971d5](audits/2026-10-05-f38971d5.md) · plan: [PLAN.md](PLAN.md)

All rows are source-layer. Status and evidence rules: [README.md](README.md).

| ID | Gap | Tracker rows | Evidence (pinned) | Owner | Status | Next change (PLAN step) | History |
|---|---|---|---|---|---|---|---|
| G1 | Two per-owner brains: serving `TelegramOwnerDO` lacks Coordinator/RunLoop effect + closure machinery; conflicts with CLAUDE.md | B6, B7, B8, A7 | `src/index.ts:125,227`; `run-loop/do.ts:374` | Owner (ADR), Core | owner-call | 0.1 ADR + CLAUDE.md amendment | 2026-10-05 opened |
| G2 | Background-wake context unbounded vs 32,768-char sanitiser cap; failing cards ratchet; 400 misclassified (#787 hypothesis) | A3, B3 | `update-cards.ts:62`; `telegram-owner-do.ts:2186,2193`; `provider.ts:1416`; contracts `sanitise.ts:58` | Core | open | 0.2 falsifier, then Phase 2 | 2026-10-05 opened |
| G3a | 40-char prefix matching in hold and purge | B2, J4 | f38971d5: `memory/claims.ts:96,468`. 82b423e7: `update_cards` hold and purge share `cardCarriesTopic` (`claims.ts:116,537,803`); `LIKE_PREFILTER_MAX` still prefilters the other projection stores (`:96`) | Core (fix), Dalda (review) | source-fixed for `update_cards` (#798, not deployed); open for other stores | Phase 1 item 1 | 2026-10-05 source-confirmed at f38971d5; #798 merged |
| G3b | Purge collapses all non-kept keys into one `[forgotten]` key; mixed cards lose unrelated content | B2, J4 | f38971d5: `claims.ts:470-476`. 82b423e7: `blankCardPieces` blanks only topic-bearing leaves, keeps schema keys (`claims.ts:146`). Residual: unparseable `changes` still becomes bare `"[forgotten]"` (`:540`); an unlocalisable match blanks every leaf | Core, Dalda | source-fixed (#798, not deployed); residual open | Phase 1 items 2, 5 | 2026-10-05 source-confirmed; #798 merged |
| G3c | `update_cards` not in span-selector `collect` list → topic-only forget may never exit | B2, A3 | 82b423e7: `claims.ts:761-781` (not collected); early return for coverage ≠ 0 `[reported]` | Core | open | Phase 1 item 3 | 2026-10-05 opened; still not collected after #798; confirm with a red test |
| G3d | Readback uses a different matcher (`stringsOf`, values only, ignores keys) and throws on any unparseable row | B2 | 82b423e7: `claims.ts:689-697` | Core | open | Phase 1 item 4 | 2026-10-05 opened; still open after #798 |
| G3e | Incomplete forget truncates history to last message and clears memory, incl. background wakes | A3, A7 | `owner-turn.ts:579,444-447` | Core, Dalda | open | Closed by G3c fix; verify on trace | 2026-10-05 opened |
| G3f | Unsupported topic representations (#794) | B2 | f38971d5: split/NUL before char 40 escaped. 82b423e7: in-order splits and NULs inside a card now detected; interleaved pieces still not (`claims.ts:113-115`) | Owner + Dalda | owner-call | 0.5 decision | #794 open; narrowed by #798 |
| G4a | Gmail send, calendar apply, `message_send`: no claim before I/O | B7, B8 | `channels/approvals.ts:248-250` | Core | open | 3A.1 | 2026-10-05 opened |
| G4b | Local refresh-token route has no intent ledger → possible duplicate send after crash | B8 | `approvals.ts:241-265`; `telegram-owner-do.ts:1458` | Core | open | 0.3 then 3A.6 | severity pending 0.3 |
| G4c | No provider readback after successful send / calendar write | B7, J0 | `approvals.ts:249-251,146-159` | Core | open | 3A.2 | 2026-10-05 opened |
| G4d | Approval digest omits sending account; card shows no sender | B7 | `approvals.ts:241` | Core | open | 3A.3 | 2026-10-05 opened |
| G4e | Machine-turn sends bypass outbox; scheduler retry may resend | B8, A2 | `telegram-owner-do.ts:1891,2113,2146,2191` | Core | open | 3A.4 | 2026-10-05 opened |
| G4f | `evaluateTurnClaims` and `replayDecision` have no production caller | B7, B8 | `hooks/claim-hook.ts:44`; `hooks/tool-replay-class.ts:4,59` | Core | open | 3A.5, 3A.7 | 2026-10-05 opened |
| G4g | Gmail MIME has no attachments; attachment read unverified | J0, A5 | `connectors/google.ts:154-165` (no `attachment`) | Core | open | 0.4 | blocks J0 as written |
| G5a | Loops close only on model/owner word; no reply detection | A2, B6, J3 | `channels/loops.ts:44-48,111` | Core | open | 3B.1 | 2026-10-05 opened |
| G5b | Non-mail loops re-nudge every 4h (not once) | A2, J3 | `channels/heartbeat.ts:30,103,135` | Core | open | 3B.2 | 2026-10-05 opened |
| G5c | No resumable task state; `background_runs` audit-only | B6, J0 | `channels/background-runs.ts:34-56` | Core, Dalda | open | 3B.4 | 2026-10-05 opened |
| G5d | Two commitment models (`loops` table vs contracts `OpenLoop` v0.4); `proactiveGate` dead | B6 | contracts `responsibility-continuity-v0-4.ts:35` | Core | open | 3B.3, 3B.5 | 2026-10-05 opened |
| G6a | Attachment/voice turns get no source scope → all source reads refused | A4, J7 | `telegram-owner-do.ts:1720`; `telegram-turn.ts:27` | Core | open | 3C.1 | 2026-10-05 opened |
| G6b | `requires_connector` needs all 10 families; narrowed task blocks Google | B4, B7, J0 | `task-source-scope.ts:180` | Core | open | 3C.2 | 2026-10-05 opened |
| G6c | Export refused on unready turns; link needs console cookie (401 from Telegram); limiter mismatch | A5, B5, J5 | `task-source-scope.ts:178`; `telegram-owner-do.ts:747,1615`; `artifact-export-download.ts:61` | Core | open | 3C.3, 3C.4 | staging repro not checked |
| G6d | Background mail poll uses calendar account | B4 | `telegram-owner-do.ts:2123,1450` | Core | open | 3C.5 | 2026-10-05 opened |
| G6e | Background wakes admit every tool | B3, A7 | `owner-turn.ts:209,566,478` | Core | open | Phase 2 item 7 | 2026-10-05 opened |
| G6f | `read_drive` offered when disabled; stale comments; all skills default active | B9 | `telegram-owner-do.ts:1684`; `skills/curated-owner.ts:72-75` | Core | open | 3C.6, 3C.7 | 2026-10-05 opened |
| G7 | Regex rules make memory judgment calls (`looksTransient`, `correctionTopicMatches`, `FORGET_INTENT`) | A3, B2 | `memory/claims.ts:87,144-155,990-999` | Owner, Dalda | owner-call | 0.6 then 3D | 2026-10-05 opened |
| G8 | Entry-point docs stale and contradictory (CURRENT_SYSTEM, NEXT-SESSION-PLAN, AGENTS entrypoint, Sept planning docs) | process | `docs/CURRENT_SYSTEM.md:30-31,74`; `AGENTS.md:15` | Core / any | open | 3E | 2026-10-05 opened |
| G9 | No build SHA in traces; no eval runs | B1, B11 | no version metadata in `src/` | Core, Instinct | open | 3F | 2026-10-05 opened |

## Tracker corrections (source layer)

- A5/B5 "workspace tools unregistered": stale — registered and bound on staging.
- B9 "seven seeded": all catalog skills activated by `ensureDefaults`.
