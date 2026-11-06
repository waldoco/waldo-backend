# ADR draft: care circle (A4)

Status: **proposed, not pre-accepted.** This is a design for the owner to rule on, written for waldoco/waldo-backend#1980
item A4. The Wave 2 rule pre-accepts bounded amendments, but this one lifts a launch deferral and adds the first exchange
between two owners, so it needs the owner's ruling, a security review and a legal review before any code. Until then
nothing in the runtime reads or writes a care circle.

## Why it cannot simply be built

| Constraint | Source | What it means for A4 |
|---|---|---|
| Trusted Relationships are deferred for launch | `waldo-brain/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md:54` | The owner must lift the deferral for this case. |
| Per-owner DO isolation: "no shared substrate, no cross-owner reads" | `AGENTS.md:27` (Named Invariant 3) | Nothing may pass from one owner's object to another's. An exchange has to go through a mediated store that each side reads under its own authority. |
| Non-owner content is untrusted provenance forever | `AGENTS.md:25` (Named Invariant 1) | A received signal can inform a turn. It never becomes durable truth or memory. |
| A Trusted Relationship shares no memory or authority; each owner admits, approves, executes and accepts their own side of a signed, minimal exchange | `CLAUDE.md:22` | This rule shapes the protocol below. |
| ADR-0081 has no destination for another person's health; "any new … destination … requires an explicit matrix/registry change" | ADR-0081 §3 and Consequences (`:120`) | Needs a dated ADR-0081 amendment with its own matrix row and fixtures. |
| "never profiles other people" | `docs/planning/BUILD_DIRECTION_2026-10-21.md:18` | Waldo may not infer who restores or drains the owner from calendars, messages or health. |
| Trusted Relationship exchanges never run without a card | `docs/proposals/AUTONOMY_OPT_IN_2026-10-27.md:98` | Every exchange needs the owner's explicit act. |
| User-isolation changes are escalated before merge; a user-isolation gap is HIGH | `.claude/rules/security-checklist.md` | A security-reviewer pass and an owner ping before merge. |

## Proposed decision

### 1. Who restores and who drains: the owner's word only

- **Source.** Only what the owner says, for example "time with my sister always lifts me" or "calls with X wear me out". Waldo never infers it from calendar co-attendance, message tone or health readings. That would profile other people, and health-pattern mining is deferred.
- **Storage.** The existing `remember` tool already holds it: a claim in the `people` area, grounded in the owner's own quote, correctable and forgettable on What Waldo knows. Nothing new is stored.
- **Use.** A planning instruction for the Brief and the Close. When the day is heavy, make room for someone the owner said restores them, and keep a draining commitment away from a low-recovery evening. The model weighs it; no rule fires on it.
- **Shipping.** This half crosses no owner boundary and could ship as a small prompt-and-scenario PR once the owner agrees with the wording.

### 2. A family member's health signal: a minimal, consented, revocable exchange

The two people are a **sharer**, for example a parent, and a **watcher**, for example their adult child. Each has their own Waldo.

- **The link.**
  - The sharer invites; the watcher accepts in their own Waldo.
  - Each side holds a consent row of its own, with a purpose of its own. Health's existing `storage_compute` and `model_processing` purposes never imply it.
  - It lives in one Supabase table relating the two owners under RLS, so each side reads only its own row.
  - Each side's Worker reaches it only through router-signed RPCs, the same signature every health RPC uses. There is no DO-to-DO call and no new cryptography.
  - The table carries the state (invited, active, ended), the signal kinds the sharer allows, the expiry and both receipts.
- **What crosses: one categorical signal per kind, computed on the sharer's health plane.**
  - The first and only kind is "a run of poor nights", meaning several recent nights in the sharer's low sleep zone.
  - It crosses as a yes with its day and nothing else: no reading, no zone history, no times, no score.
  - It needs a new ADR-0081 matrix row: a "consented circle member" destination, categorical only, with the sharer's per-kind consent live at send time.
- **Delivery.**
  - The sharer's plane writes one delivery row per signal and day.
  - The watcher's Worker reads it with the watcher's own authority and shows it to the watcher as a card: "Your mother has had a run of poor nights. Want to check in?"
  - The watcher's Waldo treats it as untrusted, as Invariant 1 requires. It may inform that turn but is never stored as memory or as a fact about the sharer.
- **Revocation and expiry.**
  - Either side can end the link. Ending it deletes pending deliveries, and every delivery row expires, for example after 7 days.
  - Account deletion removes both sides' rows under ADR-0055.
  - Both sides see the ending, and the sharer sees each delivery receipt.
- **Minimal by construction.** One signal kind at launch. Adding a kind needs another dated ADR-0081 amendment.

### 3. Conditions before any code

- The owner lifts the Trusted Relationships deferral for this case.
- A legal review. The sharer's health is special-category data (GDPR Art. 9) going to a named third party. Consent, its copy and withdrawal must satisfy Art. 9(2)(a) and DPDP.
- Privacy notice lines for both the sharer and the watcher.
- A security-reviewer pass on the RLS policy, the RPCs and the delivery path. This includes the cross-tenant golden test from ADR-0066: a watcher reads zero rows of any other link.
- Scenario tests for impersonation, replay, an expired link, a revoked link, a forged signal kind and a watcher who never accepted.

## Considered and rejected

- **Sending a parent's zones or readings.** That's more than the job needs, and it breaks ADR-0081's "external channels receive no numeric health value".
- **Shared memory or a shared constellation** (the old Pack tier). This breaks Invariant 3 and `CLAUDE.md:22`.
- **Inferring "who drains you" from calendar and recovery co-occurrence.** This profiles other people, and it is health-pattern mining, which is deferred.
- **Direct DO-to-DO signed messages with per-owner keys.** That means new key management and hand-rolled cryptography (the PR-138 architecture review advises against both). A mediated table under RLS and router-signed RPCs reuses what the health plane already trusts.
