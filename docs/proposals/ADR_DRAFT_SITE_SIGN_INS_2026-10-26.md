# ADR draft: Waldo holds website sign-ins and fills them at the browser layer (26 October 2026)

These are drafts for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. They also include the launch
contract amendment and the registry entry. The design they record is
[`SITE_SIGN_INS_2026-10-26.md`](SITE_SIGN_INS_2026-10-26.md).

The owner decided on 26 October 2026 to "build our own password store" and accepted the custody risk. Six choices inside
the design are still open for the owner (D1 to D6 in the design note). These drafts land in `waldo-brain` through its
own review. Nothing here changes an accepted ADR by itself, and nothing has been pushed to Brain.

---

## New ADR 00NN: Waldo holds website sign-ins under a Worker key and fills them only at the browser layer, on an exact origin

The number is the next free slot when Brain reviews it. ADR-0085 is taken by the forget-barrier draft, and other drafts
use `00NN`.

```markdown
---
status: proposed
date: 2026-10-26
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/00NN-waldo-held-site-sign-ins.md
related: [0024-scribe-sanitiser-canonical-spec, 0052-do-only-runtime-l1-invoke-agent-removed, 0055-gdpr-deletion-runbook-all-stores]
supersedes_rule: "Waldo never stores a password value" (owner ruling 26 Oct 2026)
---

# Waldo holds website sign-ins under a Worker key and fills them only at the browser layer, on an exact origin

Errands stop at login walls. Today the owner must take over a live view every time. 1Password's agent integration needs
a Business account and a browser extension, and Cloudflare's browser cannot load the extension. The owner decided Waldo
keeps its own sign-ins and accepted that a breach of the store means account takeover on the stored sites.

**Decision: a sign-in is one Supabase row plus one Vault secret, and the secret holds a ciphertext the database cannot
open. The model sees that a sign-in exists for the page it is on, never the value. The harness signs in as one host
operation over CDP, only on an exact origin match, only under a fresh approval or an unexpired per-site grant that the
database rechecks at release. Every outbound sink fails closed on the value.**

## Rules

1. **Write-only value.** The console can add a password or replace it, and nothing else. No route, tool, export, log,
   receipt or DTO carries the value back. Its schema has no field that could.
2. **Envelope under a Worker key.**
   - The Worker encrypts with AES-256-GCM under `WALDO_SIGN_IN_KEY`, a Worker secret.
   - The authenticated data is `owner | sign-in id | origin | username | generation`, and the envelope carries a key id
     for rotation.
   - Supabase Vault stores the envelope. No function the Worker can call returns plaintext, which keeps the rule of
     `20260924180000_waldo_connector_proxy.sql`. The plaintext exists only in Worker memory, from release until the end
     of the browser session.
3. **Exact origin.** Equality of `URL.origin` (https, no userinfo) is required between three things: the stored
   origin, the top-level page, and the frame holding the field. It is read over CDP at release and again after the
   insert. There is no subdomain, `www` or registrable-domain folding. The top frame only. GET forms and forms whose
   `action` is cross-origin are refused.
4. **One atomic host operation.** The model names a sign-in id. The harness picks the password field, fills the
   username and the password with raw CDP `Input.insertText`, submits, and waits. No observation is published between
   the insert and the navigation. Only the Cloudflare CDP engine may sign in. Vendor agents and the Stagehand fallback
   never receive a sign-in.
5. **Authority.**
   - The first use on a site needs a `sign_in_use` approval: single use, bound to sign-in, origin and browser session,
     for 10 minutes.
   - The owner may grant "allow on this site". The grant is step-up gated, time-scoped (90 days, renewable) and
     revocable.
   - `sign_in_release` rechecks ownership, origin and the grant in the same statement that returns the envelope, and it
     logs the release.
   - A standing grant authorises the fill only, never what the errand does once signed in. Consequential steps keep
     their own cards.
6. **Fail closed on the value.** After a fill, the filled nodes stay masked by `backendNodeId` for the session,
   whatever their type becomes. The exact value, raw and percent-encoded, is scanned at every sink:
   - observation;
   - checkpoint;
   - tool-output ledger;
   - tool result;
   - error;
   - OTLP export;
   - R2 write.

   It is also registered as an ephemeral canary in the model-request sanitiser. A hit withholds the whole observation,
   image included.
7. **Bounded release.** There are daily release caps per owner and across the server, with committed defaults.
   Reaching one hands off to the owner and does not fail silently.
8. **Deletion.** Deleting a sign-in deletes its Vault secret in the same transaction. Account deletion deletes every
   one through a `before delete on waldo.owners` trigger.
   - A deleted sign-in leaves content-free use rows for 365 days.
   - Account deletion erases them.
   - Backed-up envelopes stop being decryptable when the Worker key rotates.
9. **Second factors stay with the owner.** One-time codes, passkeys, CAPTCHAs and cross-origin login frames hand off to
   the owner's live view. They are never stored.

## Considered options

- **Wait for 1Password.** Rejected by the owner: it needs a Business account and an extension Cloudflare's browser
  cannot load. It may return later as an optional source behind the same fill path.
- **Vault-only plaintext read by a service-role Edge Function.** Rejected: the Worker has to type the value, so the
  plaintext reaches the Worker either way. A database breach (Vault key included) would then expose every value, and a
  re-pointed origin column would redirect a password.
- **A Worker-callable SQL function that decrypts.** Rejected: it reverses the connector-proxy rule that no
  Worker-callable function returns plaintext, and gains nothing over the envelope.
- **The model types the value through `type`/`fill`.** Rejected: the value would enter the prompt, the tool args,
  Langfuse and history.
- **Detect leaks only after the fact (a scan without atomic sign-in or node masking).** Rejected: a type flip unmasks
  the screenshot, and an image cannot be text-scanned.
- **Persist browser cookies per site instead of passwords.** Kept for later. `browserStateCustody` exists unwired. It
  complements sign-ins, because cookies expire and passwords do not.

## Consequences

- Login walls on saved sites stop needing the owner. The first use on each site still asks.
- The Worker becomes a holder of every stored password. A Worker compromise exposes them all, bounded only by the
  release caps and visible in the use log. The owner accepted this on 26 Oct 2026.
- A new Worker secret and a new privacy-notice version are needed before any owner can save a sign-in.
- `approvalKindV1Schema` grows by one value, only at a new app contract revision.
```

---

## Launch contract amendment (draft for `01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md`)

Insert this under the browser and errands capability.

> **Saved website sign-ins.**
> - The owner may save website sign-ins in the console Vault.
> - Waldo's browser signs in with them only on the exact website saved, after the owner allows it once or for that
>   site, and Waldo is built so its models never receive the password.
> - Values are write-only, encrypted under a Worker key, and deleted with the sign-in or the account.
> - One-time codes, passkeys and embedded identity-provider frames hand off to the owner.
> - App parity, beyond the approval card at a later contract revision, is out of launch scope.
> - Payments are not part of this capability.

Strike the clause, wherever the contract or the Vault copy carries it, that Waldo never stores or sees passwords. Replace
it with: "stores them encrypted; no Waldo screen, export or reply shows them, and Waldo is built so its models never
receive them".

## ADR registry entry (draft for `accepted-adrs.json` after acceptance)

```json
{ "adr": "00NN", "title": "Waldo-held website sign-ins under a Worker key, filled at the browser layer on an exact origin", "status": "proposed", "file": "00NN-waldo-held-site-sign-ins.md" }
```

The repo's `docs/foundation/accepted-adrs.json` is regenerated from Brain only after the ADR is accepted there. It is
not edited by hand here.
