<!-- MIRRORED FROM waldo-brain/.claude/rules/hey-109-workflow.md @ 8f74f163fdb0 -->
<!-- Do not edit locally. Edit canonical in waldo-brain, then resync. -->
<!-- Sync ritual: see waldo-brain/.claude/rules/MIRROR-SYNC.md -->

# HEY-109 Multi-Agent Workflow

> **Canonical source:** `waldo-brain/.claude/rules/hey-109-workflow.md` @ `8f74f163fdb0`. This file is a verbatim mirror per [[0063-canonical-rule-files-mirroring|ADR-0063]]. Edits land canonical-first; do not edit locally.

> RFC2119 keywords (**MUST**, **SHOULD**, **MAY**, etc.) apply per [`posture.md`](posture.md).

> Authority: this file is the operational form of `mental-model.md` §5 (NO AI SLOP). The reviewer catches what the author missed; the author's independent verification catches what the fix-pass subagent overclaimed.

---

## Source of Truth

The Linear issue **HEY-109** is the live session bus (per ADR-0043). It carries the current cluster split, drift report, and build state. This rule file pins the **discipline**; HEY-109 carries the **state**.

You **MUST** read HEY-109 at session start and update at session end. The session-start update is covered by the `/session-bus` skill where available.

---

## Cluster Split — Single Writer per Cluster

Waldo is built by **two AI coding agents in parallel** — Claude Code and Codex — coordinated through HEY-109.

Only the cluster owner edits that cluster's ticket bodies. Cross-review is **comment, not edit** — the reviewer posts a verdict on the ticket or PR; the writer applies. The reviewer **MUST NOT** edit the body directly.

| Cluster owner | Owns |
|---|---|
| **Claude (`agent:claude`)** | `@pin4sf/waldo-types` contracts · memory · Scribe · recall · CRS · body-context · GDPR · consent · privacy · product-gap classification · global dependency graph · HEY-109 itself |
| **Codex (`agent:codex`)** | DO loop · run-journal / outbox · hooks · tool dispatcher / ACL · Telegram ChannelAdapter inbound + threading · LLMProvider · eval / observability · internal infra (wrangler, AuditedDB) |

Repo mapping (rough — exceptions exist per individual ticket):

| Repo | Mostly owned by | Exceptions |
|---|---|---|
| `waldo-types` | Claude | — |
| `waldo-backend` | Codex | Supabase schema (HEY-9), CRS engine (HEY-102), memory/Scribe/recall, GDPR runbook (HEY-101) → Claude |
| `waldo-app` | Suyash-led; agents touch on cross-repo dep changes | Cluster split applies when agents touch |
| `waldo-brain` | Both — Claude owns the docs/contracts cluster, Codex owns infra/hooks cluster | — |

---

## Linear Labels

| Label | Color | Meaning |
|---|---|---|
| `agent:claude` | `#7C3AED` | Claude Code owns the body + grabs to implement |
| `agent:codex` | `#0891B2` | Codex owns the body + grabs to implement |
| `review:claude` | `#C026D3` | Cross-review state — waiting on Claude to review (typically state `In Review`) |
| `review:codex` | `#0E7490` | Cross-review state — waiting on Codex to review |
| `ready-for-agent` | `#16A34A` | Spec fully meets Agent-Ready bar — AFK-loop eligible |
| `needs-info` | `#D97706` | Spec gap — waiting on Shivansh; do not guess |
| `ready-for-human` | `#2563EB` | Needs human implementation (design, eng judgment) |
| `external-blocker` | `#991B1B` | Apple Dev / APNs / OAuth approval — Shivansh action required |

These compose with `agent:X` and `review:Y`. There is no `agent:human` — `ready-for-human` covers it.

---

