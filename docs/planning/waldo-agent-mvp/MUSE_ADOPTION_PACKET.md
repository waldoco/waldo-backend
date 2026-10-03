# Muse-study adoption packet

Adoption plan for the generic workflow patterns identified in the Muse/Hatch
skills + workflow studies. Provenance constraint: the source material is an
unofficial third-party snapshot of unverified attribution; every pattern here
is reimplemented from our own design. No content was copied.

Each slice below has its own tracking issue. Sequencing and dependencies are
in section 10. Slice numbering here matches the issue set, not priority.

## S1. Forget-coverage audit + retraction semantics

Gap: barrier/forget exists, but coverage across ALL stores is unverified:
episodes, claims, constellation edges, trace book, console surfaces, and
analytics sinks (Langfuse project history). A forget that misses a derived or
indexed copy is silently incomplete.

Adopt: forget as a cross-store workflow, not an edit. Stop automations before
removing their outputs; stage claim IDs + locators (never content) for
retraction; wait for the search-index refresh before reporting; claim
"forgotten" only after fresh-state verification finds nothing active; name
out-of-reach categories (outside services, backups, shared copies) honestly
instead of claiming erasure.

Changes: coverage test that forgets a synthetic topic and asserts absence
across every store; retraction staging in the memory path; refresh-wait +
fresh-verify in the forget flow; honest incomplete-reporting terminal state.
Providers: none.

## S2. Claim-after-fresh-verification doctrine

Gap: our evidence bar governs code shipping, but runtime user-facing claims
("saved", "forgotten", "sent", "booked") are not uniformly verified against
fresh state before being claimed.

Adopt: no completion claim without fresh-state verification at the claiming
layer; report coverage counts (success/total) and unresolved gaps on any
fan-out; "incomplete" is a terminal state distinct from success and failure;
detached/background work puts unresolved blockers in the final message instead
of asking into the void.

Changes: doctrine section in the owner-turn guidance + a harness lint that
flags claim-shaped replies without a preceding verification tool call in the
same turn (heuristic, advisory). Providers: none.

## S3. Progressive-disclosure skill format (folds into #179)

Gap: skills/guidance are embedded in prompts and contracts; capability growth
costs context-window budget; #179 (procedure-to-skill distillation) has no
target format.

Adopt: file-based skills with YAML frontmatter (name, description,
includeInPrompt). Only frontmatter is always loaded; bodies load on trigger;
bulk lives in references/; helper binaries over prompt-side protocol;
authoring discipline: one clear job per skill, operational core only in the
main file, compile-check helpers before reporting success, connector auth
sections machine-generated from the credential broker.

Changes: skill surface directory + loader; frontmatter registry; #179 emits
this format; migration path for existing embedded guidance. Providers: none.

## S4. Manifest-driven permissions (Governor data layer)

Gap: permissions live in code. There is no declarative per-method table of
allow/ask defaults, required OAuth scopes, response-guard classes, or
per-method provider cost units.

Adopt: a permission manifest per tool/connector: per-method default
(allow/ask), approval phrase for sensitive methods, required scopes,
response-guard class (e.g. verification-code protection on reads), per-method
cost units matched against the provider's published per-user quota, enforced
per worker class. The Governor reads the manifest; audits read data, not code.

Changes: manifest schema + loader; Governor enforcement reads manifests;
per-method cost accounting against provider quotas. Providers: none new;
consumes existing provider quota documentation (e.g. Gmail API unit costs).

## S5. Environment-scoped skill/tool reveal

Gap: the same tool surface is visible in every environment. Canary, prod, and
eval contexts should see different capability sets, fail-closed on unknown
channel.

Adopt: a generated scope map (single source-of-truth manifest -> derived
reveal config); the runtime reveals only the tools/skills whose scope matches
the active environment; unknown environment reveals nothing.

Changes: scope manifest + build-time generator + runtime reveal filter.
Providers: none.

## S6. Goals with progress + briefings

Gap: loops open and close, but there is no goal hierarchy (goal -> subgoals),
no progress tracking, and no scheduled progress briefings.

Adopt: goal records with subgoals, progress entries, user-stated check-in
preferences honored, timeframe end handling (done vs extend), and completion
reflection. Delegation-surviving instructions ("finish planning first") attach
to the goal so bounded sub-work inherits them.

Changes: loops table extension (parent_goal, progress, briefing_at,
instruction scope), scheduler arm for briefings, console section.
Providers: none.

## S7. Artifacts MVP (document/PDF deliverables)

Gap: waldo has no deliverable-rendering path. Documents, PDFs, and decks are
the most felt capability gap versus peers.

Adopt: a renderer + storage + channel delivery pipeline. MVP scope: markdown
-> styled HTML document artifact; PDF export; delivery via Telegram
sendDocument + console. Artifacts are owner-data-bearing: sanitise-on-render,
no external-origin text executed as instructions inside generated content.

Changes: render worker, R2 storage, telegram/console delivery, receipt
entries for artifact creation. Providers: Cloudflare Browser Rendering
(candidate, fits the Workers stack; UNVERIFIED until checked live) or a
pinned Chromium container; R2 (already on Cloudflare).

## S8. TTS (voice out)

Gap: STT exists; voice output does not.

Adopt: TTS for replies the owner would rather hear; audio delivery on
telegram/WhatsApp; voice selection kept in owner settings.

Changes: TTS provider integration behind a small interface, audio delivery
path, settings entry. Providers: smallest.ai (already integrated for STT;
their TTS product is the natural candidate - UNVERIFIED until the current
API surface is checked); fallback candidates to be surveyed at slice start.

## S9. Connector breadth via MCP

Gap: Google calendar/mail only. The studied connector surface (email,
calendar, social, health, finance, smart home, booking) shows the target;
hand-building 30 connectors is not the path.

Adopt: config-driven MCP connectors (existing audit slice E4) as the generic
path; per-connector manifests from S4 apply to MCP-exposed methods; each
connector ships with an eval scenario before it is marked live.

Changes: MCP registry hardening, manifest schema application, per-connector
eval gate. Providers: per-connector MCP servers, chosen at adoption time;
each new connector requires its own auth + quota review before enabling.

## 10. Sequencing into the current build line

Order respects the merge-held stack (no slice starts code until its
dependencies merge) and cheapest-trust-first:

1. S1 forget-coverage audit - test-first, no schema changes, independent of
   the held stack; can start immediately on a fresh branch.
2. S2 doctrine + advisory lint - docs + one lint rule; independent.
3. S3 skill format - blocks #179 implementation; design only until the
   current stack merges, to avoid prompt-layer conflicts with #180.
4. S4 manifest permissions - depends on S3's registry shape; also the data
   layer S5 reads.
5. S5 env-scoped reveal - depends on S4 manifests.
6. S6 goals-with-progress - schema migration; sequence after the held
   migration-bearing PRs land and the owner orders migrations.
7. S7 artifacts MVP - depends on nothing held; renderer provider check first.
8. S8 TTS - provider check first; independent.
9. S9 MCP breadth - continuous; per-connector eval gate is the admission
   control.

Held-stack boundary: none of S1-S9 touches the files in the merge-held PRs
except S3/S4 (prompt/registry layer), which is why those two stay design-only
until the stack lands.
