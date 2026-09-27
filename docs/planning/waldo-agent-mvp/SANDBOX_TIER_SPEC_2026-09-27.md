# Waldo Sandbox Tier - S1/S2 Spec (owner verification draft)

Status: DRAFT for owner architecture verification. No code in this PR. Build only after owner sign-off.
Origin: owner request 2026-09-27 ("research and write the specs for S1 and S2"), following the Grok Bot / Meta Muse VM analysis the same morning. References: docs.x.ai/grok-bot/*, about.fb.com Muse announcement, the-decoder Singleton interview (2026-09-25), ngram.com agent-architecture teardown (2026-09-21).

## The gap this closes

Waldo has no execution plane: no shell, no model-writable filesystem, no install/compile, no persistent owner computer. Grok Bot ships a per-user Firecracker microVM (browser + terminal + files); Muse ships a per-user Ubuntu VM with an unrestricted "Runtime Cell" watched by an external "Sentinel." Waldo already owns the parts they built VMs around: per-owner Durable Object isolation, provenance/taint/canaries, fail-closed admission, egress guard, delivery gate, owner-confirmed approvals, execution receipts. This spec adds the missing plane without weakening any of them.

## Invariants (never violated at any stage)

1. Sandbox output enters model context ONLY through the existing source-sanitisation/taint path, stamped external-origin. The cell is untrusted by construction (assume the model inside it is compromised; the system must still not leak or act).
2. Credentials never enter the cell. OAuth tokens, vault items, provider keys live worker-side; the cell sees capability handles at most. (Matches Muse's credentials-outside-the-cell and our vault posture.)
3. Egress and delivery authorization live OUTSIDE the cell: egress-guard and delivery-gate remain worker-side, our Sentinel-equivalent.
4. Every execution is receipted (execution-writer pattern): command digest, exit, bytes, duration, trace id. No receipt, no claim.
5. Consequential actions (spend, send, publish, delete) stay owner-confirmed regardless of stage. Sandboxing changes WHERE work runs, never WHO authorizes effects.
6. Owner isolation unit stays the owner DO: one sandbox per owner DO, never shared, destroyed/quiesced on inactivity.

## S1 - Read-only exec sandbox (eval + probe grade)

Goal: a disposable compute cell for verification work - run tests, compile, lint, analyze artifacts - with NO network egress and NO persistence beyond the run.

- Platform: Cloudflare Sandbox SDK (containers) bound to the owner DO. Base image: minimal Linux toolchain (node, python, build tools). Documented image digest pinned in the repo.
- Interface: one typed tool `sandbox_exec` (command, timeout, cwd) exposed to the run loop only inside probe/eval turns, permission-ceilinged in TOOL_PERMISSIONS like every other tool. No shell tool in owner chat turns at S1.
- Network: none. No egress at the container level (not policy - wiring).
- Filesystem: ephemeral per exec session. Inputs arrive as explicit byte mounts (repo snapshot, artifact from R2); outputs return as bytes to the worker, never auto-imported to context.
- Limits: wall-clock cap per exec, output byte cap, concurrency 1 per owner. Quotas receipted.
- Coverage use: F2 planning probe evals, F3 phase-analytics harness, regression repro of owner-reported bugs, CI-parity checks before Mac-lane deploys.
- Acceptance: a probe turn can run the waldo test suite subset inside the cell with a full receipt trail; nothing from the cell enters context unsanitised; no network path exists (verified by an in-cell egress probe failing).

## S2 - Artifact-producing sandbox (writes through the gate)

Goal: the cell may PRODUCE durable artifacts - built files, renders, reports - that land in the owner's R2 artifact store through the existing artifact pipeline.

- Adds: a single write path - cell output directory harvested by the worker at exec end, each file passed through the artifact admission checks (type, size, provenance stamp) before landing in R2. The cell never talks to R2 directly.
- Network: still none by default. A per-run allowlist (explicit domains, owner-confirmed per template) may be introduced behind the egress-guard only after S1 operates clean; default stays closed.
- Persistence: named workdirs may persist across execs (TTL-bound, quota'd, listed in the console so the state is visible, matching Muse's transparency stance).
- Console surface: sandbox sessions and produced artifacts appear in the dashboard (fits the B9 JSON API: /console/runs already exists; sandbox sessions become a run kind).
- Acceptance: a build-inside-cell flow produces an artifact visible in the console with full provenance; a hostile-artifact case (oversized/wrong-type/unexpected path) is rejected at admission with a receipt.

## Explicitly NOT in S1/S2

- No owner-facing shell chat tool, no autonomous package installs from the open network, no credential access, no browser inside the cell (browser stays the existing cloud-browser lane), no S3 (full computer tier with consequential egress) - S3 needs its own spec after S2 operates clean.

## Cost and complexity (rough)

- Platform: Cloudflare containers bill per active session CPU/memory; S1 cells live minutes per eval, S2 adds TTL'd workdirs. Expected cost is small next to model spend; exact numbers need a Sandbox SDK pricing check at build time (flagged, not guessed).
- Complexity: the new surface is the exec/receipt plumbing, image pinning, and the taint integration. The policy boundary already exists. Estimate: S1 is a multi-PR slice (tool + binding + receipts + tests), S2 similar. No supabase migrations expected for S1; S2 adds console listing reads only.

## Verification plan (per slice, per the standing discipline)

Issue + branch + PR per slice into beta-mvp, exact-head CI green, adversarial pass, receipt-backed claims; the S1 acceptance egress probe runs IN CI as a failing-if-open test.
