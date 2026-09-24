# Machine context layer: minimi parity-and-beyond build plan (2026-09-24)

Owner ask (WhatsApp 7:06 PM): build the entire memory layer, observation layer, and work-and-life layer on par with minimi or better - combining the full infer pipeline, the personal-agent side, and Kennel's existing capabilities - so Waldo becomes properly personal without unnecessary connectors. All 9 bridge decisions from the unified doc are LOCKED (he agreed to every recommendation). This plan bakes them in from slice one. AppleScript automation is a LATER layer on top of governed actions - named here, not scoped.

## 1. Capture matrix: minimi's minimum vs Waldo+Kennel

| Signal | minimi | Waldo+Kennel | Verdict |
|---|---|---|---|
| App/window focus + UI text | AX infrastructure, no screenshots | AX-tree-first, pixels on demand (ScreenCaptureKit only when a visual check is needed) | PARITY, cheaper and more exact (structured ~100ms reads, no vision model) |
| What you hear/say (mic/audio STT) | Yes (their claim) | DEFERRED - see below | DELIBERATE GAP |
| Work activity context | Inferred from pixels | Ground truth: workspacewatch filesystem signal, mission state (failing tests, uncommitted worktrees, running tasks) | EXCEEDS - minimi guesses at repo state; Kennel knows it |
| Agent sessions (Claude/Codex) | Not captured | Kennel IS the harness: tasks, prompts, results, costs | EXCEEDS - unique to us |
| Calendar/email context | Watched through app pixels | Structured Google connector data (shipped) | EXCEEDS - API truth vs screen inference |
| Chat context | Watched through app pixels | Native Telegram/WhatsApp channels (shipped) | EXCEEDS - the conversation itself, not its rendering |
| Memory model | Opaque embeddings, vector search | Typed claims with provenance (stated/confirmed/inferred/machine), correctable, forgettable, spots+constellations explorer | EXCEEDS - travels with its reasons |
| Loop closing | Tracks/nudges | Acts: reminders, calendar, mail, delegated machine jobs | EXCEEDS |

Audio: minimi's only capture class we deliberately skip at beta. Mic/STT is the highest consent cost, highest battery cost, and lowest incremental value given channels + connectors already cover comms. Owner-overridable later; not built now.

Answer to his direct question: yes - everything minimi minimally captures about daily device usage, we capture; and the Waldo agent layer (memory with provenance, open loops, actuation, channels) sits on top of it, which minimi does not have.

## 2. Slice plan (each bounded, gated, exit-criteria'd; KENNEL = Waldo-Kennel repo, BACKEND = waldo-backend)

### Phase A - capture foundation
- **S1 [KENNEL]** TCC consent UX + AX collector. Per-class opt-in (Accessibility, Screen Recording), app allow/deny list, sensitive-app exclusion policy, visible island indicator, local policy store. Exit: owner enables per class in the app; focus + UI-text episodes land in local SQLite; indicator visible whenever capture is on; excluded apps provably unread.
- **S2 [KENNEL]** Episode store + CDC sync sender. Typed episodes (focus, work-session boundaries, artifact refs), retention caps, idempotent push-with-ack over the change_log rail, offline spool. Exit: episodes survive Mac sleep and drain on wake with no duplicates.
- **S3 [BACKEND]** Device episode ingest + scope enforcement + `machine` claim source. The ingest route drops anything outside the owner's stored capture scopes (adversarial test: misbehaving client sending out-of-scope data is dropped and logged). Contracts ripple for the fourth claim source lands in the same commit (pinned tests updated deliberately). Exit: machine claims visible as their own facet in the memory explorer.

### Phase B - context engineering
- **S4 [BACKEND]** Machine-episode distillation. Episodes -> claims/spots/constellations through the existing pipeline; dedupe against connector/channel evidence (a calendar event and a screen-watched meeting are ONE fact, connector evidence wins); work-session boundaries become time-structured context. Exit: a real day of the owner's Mac use produces correct, non-duplicated claims; explorer shows work sessions.
- **S5 [KENNEL]** Machine loop candidates + closure evidence. Uncommitted work, failing tests left running, idle long-lived tasks - idempotency-keyed candidates, closure evidence on resolution. Exit: seeded candidate becomes a Waldo loop and closes on ground-truth evidence.
- **S6 [BACKEND]** Loop registry accepts device candidates; proactivity settings gate surfacing. Exit: a machine loop appears in the brief per settings, quiet hours respected.

### Phase C - work-and-life layer
- **S7 [BACKEND]** Context-composer integration. Machine context enters briefs and prompts only where relevant ("you left the auth slice uncommitted"), never as raw episode dumps. Exit: brief contains machine-derived lines when relevant and provably excludes them when not.
- **S8 [KENNEL + BACKEND]** Governed machine actions (bridge K6/B5): machine_state_query, notify_local, path-scoped file ops, mission_task - each class owner-delegated, custody-fenced, no raw shell. Exit: "is my build done" and "have Codex finish the slice" round trips from WhatsApp, audited.

### Later (named, not scoped)
- **AppleScript automation layer**: once K6 governed actions exist, AppleScript becomes another governed job class (drive any scriptable app). Same consent + fencing machinery; new policy surface. Builds on S8, does not change it.
- **Audio capture**: per section 1.
- **Memory-MCP public surface**: Kennel is already the first consumer of the memory read API; external LLMs follow the same contract later.

## 3. Consent, custody, standards - locked in from slice one

Locked owner decisions applied: capture off-until-enabled per class; Waldo propose-only for effects, auto for reads; raw episodes never leave the Mac (derived typed episodes only); `machine` as a distinct claim source; single Mac at beta, multi-device design.

- macOS TCC is the consent backbone: two separate grants (Accessibility, Screen Recording), user-flipped in System Settings, no programmatic grant, runtime AXIsProcessTrusted checks, visible indicator. We add per-class and per-app policy ON TOP of the OS grants.
- Local-first: episodes live in Kennel's SQLite with retention caps; sync ships derived context, never raw streams or recordings.
- Backend enforcement: capture scopes checked at ingest; forget barriers cover machine claims; scoped deletion and account deletion cover device rows + machine episodes (adversarial deleted-means-deleted probe extends).
- Custody hard line unchanged: device keypair signing, no bearer tokens outside their stores, connector tokens remain Vault + connector-proxy only.
- Data minimization as design rule: every captured class must justify its consent cost; AX-text preferred over pixels; pixels on demand only.

## 4. What this makes true

Waldo knows what you're doing (channels + connectors + machine), remembers it with provenance (claims/spots/constellations), holds the loops (loopBook + machine candidates), and acts (actuation + delegated machine jobs). minimi validates the demand for the capture half; the agent half is ours alone. No unnecessary connectors: the machine itself becomes the richest source.
