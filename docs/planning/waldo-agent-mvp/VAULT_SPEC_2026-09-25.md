# Waldo Vault spec (2026-09-25)

The Waldo Vault product slice: the owner's credential vault, used fill-only. Owner-confirmed
near-term, ahead of dashboard v2.1 (PROGRAM_STATUS_2026-09-25).

## Custody invariants (standing owner law, restated so this slice can't drift)

1. No secret value ever reaches the model, the DO, the Worker log path, or this lane's
   transcript. The model handles references and intent, never values.
2. Secret-bearing material travels only through structured channels: Supabase Vault, the typed
   connector proxy, the button channel for signed URLs. Never model-visible text, never chat.
3. The owner enters keys himself (the Resend pattern): collection UX writes to Vault directly,
   the agent never relays a value.

## The pattern, and the Notte-vs-build call

Notte (docs.notte.cc, checked 2026-09-25) runs the pattern we want: the LLM emits dummy
credentials, and the vault layer swaps in real values at execution, so the model never sees
them. It works, but it is a managed third-party vault: owner credentials would live in Notte's
cloud and the browser session would be Notte's. That fails invariant 1's custody half and our
ADR-0075 line (Supabase Vault + typed connector proxy is the one credential boundary).

**Recommendation: build, adopting Notte's proven fill-only shape on our own custody.** The
mechanism is small: a fill broker at the browser-execution boundary that resolves placeholder
refs against Supabase Vault at fill time. Notte's value to us is the existence proof and the
vocabulary, not the dependency.

## Design

- **Storage.** Secrets live in Supabase Vault next to the connector credentials, keyed by
  owner, with a label, the origin(s) it may fill on, and an audit trail of fills (when, which
  origin, which ref - never the value).
- **Fill broker.** The browser execution layer (BROWSER_TOOL_SPEC) gets one new step: when the
  model's action carries a credential placeholder (`{{vault:github/login}}` style ref, never a
  value), the broker resolves the ref against Vault, checks the page origin against the ref's
  allowed origins, fills the field, and records the fill. The model's view of the page and its
  own action log contain the placeholder, not the value.
- **Model contract.** Tools that touch login/payment surfaces take refs, not strings. The
  system prompt teaches: ask for a vault ref, never for the secret. A tool arg that looks like a
  raw secret where a ref belongs is a scribe-visible anomaly, not a convenience.
- **Owner UX.** Add/edit/revoke in the console; the owner types values straight into a Vault
  write path. No agent relay, no chat paste.

## Key-to-sandbox channel (rung-2 unlock)

Today the sandbox lane can build and push (rung 1) but every deploy waits for the owner's Mac.
Rung 2 is the sandbox doing deploy-class work itself, unlocked by the owner handing a key
through the vault instead of chat:

- The owner stores a scoped, revocable deploy credential (e.g. a Cloudflare API token limited
  to the staging worker) in Vault with an allowed-use label.
- The lane's deploy job requests the ref through the broker; the value lands in the job's
  environment for that run only. The lane never prints it; logs carry the ref and the fill
  receipt.
- Revocation is one console action and kills future runs without rotating anything else.

This keeps invariant 1 intact (no value in transcripts) while removing the Mac bottleneck for
staging deploys. Production deploys stay owner-run until a separate accepted ADR says otherwise.

## MVP scope

- Vault schema + RLS + the fill broker at the browser boundary, with fill audit.
- Console CRUD for the owner.
- One browser flow exercised end to end with a real login in staging (L4-style, owner-watched).

Non-goals for the MVP: sharing, org vaults, autofill outside agent-driven browser sessions,
model-readable secrets of any kind, and any value path through chat.

## Build order

- V1: Vault schema + RLS + console CRUD + audit table.
- V2: fill broker + browser placeholder resolution + the one-login staging proof.
- V3: key-to-sandbox channel (rung 2) once V2's broker is proven on a low-stakes credential.
