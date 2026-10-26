# ADR draft: Waldo holds website sign-ins and fills them at the browser layer (26 October 2026)

These are drafts for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. They also include the launch
contract amendment and the registry entry. The design they record is
[`SITE_SIGN_INS_2026-10-26.md`](SITE_SIGN_INS_2026-10-26.md).

The owner decided on 26 October 2026 to "build our own password store" and accepted the custody risk. Seven choices
inside the design are open for the owner (D1 to D7 in the design note); the gate accepted D1 on 26 Oct. These drafts
land in `waldo-brain` through its own review. Nothing here changes an accepted ADR by itself, and nothing has been pushed to Brain.

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
open. The model sees that a sign-in exists for the page it is on, never the value. The harness signs in as one fenced
host operation over CDP, only on an exact origin match. It needs a one-time approval that the database consumes, or a
per-site grant that the database rechecks, used only in an owner turn that read nothing from outside that site. The
plaintext lives in memory for at most 10 minutes, and every outbound sink fails closed on it.**

## Rules

1. **Write-only value.** The console can add a password or replace it, and nothing else. No route, tool, export, log,
   receipt or DTO carries the value back. Its schema has no field that could.
2. **Envelope under a Worker key.**
   - The Worker encrypts with AES-256-GCM under `WALDO_SIGN_IN_KEY`.
   - The authenticated data is `owner | sign-in id | origin | username | generation`, and the envelope carries a key id.
   - Supabase Vault stores the envelope. No function the runtime can call returns plaintext, which keeps the rule of
     `20260924180000_waldo_connector_proxy.sql`.
   - Only the envelope module reads the key, enforced by a conformance guard, and `env` is never serialised.
   - Key rotation is an out-of-band job, authorised by the owner per run, with its own short-lived HMAC and budget. It
     runs in the custodian or a run-only rotation Worker, never in the runtime Worker or on a workstation. It is never
     reachable from a turn, a console route or the model.
   - Whether the key and the fill live in the runtime Worker or a dedicated custodian Worker is decision D7.
3. **Exact origin, fenced.**
   - Equality of `URL.origin` (https, no userinfo) is required between the stored origin, the top-level page and the
     frame holding the field. There is no subdomain, `www` or registrable-domain folding. The top frame only.
   - From release until the submission request is dispatched, the route guard aborts every document request to
     another origin. After that, only the submission's own body-less redirect chain may leave the origin. Any other
     cross-origin document request stays aborted while a filled field holds the value.
   - Main-frame navigation events, including a back-forward cache restore, abort before an insert and end the session
     after one.
   - Before each insert and before submit, the harness checks over CDP:
     - the main frame's `frameId` and `loaderId` are unchanged;
     - origin equality still holds;
     - the form's `method` is not GET and its `action` is same-origin;
     - focus is on the resolved `backendNodeId`.
4. **One atomic host operation.** The model names a sign-in id. The harness picks the password field, inserts the
   username and password by `Runtime.callFunctionOn` on the resolved node's own object, so a document that is gone
   fails the write and a navigation with no network request cannot redirect it. It submits with the form's
   `requestSubmit()` and waits. No observation is published between release and navigation. Only the Cloudflare CDP
   engine may sign in.
5. **Authority.**
   - The first use on a site needs a `sign_in_use` card. Approving it writes a single-use row in Supabase, bound to
     sign-in, browser session and approval ref, valid for 10 minutes and requiring a live owner session. Release
     consumes it in the same transaction that returns the envelope.
   - The owner may grant "allow on this site": step-up gated, at most 90 days, revocable, rechecked by every release.
   - A grant counts only in an owner turn whose outside reads all came from the sign-in's exact origin. Inbound mail,
     proactive, scheduled and other machine turns, and turns tainted by any other source, always get a card.
   - Every release carries a signed, unique `request_id`, so a replayed call is refused.
   - A grant authorises the fill only, never what the errand does once signed in.
   - The database checks stop model-path bugs, replays and a router HMAC used without a live owner session. They do
     not stop a compromised runtime, which signs both the approval and the release.
6. **After a fill.**
   - Filled nodes stay masked by `backendNodeId` whatever their type becomes, and commands aimed at them are refused.
     No clipboard or drag command exists.
   - Chrome's autofill and password-manager save are off.
   - After submit settles, still-attached filled fields are cleared through a call that carries no argument. No
     screenshot leaves the host while a filled field holds a value.
   - The exact value, raw and percent-encoded, is scanned at every sink: observation, checkpoint, tool-output ledger and
     offload store, tool result, errors, OTLP export and R2 writes. It is also an ephemeral canary in the model-request
     sanitiser.
   - Page console messages are never captured, protocol debug logging stays off by guard, and the route guard never
     reads request bodies.
   - The plaintext is dropped when no filled field holds it any more, or 10 minutes after release, whichever is first.
     A session with a filled field still holding the value at 10 minutes is ended.
7. **Bounded release.** Every release purpose counts: fill, scan restore and rewrap each have a per-owner daily
   budget, under a per-owner total and a server total that are SQL ceilings. One owner can use at most 14% of the
   server's day. Reaching a cap hands off to the owner.
8. **Ledger and deletion.**
   - The approval card stores only the sign-in id and refs, and renders the label, origin and username by lookup. The
     observation's sign-in list is never persisted.
   - Deleting a sign-in deletes its Vault secret and approvals in the same transaction. It leaves content-free use
     rows for 365 days.
   - Account deletion erases everything through a `before delete on waldo.owners` trigger.
   - Backed-up envelopes stop being decryptable when the key rotates.
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
- **The key and fill in a dedicated custodian Worker.** Open as owner decision D7. It is recommended if a spike
  proves Browser Rendering can hand a session from the runtime to a second Worker and back. A runtime compromise then
  yields capped account use on the exact sites, not the passwords.
- **Persist browser cookies per site instead of passwords.** Kept for later. `browserStateCustody` exists unwired. It
  complements sign-ins, because cookies expire and passwords do not.

## Consequences

- Login walls on saved sites stop needing the owner. The first use on each site still asks.
- Under option A, any code-execution or supply-chain compromise of the runtime Worker exposes every stored password,
  bounded only by the release caps and visible in the use log. The owner accepted this custody risk on 26 Oct 2026.
  Under option B, the same compromise reaches capped account use on the exact sites. The custodian Worker then carries
  the full exposure.
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
