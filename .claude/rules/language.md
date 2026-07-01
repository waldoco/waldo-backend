<!-- MIRRORED FROM waldo-brain/.claude/rules/language.md @ 556a459a761d -->
<!-- Do not edit locally. Edit canonical in waldo-brain, then resync. -->
<!-- Sync ritual: see waldo-brain/.claude/rules/MIRROR-SYNC.md -->

# Architecture Language

> **Canonical source:** `waldo-brain/.claude/rules/language.md`.
> Mirrored verbatim into `waldo-types/.claude/rules/language.md`, `waldo-backend/.claude/rules/language.md`, and `waldo-app/.claude/rules/language.md` once those PRs land. Edit canonical only; remirror downstream.

> RFC2119 keywords (**MUST**, **SHOULD**, **MAY**, etc.) apply per [`posture.md`](posture.md).

Shared vocabulary for every architectural discussion in Waldo. Use these terms exactly — don't substitute "component," "service," "API," or "boundary." Consistent language is the whole point.

Adopted from Matt Pocock's `improve-codebase-architecture` skill (https://github.com/mattpocock/skills/tree/main/skills/engineering/improve-codebase-architecture).

## Terms

**Module**
Anything with an interface and an implementation. Deliberately scale-agnostic — applies equally to a function, class, package, or tier-spanning slice.
_Avoid_: unit, component, service.

**Interface**
Everything a caller must know to use the module correctly. Includes the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics.
_Avoid_: API, signature (too narrow — those refer only to the type-level surface).

**Contract**
An interface that another repo, persisted record, external caller, agent tool, workflow, or user-visible flow depends on. Contracts include TypeScript exports, Zod schemas, API responses, event payloads, database shapes, tool inputs/outputs, env vars, queue messages, and file formats. A contract is not "internal" merely because it lives in a private package.

**Implementation**
What's inside a module — its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth**
Leverage at the interface — the amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface. A module is **shallow** when the interface is nearly as complex as the implementation.

**Seam** _(from Michael Feathers)_
A place where you can alter behaviour without editing in that place. The *location* at which a module's interface lives. Choosing where to put the seam is its own design decision, distinct from what goes behind it.
_Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter**
A concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside).

**Leverage**
What callers get from depth. More capability per unit of interface they have to learn. One implementation pays back across N call sites and M tests.

**Locality**
What maintainers get from depth. Change, bugs, knowledge, and verification concentrate at one place rather than spreading across callers. Fix once, fixed everywhere.

**Capability Manifest**
A generated, source-pinned inventory of a repo's public surfaces: exports, schemas, endpoints, tools, adapters, screens, storage keys, permissions, env vars, ADR links, and validation commands. Agents read the manifest before reading implementation so they orient from contracts outward.

**Impact Surface**
The set of downstream things a change can affect: contracts, persisted data, migrations, agent tools, privacy/security boundaries, user flows, tests, docs, and sibling repos. Every meaningful PR names its impact surface.

**Contract Drift**
A change where the implemented contract no longer matches the expected contract: removed field, renamed field, type change, changed default, missing validation, altered error shape, or changed side effect. Contract drift is a break until the migration and downstream validation prove otherwise.

**Conformance Rule**
A deterministic check derived from a markdown rule, ADR, security invariant, or repo contract. Conformance rules emit structured findings instead of relying on reviewer memory.

**Disposition**
The status of a conformance finding: `block`, `warn`, or `suppressed`. Suppression requires a local justification and should be counted separately; there is no silent `off`.

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, mockable, swappable parts — they just aren't part of the interface. A module can have **internal seams** (private to its implementation, used by its own tests) as well as the **external seam** at its interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, the module wasn't hiding anything (it was a pass-through). If complexity reappears across N callers, the module was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it.
- **Contracts are deeper than types.** A caller depends on behavior, invariants, error modes, persistence shape, and operational constraints, not just a static signature.
- **Manifests are orientation, not authority.** If the manifest and source disagree, source wins for immediate debugging, but the manifest is stale and must be regenerated before merge.

## Relationships

- A **Module** has exactly one **Interface** (the surface it presents to callers and tests).
- A **Contract** is an **Interface** with downstream dependency or persistence weight.
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.
- A **Capability Manifest** lists current **Contracts** and validation commands.
- **Conformance Rules** check whether implementation, tests, and process still satisfy the contract.
- **Disposition** tells the merge system whether a finding blocks, warns, or is locally suppressed.

## Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods**: too narrow — interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD's bounded context. Say **seam** or **interface**.

## Waldo applications of these terms

- **10 Adapters** (HealthDataSource, LLMProvider, ChannelAdapter, etc.) sit at **seams** between Waldo's core logic and external systems. Each has an **interface** in `src/adapters/<name>.ts` and one or more **implementations**.
- **DO SQLite memory layer** is a **deep module** — small interface (`memory.add`, `memory.retrieve`, `memory.recall`) hides Scribe inbox-merge, hall typing, FTS5, CARA confidence, ACT-R forgetting.
- **CRS engine** is a **deep module** — `computeCRS(snapshot) → CrsResult` hides SAFTE-FAST weights, time-of-day normalization, HRV method coercion, pillar drag.
- **CF AI Gateway** is a **seam** between Waldo agent and LLM providers. Gemma 4 / Sonnet 4.6 / Haiku are **adapters** at that seam.
- **The 7-layer REASONS prompt builder** is a **deep module** with internal seams (one per REASONS letter) used by its own tests, but a single external interface (`buildPrompt(triggerType, context) → string`).
- **`@pin4sf/waldo-types` exports** are **contracts** across backend, app, and brain. Any drift requires impact analysis and downstream validation.
- **Agent tool schemas** are **contracts** between LLM plans and executable code. Zod `valid + invalid` tests are conformance rules for those contracts.
