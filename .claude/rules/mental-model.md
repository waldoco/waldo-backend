<!-- MIRRORED FROM waldo-brain/.claude/rules/mental-model.md @ b81466591c72 -->
<!-- Do not edit locally. Edit canonical in waldo-brain, then resync. -->
<!-- Sync ritual: see waldo-brain/.claude/rules/MIRROR-SYNC.md -->

# Mental Model — Non-Negotiable Across All 4 Repos

> **Canonical source:** `waldo-brain/.claude/rules/mental-model.md` @ `b81466591c72`. This file is a verbatim mirror per [[0063-canonical-rule-files-mirroring|ADR-0063]]. Edits land canonical-first; do not edit locally.

> RFC2119 keywords (**MUST**, **SHOULD**, **MAY**, etc.) apply per [`posture.md`](posture.md).

Source of truth for HOW we think when solving any problem. These 6 disciplines override any individual rule file when they conflict. Read this AFTER `posture.md` and BEFORE any repo-local rule.

**The spine:** define the problem before the solution (#1), get the system architecture right before writing code (#6), and let no almost-right AI-generated code through review (#4). More time on WHAT to build than HOW — a clean, well-scoped problem becomes a working PR.

---

## 1. Problem-First Thinking (define the problem before the solution)

**The rule:** Spend more time on the PROBLEM than the solution. Two cases:
- **Before building:** define and scope the problem first — what user outcome, what's in scope vs out, what "done" looks like. A clean, well-scoped problem turns into a working PR; a fuzzy one turns into rework. If you can't state the problem in 2-3 sentences with a clear acceptance bar, you are NOT ready to write code — push back with `needs-info`.
- **Before fixing:** find the ROOT CAUSE at the system + library level. Never patch the symptom.

The checklist below is the fixing case. The building case is gated by Architecture-First (#6) and the ticket's Acceptance bar.

### What this looks like in practice

Bad:
```typescript
// Random retry because something flakes
try { result = await api.call(); }
catch { result = await api.call(); } // ¯\_(ツ)_/¯
```

Good:
```typescript
// First: WHY does it flake? Race condition in the SDK's connection pool.
// SDK bug filed upstream. We mitigate at the only correct layer — wrap
// with a circuit breaker that fails fast + falls back per ADR-0004.
const breaker = new CircuitBreaker(api.call, { threshold: 3, resetMs: 30_000 });
```

### Mandatory before writing ANY fix

1. **Reproduce the bug** — write the failing test FIRST. No reproduction, no fix.
2. **Trace the full code path end-to-end.** Read the actual functions, not the error message.
3. **Read the library source in `node_modules`.** Don't trust your training data; library APIs change. Verify against installed version.
4. **Check git history** (`git log`, `git blame`) on the broken area. If patched before in this area, the previous approach was probably wrong — find the real layer.
5. **State the root cause in ONE sentence with ONE "because."** If you need two becauses, you haven't found root cause yet.
6. **List 2+ alternative fixes**, ranked by confidence + breakage risk + reversibility.
7. **Confidence score (0-100%)** on the chosen fix. <70% = more research needed.

### Hard NEVER

- Never iterative-patch (fix → break → fix → break).
- Never trust the error message as the root cause — it's a symptom.
- Never apply a fix you can't explain at the library/system level.
- Never copy-paste a Stack Overflow answer without reading what it actually does.
- Never use `try/catch` to mask flakiness — find why it's flaky.

### When to invoke

- Bug report from QA
- Test failure in CI
- Production incident
- Any 3rd "this looks weird" moment in a code path

Invoke `/diagnose` skill. It enforces the RCA discipline.

---

## 2. Product-First Thinking (always trace back to user value)

**The rule:** Every line of code must trace back to a JTBD (Jobs-to-be-Done) we've identified. If you can't name the user problem the line solves, delete it.

### What this looks like in practice

Before:
```typescript
// "I'll add caching here because it'll be faster"
const cache = new LRU({ max: 1000 });
```

After:
```typescript
// JTBD: Morning Wag must deliver <3s after wake (per ADR-0017 cadence).
// Profiling showed memory load was 1.4s. Cache cuts to 80ms.
// User outcome: Morning Wag feels "always on it," not "syncing now."
const memoryCache = new LRU({ max: 200, ttl: 60_000 });
```

### Mandatory before writing ANY feature

1. **Name the JTBD it serves.** "Already on it" requires a meeting-context Spot 35 min before board call. The JTBD is "make Waldo know what I have on my plate today before I open my phone."
2. **Trace to a Suyash flow + an ADR.** If neither references this work, push back with `needs-info` — don't guess.
3. **Ask "what does the user see when this works?"** If the answer is "nothing visible," check that internal improvement actually unblocks a visible improvement downstream. If not, defer.
4. **Banned justification:** "It's clean code." "Best practice says…" "It might be useful." All real product work has a user.

### When to invoke

- Any new feature
- Any refactor (refactors must serve a user outcome — better latency, fewer bugs, faster iteration)
- Any "let me just add this real quick"

Invoke `/grill-me` skill. It enforces product justification.

---

## 3. First-Principles Thinking (always verify, never assume)

**The rule:** Decompose every claim to physics-level constraints. Then build up. Never inherit assumptions from "everyone does it this way."

### What this looks like in practice

Common assumption: "Use a Postgres database with an ORM because that's standard."
First-principles: "What's the access pattern? Per-user agent state in 10 tables with single-writer guarantee → fits Durable Object SQLite better than shared Postgres. Health data needs RLS + tenant isolation → fits Supabase. Different access patterns → different stores." → ADR-0002.

### Mandatory before locking ANY architecture decision

1. **List the actual constraints** — latency, cost, throughput, security, scale, dev velocity.
2. **For each constraint, ask "is this real or inherited?"** Most "best practices" are someone else's constraints from 5 years ago.
3. **Cite primary sources** — paper, source code, official docs. Never "I read on a blog post."
4. **Verify with running code** when claim is testable. Spike branches are cheap.
5. **Document the considered options + why each rejected.** ADRs require this — see ADR-0029 "Considered Options" section.
6. **Cross-reference to industry sources** — Hermes, Cursor, Cognee, MemPalace, agentic-stack, Fowler SPDD. ALWAYS cite when adopting a pattern.

### Hard NEVER

- Never adopt a pattern you can't reduce to its physics.
- Never use a library because it's popular — use it because it solves YOUR constraint.
- Never accept "industry standard" as justification. Industry has been wrong many times.
- Never assume training data is current — `context7` MCP for any library docs question.

### When to invoke

- Locking an ADR (mandatory)
- Choosing a vendor/library
- Designing a new module
- "But everyone else does X" thought

Invoke `/grill-with-docs` skill. It enforces source-verified ADR authoring.

---

## 4. Test-Heavy + Thorough QA (E2E is the only truth)

**The rule:** Unit tests prove code correctness; only E2E tests prove FEATURE correctness. We ship features, not code. Therefore E2E is non-negotiable.

### Test pyramid (inverted from defaults — we lean heavy on integration + E2E)

```
        E2E + manual on real device  ←  golden path + 5 edge cases per feature
       Integration tests              ←  adapter + provider + real DB
      Unit tests                       ←  pure functions only (CRS math, parsers)
```

Most teams: 70% unit / 20% integration / 10% E2E.
**We: 40% unit / 40% integration / 20% E2E.**

### Why

- Type system already proves a lot of code correctness for us. Unit tests pile on top of that = diminishing returns.
- Integration tests catch the actual class of bugs we hit (adapter wiring, schema mismatches, OAuth flow breakage, RLS gaps).
- E2E tests are the only proof a feature works end-to-end across phone → CF Worker → Supabase → LLM → Telegram/APNs back.

### Mandatory for every PR

1. **Golden test from the ticket's Acceptance section.** Failing test FIRST. Make it pass. /tdd discipline.
2. **At least 3 edge cases per feature:** null/empty input · permission revoked · network failure mid-flight. Per QA-breaker handbook in waldo-brain.
3. **For tools (any handler):** every Zod schema has a `valid + invalid` test pair. ADR-0029 requires this.
4. **For adapters:** mock + real provider tests. Mock test ships in CI. Real provider test ships in nightly.
5. **For triggers:** time-mocked test (DST + timezone change + quiet-hours + cooldown).
6. **For agent loops:** trace assertion — what tools called, in what order, with what budget, ending in what delivery.
7. **For UI in waldo-app:** physical device run before PR. Simulator hides perf + battery + permission bugs.

### Thorough QA = 5-step adversarial pass per feature

1. **Happy path** — does it work for the typical user with typical data?
2. **Null path** — does it gracefully handle missing wearable data, missing OAuth scopes, missing calendar events?
3. **Hostile path** — what happens with adversarial input? Prompt injection? Malformed payload? SQL escape attempts?
4. **Concurrent path** — 3 fetch alerts in 10 min, 2 simultaneous chat messages, calendar sync during agent loop?
5. **Degraded path** — what happens when LLM is down, Supabase is down, Telegram is rate-limited?

Invoke `qa-breaker` review-agent or `/break-feature` skill. Both enforce the 5-step adversarial pass.

### Strategic review of AI-generated code (every PR)

Most code here is AI-generated. Review it like an adversary, not a rubber stamp — the model gets logic *almost* right, and almost-right is wrong.

1. **Read for intent, not vibes.** Does the logic do what the ticket asked on EVERY branch, or just look plausible?
2. **Hunt the almost-right.** Off-by-one, inverted condition, wrong store written, missing null path, happy-path-only handler — this is where AI code fails.
3. **Kill slop on sight** (per #5): code "just in case", defensive handling of edge cases you never defined, tests that only assert the mock. Delete it.
4. **No PR merges on "looks fine."** Either the logic is provably, fully right (test + trace), or it goes back. Almost-right never ships.

### Hard NEVER

- Never merge a PR without the golden test for the Acceptance section.
- Never skip integration tests because "unit tests cover it." They don't.
- Never assume the simulator behavior matches device behavior — it doesn't.
- Never ship a feature without trying to break it yourself first.
- Never close a Linear ticket without running the relevant E2E.

---

## 5. NO AI SLOP (every line earns its place)

**The rule:** Code, prose, commits, comments — every artifact must justify why it exists. If a thoughtful person reviewing your output would think "this is verbose / generic / hedged / drifty / unrequested" — it's slop. Delete or rewrite.

### What slop looks like

| Slop | Why it's slop |
|---|---|
| 5-paragraph reply when 3 lines suffice | Verbose where tight is wanted |
| `// Catch any errors` above `catch (e)` | Comment restates the code |
| `try { ... } catch { /* TODO */ }` left in PR | Half-finished patch, not a fix |
| Adding generic disclaimers ("Note: AI-generated") | Unrequested junk |
| Markdown headers + bullet lists on a yes/no question | Format-drift |
| "I will now…" / "Sure, I'd be happy to…" / "Let me think about this…" | Filler, no information |
| Comments explaining WHAT the code does | Well-named code already explains; only WHY non-obvious deserves a comment |
| Backward-compat shims for code nobody calls | Patch, not root cause |
| Test that only verifies the mock returned the mock value | Doesn't exercise real behaviour |
| Re-importing the same type three different ways | Cargo-culted boilerplate |
| Implementation that "handles all edge cases" you didn't define | Defensive coding for hypothetical bugs |
| 20-line ASCII diagram in a commit body | Format-drift, ignored at review |

### Every line of code must answer

1. **Why is this line here?** (real reason, not "looked good")
2. **Is it solving the requested purpose, or adding scope?**
3. **Does it help the end goal, or just exist?**
4. **Is it the real fix at the real layer, or a patch?**
5. **Would a thoughtful reviewer ship it without changes?**

If any answer is "no" or "I'm not sure" — rewrite or delete.

### Hard NEVER

- Never add code "just in case"
- Never add comments that paraphrase the line below
- Never add disclaimers, apologies, or hedging in code or commits
- Never patch a symptom when the root cause is one layer up
- Never copy-paste a pattern without checking it fits THIS situation
- Never leave dead code / commented-out blocks / TODO landmines
- Never use placeholder names (`tempData`, `result2`, `handleStuff`)
- Never write a test that doesn't fail when the code is wrong
- Never ship verbose where tight wins

### The test

Before shipping any change, ask: "Would a senior engineer who has 30 seconds skim this and think 'tight + clear' OR 'verbose + drifty'?"

If the answer is the second — you're shipping slop. Don't.

### Context hygiene (no rot)

Stale text is slop that compounds — every future session pays tokens to read it, for nothing. Two rules:

- **Completed work scrubs its own scaffolding.** When a ticket / ADR ships, delete its now-stale forward-references from md files: `⏳ pending`, `until X ships`, `(future) HEY-NN`, "this is coming". Flip to past-tense or remove. A future session must NEVER read "X is pending" for work that is already done — that is pure context rot. This is part of Definition-of-Done, backed by a `stale-ref` CI check (flags md pointers to closed tickets / shipped "(future)" ADRs).
- **No unnecessary comments in code.** A comment earns its place ONLY when it explains WHY something non-obvious is done. Comments restating WHAT the code does, commented-out blocks, and `TODO` landmines are deleted on sight (see the slop table above).

---

## 6. Architecture-First Thinking (services, ownership, state — get it right before code)

**The rule:** Before writing code, every session decides the system shape: **what services exist, what each one OWNS, and WHERE state lives.** Getting the architecture wrong is the cardinal sin — it is the most expensive thing to reverse and the hardest to catch in a diff.

### Mandatory before building any feature

1. **Name the services it touches** and what each owns. (DO owns agent memory + scheduling; Supabase owns health data + auth; R2 owns cold archive — per ADR-0002 / ADR-0052.)
2. **Locate the state.** Which store is the system-of-record for this data? One writer, one truth — never duplicate authority. Raw health values live in Supabase, never in DO SQLite or R2.
3. **Draw the boundary it crosses.** Through an adapter/port, or reaching into a provider directly? Core logic never references a provider directly.
4. **Check it against the locked ADRs** for that area before coding. If the feature implies a new service, a new state location, or a new ownership boundary — that is an ADR, not a commit. Stop and write it.

### Hard NEVER

- Never put state in two places with two writers.
- Never invent a new service / boundary without an ADR.
- Never let a feature blur which store owns which data.
- Never reach past an adapter into a provider because it's faster right now.

### When to invoke

Any new feature · any "where should this live?" moment · any change that adds a table, queue, cache, or cross-service call. Invoke `/grill-with-docs` to verify the shape against its grounding ADRs.

---

## How these 6 disciplines compose

```
Problem-first      →  WHAT is the problem?  (scoped before code; root cause before fix)
Product-first      →  WHY does it matter to the user?   (JTBD named?)
First-principles   →  WHY this approach + not another?  (sources verified?)
Architecture-first →  WHERE does it live?   (services, ownership, state right?)
Test-heavy         →  HOW do we prove it works?         (E2E pass? AI code reviewed?)
NO AI SLOP         →  Does every line earn its place?   (tight + justified?)
```

Skip any one → you ship slop. Skip multiple → you ship broken slop.

Read this file FIRST in any session. Every other rule file builds on this.

---

## Anti-patterns we explicitly reject

- **"Move fast and break things"** — sometimes useful at scale, never useful for health data
- **"Ship now, fix later"** — only valid for cosmetic bugs, never logic bugs
- **"This is just a quick fix"** — if it's quick, it's likely a patch, not a fix
- **"It works on my machine"** — irrelevant; we test in the deployment target
- **"That's how everyone does it"** — first-principles or it didn't happen
- **"We can refactor later"** — later never comes; correct shape now
- **"Tests slow us down"** — tests are what let you ship fast without fear

---

## Citing this rule

When you encounter pushback on adopting one of these disciplines:

> "Per `waldo-brain/.claude/rules/mental-model.md`, this is non-negotiable. Either reframe to satisfy the discipline or push back with `needs-info`."

The discipline > the deadline.