## Lifecycle

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 1. Owner adds `agent:X` while writing body to the Agent-Ready bar.        │
│                                                                            │
│ 2. Bar met → add `ready-for-agent`.                                       │
│                                                                            │
│ 3. Agent grabs → branch → PR.                                             │
│    On PR open: flip `agent:X` → `review:Y` (the *other* cluster),         │
│                 state → `In Review`.                                       │
│                                                                            │
│ 4. Reviewer posts P0 verdict comments on the PR.                          │
│    Author iterates fix-pass cycles via background subagents +             │
│    independent verification (re-run validations, confirm tests are        │
│    non-vacuous, grep source for the claimed change).                      │
│    Label stays `review:Y` until reviewer approves.                        │
│                                                                            │
│ 5. Approved → squash-merge with `--delete-branch` → state `Done`.         │
│    Labels stay as audit trail.                                            │
│                                                                            │
│ 6. Update HEY-109 cycle comment + `Last-update:` line on every            │
│    meaningful state change.                                                │
└───────────────────────────────────────────────────────────────────────────┘
```

### Daily-use filters

| Filter | Purpose |
|---|---|
| `ready-for-agent + agent:claude + state:Todo` | Claude's pickup queue |
| `review:claude` | Claude's review queue |
| `ready-for-agent + agent:codex + state:Todo` | Codex's pickup queue |
| `review:codex` | Codex's review queue |

---

## Agent-Ready Bar — 10 Items

Promote a ticket to `ready-for-agent` **only if all 10** are present in the body:

1. **Source-of-truth links** — overview section + linked ADR(s)
2. **Module · Interface (the worker implements) · Implementation hidden · Seam / adapters** — using the vocabulary from `language.md`
3. **Dependencies / blocked-by** — explicit list, even if "none"
4. **Acceptance criteria** — at least one golden test (specific input → specific output)
5. **Validation commands** — exact commands the agent runs to prove acceptance (or explicit "docs-only" validation)
6. **Failure / degraded-path coverage** — 5-bucket: null · permission-revoked · network · hostile · concurrent
7. **Reversibility / rollback note** — what happens if this ships broken
8. **Security / privacy constraints** — even if "none new"; explicit confirmation
9. **Out-of-scope section** — what this ticket does NOT cover
10. **No open founder / legal / product question** — if any: `needs-info`, not `ready-for-agent`

Missing any one → label is `needs-info` or `ready-for-human`, never `ready-for-agent`.

This bar is non-negotiable. It is the moat against AI slop on AFK-loop grabs.

---

## PR Pattern

- Branch from `main`.
- Branch name: `hey-NN-<slug>` (Linear auto-detects).
- PR title includes `HEY-NN`. PR description includes `Closes HEY-NN`.
- Commits use the convention `<scope>: <what> (why: <reason>)` — see repo `CLAUDE.md` for the `<scope>` taxonomy per repo.
- Independent reviewer (the *other* cluster) posts P0 verdict on the PR. Reviewer **MUST NOT** edit the body — comment only.
- Author iterates fix-pass cycles via background subagents.
- Author independently verifies each fix-pass:
  - Re-run validations from the ticket
  - Confirm tests are non-vacuous (the test would fail on broken code)
  - Grep source for the claimed change to confirm it landed where claimed
- Squash-merge with `--delete-branch`.
- Update HEY-109 cycle comment + `Last-update:` line on every meaningful state change.

The fix-pass-then-verify loop is the moat against AI slop: the **reviewer** catches what the **author** missed; **independent verification** by the author catches what the **fix-pass subagent** overclaimed.

---

## When a Fix-Pass Subagent Overclaims

Common pattern. The subagent reports "fixed in `src/foo.ts:42`" and you take its word.

The discipline:

1. **Grep the source** for the symbol or line the subagent claims to have changed. If `grep` does not find it, the change did not land. Re-run.
2. **Re-run validations** from the ticket. If they pass on the first run but the subagent's earlier runs failed, suspect the test was loosened — read the test diff.
3. **Confirm the test is non-vacuous**. Temporarily break the production code in the way the test was supposed to catch. If the test still passes, it does not actually verify the claim.

You **MUST NOT** mark a ticket complete on the subagent's word alone.

---

## See also

- HEY-109 (Linear) — current build state + drift report + retro-tag history
- ADR-0043 — cross-session bus pattern (the architectural decision behind HEY-109)
- ADR-0001 — three-repo + shared types contract
- [`mental-model.md`](mental-model.md) — the 6 disciplines; this workflow is the operational form of §5 (NO AI SLOP)
- [`language.md`](language.md) — vocabulary for ticket bodies (Module, Interface, Seam, Adapter)
- [`posture.md`](posture.md) — universal agent posture, truthfulness contract, destructive actions
