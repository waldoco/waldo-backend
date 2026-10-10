# Ownership: one writer for the backend and the app

Owner ruling, 10 October 2026. The owner and the owner's Claude Code sessions are the sole writer and merger for `waldo-backend` (all of `beta-mvp`) and `Pin4sf/waldo-app`. The earlier split between an agent-capability lane (Instinct), an app and health lane (Codex) and a browser lane (Dalda) is retired. Open PRs from those lanes are inputs to land, re-cut or close, not owned work in flight.

## Delegation

Instinct may take a delegated slice when all of these hold:
- The slice touches files no other in-flight slice touches.
- It has a written acceptance bar: tests to pass, a scenario to trace, and what must not change.
- It runs in its own worktree and branch.
- The owner's session reviews it before merge.

Good delegation candidates are self-contained connector depth (calendar list, all task lists, task writes, Gmail triage actions) and the weather and location tool.

Kennel's own repository stays Ashish's. The WhatsApp surface adapter is Ashish's; the backend keeps its surface-neutral seam so WhatsApp plugs in like any other surface.

## Rules that do not change with ownership

- One writer per aggregate and one in-flight critical-path slice at a time.
- Changes to the owner-turn input shape, the approval ledger, or the egress and taint rules keep the existing denial tests meaningful.
- Health: the agent sees the owner's readings end to end; egress, external-taint and trace denials stay. The hard gate before any outside user stays.
- Merges to `beta-mvp`, staging deploys, migrations on hosted databases, secrets, force-pushes and anything touching `main` or production are confirmed with the owner per action.

The delivery order and per-promise status live in the [website promise ledger](../../planning/WEBSITE_PROMISE_LEDGER_2026-10-10.md).
