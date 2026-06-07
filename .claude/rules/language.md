<!-- MIRRORED FROM waldo-brain/.claude/rules/language.md @ e09f89f49985 -->
<!-- Do not edit locally. Edit canonical in waldo-brain, then resync. -->
<!-- Sync ritual: see waldo-brain/.claude/rules/MIRROR-SYNC.md -->

# Architecture Language

> **Canonical source:** `waldo-brain/.claude/rules/language.md` @ `e09f89f49985`. This file is a verbatim mirror per [[0063-canonical-rule-files-mirroring|ADR-0063]]. Edits land canonical-first; do not edit locally.

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

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, mockable, swappable parts — they just aren't part of the interface. A module can have **internal seams** (private to its implementation, used by its own tests) as well as the **external seam** at its interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, the module wasn't hiding anything (it was a pass-through). If complexity reappears across N callers, the module was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it.

## Relationships

- A **Module** has exactly one **Interface** (the surface it presents to callers and tests).
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.

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
