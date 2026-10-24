# Proposed ADR: each owner's Waldo has its own mail address

Status: proposed. It carries the owner's three rulings of 24 Oct 2026:
- The address is `<handle>@mail.heywaldo.in`.
- Every send to another person is approved on a card.
- The Mac drafts this design.

It is not accepted. It should be published in waldo-brain and numbered there, and no code cites it by number until then. Building waits on #1494 and on decision A below.

## Problem and decision

The owner wants two things, in the pattern of the agent inboxes `docs/planning/CHANNEL_OPTIONS.md` names ("Waldo agent mail"):
- to cc or forward mail to Waldo;
- for Waldo to coordinate by mail as itself.

Today Waldo reaches mail only through the owner's Gmail:
- `send_email` proposes, the owner approves a card, and the mail goes out as the owner.
- The send is proven by finding it in the owner's Sent folder (`channels/approvals.ts:789`).

Nobody can write to Waldo, and Waldo can't write as itself.

**Decision**
1. **Address.** Each owner's Waldo receives mail at `<handle>@mail.heywaldo.in`. The owner picks the handle at onboarding.
   - The subdomain is required, not cosmetic. The apex `heywaldo.in` MX is Google (`smtp.google.com`), so a `handle@heywaldo.in` would land in Google Workspace.
   - It also keeps agent mail's sending reputation apart from sign-in mail.
2. **Inbound mail is outside content, always, in v1.** It never authenticates the owner, even when `From` is the owner's own address.
   - The owner can still cc or forward. Waldo reads the mail and answers.
   - Any change that follows goes to a card through #1494 ("after outside text, every change goes to the owner's card"), and the card is approved on a signed-in surface.
3. **Waldo sends as itself.** Each send to another person is an exact-draft approval card, the #1470 flow.
   - A reply to the owner needs no card. It goes only to the owner's directory address (limit 9).
4. **One brain.** Mail is another way into the owner's single OwnerDO. It gets no mailbox state of its own, and it never writes memory, approvals or chats outside the OwnerDO.

## Limits (each is enforced in code and pinned by a test unless marked otherwise)

**Inbound**

1. **Routing by recipient only.**
   - The handle in the envelope recipient picks the owner, through an owner-directory lookup.
   - An unknown or released handle is dropped. The sender gets no reply and no bounce, so Waldo never sends backscatter to forged senders.
2. **Who is read.** A message reaches a turn only if one of these holds:
   - (a) its `From` is the owner's directory address (`owner_email`, which the directory already returns: `identity/owner-directory.ts:26`); or
   - (b) its `In-Reply-To` or `References` names a Message-ID in that owner's mail thread map, meaning mail Waldo was sent, or mail Waldo sent.

   Everything else is cold mail. It is dropped without a reply and only counted.
   - Rule (b) is what makes cc work: a third party's reply-all to a thread the owner cc'd Waldo on is read.
   - Rule (a) is spoofable (see limit 3). What it admits is outside content, the same as any mail in the owner's Gmail that Waldo already reads.
3. **Mail never carries owner authority in v1.**
   - Sender checks decide routing and abuse handling only.
   - Why:
     - `_dmarc.gmail.com` is `p=none`, so a forged `From: <owner>@gmail.com` isn't rejected by policy.
     - Cloudflare Email Routing rejects only mail that "fail[s] authentication according to the sender's DMARC policy" (postmaster page).
     - No fetched page says whether a Worker can see authentication results.
   - Letting mail count as the owner later needs an amendment, backed by a DKIM-alignment check proven in code.
4. **Taint.**
   - The mail body, headers and attachments enter the turn as external content (`source_taint: 'external'`, the existing `SourceTaint`).
   - #1494's write gate holds every change for a card.
   - Reads, drafts and the reply to the owner continue.
5. **At most once.**
   - The ingress writes the message into the OwnerDO's inbox keyed by (handle, Message-ID), or by a digest of the raw message when Message-ID is missing. Then it returns.
   - The OwnerDO's alarm runs the turn. A redelivered message runs no second turn.
   - No external I/O happens inside the inbox transaction.
6. **Size.**
   - Inbound mail is capped at the provider's limit: 25 MiB on Cloudflare Email Routing.
   - The body handed to the model is redacted, then cut. Build PR 1 sets the cut to match what `read_thread` hands the model today.
   - Attachments go through the existing media loading and `LLM_ATTACHMENTS_MAX`, and are held for the turn only.
7. **Rate.** Per owner, a daily cap on mail-started turns. Cold mail and over-cap mail are counted, never read.
   - The cap is a cost and abuse boundary, not a judgment.
   - The number is set in build PR 1 from staging traffic.

**Outbound**

8. **Every send to another person is a card.**
   - The card shows the exact recipients, subject, body and the `From` line.
   - The digest is checked at send time, as in #1470.
   - Standing grants per thread are a later amendment, not v1.
9. **Replies to the owner.**
   - The recipient is the directory's `owner_email`, fixed by code.
   - It is never taken from `From`, `Reply-To`, `Cc` or anything else in the inbound mail.
   - So a forged "owner" mail gets its answer delivered to the real owner.
10. **Evidence and retries.**
    - Before the I/O, the intent records the outgoing Message-ID and the frozen draft digest.
    - The provider accepting the message is recorded as "accepted by the mail provider". It is never "delivered".
    - A timeout or an unreadable answer ends unknown. There is no automatic resend, and the card says the mail may have gone.
    - A bounce (a delivery-status message to the handle that names the Message-ID) settles the send as failed and tells the owner. [inference: bounce formats vary, and build PR 2 pins the ones the chosen provider sends]
11. **Recipients and reputation.**
    - At most the provider's per-message limit: 50 across to, cc and bcc on Cloudflare.
    - A per-owner daily send cap, because one owner's abuse would damage every owner's deliverability on the shared subdomain.
    - Waldo's mail is person-to-person on the owner's behalf, never bulk or marketing. [inference: whether CAN-SPAM/CASL unsubscribe duties apply to it needs the owner's legal check]

**Data**

12. **Storage.**
    - Bodies and attachments are not stored by this feature. They are transient in the turn.
    - Where the turn's text persists, it follows the existing rules for the owner's conversation and tool outputs, with external taint, and retention follows chat.
    - The only new state is the per-owner thread map: Message-ID, direction, time, and the thread it belongs to. It has no bodies, no subjects and no attachment names.
    - The thread map is deleted with the owner's account.
    - Build PR 1 names the exact store. A new durable body store would need its own amendment.
13. **Health.**
    - Mail that carries health information follows `docs/app/HEALTH_PLANE_AMENDMENT.md` and CLAUDE.md:
      - it may reach model context;
      - never logs, audit records, R2 or production traces;
      - only qualitative patterns reach long-term memory.
    - An outbound draft carries health information only when the owner asks to share that specific item.
14. **Logs.**
    - Logs record counts and fixed codes only: `admitted`, `cold_dropped`, `over_cap`, `duplicate`, `accepted`, `unknown`, `bounced`.
    - Never addresses, subjects, bodies, filenames or Message-IDs.

**Handles**

15. **Unique, reserved and not recycled.**
    - Handles are unique through the owner directory (a Supabase migration).
    - The RFC 2142 names are reserved: `postmaster`, `abuse`, `hostmaster`, `webmaster`, `admin`, `support`, `info`, `security`, `noreply`, `waldo`.
    - `postmaster@` and `abuse@` reach the team, not an owner.
    - A released handle isn't reissued for 180 days, so mail meant for its old owner can't reach a new one.

## Open decisions for the owner

**A. DNS and provider. This blocks build PR 1.**
- `heywaldo.in` is served by GoDaddy (`ns65/ns66.domaincontrol.com`).
- Cloudflare Email Routing and Email Sending need a Cloudflare zone, and "you can send only from routing domains" (limits page).
- A subdomain-only Cloudflare zone is Enterprise-only (subdomain setup page).

The choices:
- **(a) Move `heywaldo.in`'s nameservers to Cloudflare.** Every record is recreated, including Google's apex MX. Then Email Routing takes inbound for `mail.`, and Email Sending (beta, Workers Paid) sends.
  - For: one platform; a binding instead of an API key; [inference] no new subprocessor, since Cloudflare already runs the Worker. The DPA's coverage of mail content needs checking.
  - Against: the sending is beta, new accounts get "a conservative daily quota" with no number given, and a nameserver move touches sign-in mail and the website.
- **(b) Keep GoDaddy.**
  - Point `mail.heywaldo.in`'s MX at Amazon SES or Postmark inbound.
  - The provider posts each message to a signed Worker route, and the same provider sends.
  - For: no nameserver move; mature sending.
  - Against: a new subprocessor (a DPA and privacy-notice change), a new secret, and a webhook to authenticate.

Recommendation: (a), if a nameserver move is acceptable. Otherwise (b) with SES.

**B. Should mail ever count as the owner?** Recommendation: no for v1 (limit 3).

**C. The display name on Waldo's mail.** Proposed: "Waldo, <owner first name>'s assistant". It must never read as the owner.

**D. Cold mail.** Recommendation: drop it silently and show the owner a count (limit 2). The alternative is holding it for the owner to admit one by one.

**E. Privacy notice.** Waldo will process mail from third parties who never signed up. The privacy and terms draft needs a paragraph on this before the first outside tester uses mail.

**DNS for `mail.` under either choice:**
- The provider's SPF and DKIM records.
- Its own `_dmarc.mail.heywaldo.in`. The apex record is `p=quarantine; adkim=r; aspf=r` with no `sp=`, so the subdomain inherits it.
- Start the subdomain at `p=quarantine`. Move to `p=reject` once DMARC reports are clean.

## Build (after #1494 merges and decision A)

Three bounded PRs, each with red tests first, the full wall, and "Ready for gate review at <sha>". They go to a build account; the gate reviews.

1. **Inbound.**
   - Changes:
     - The handle table and directory lookup (migration).
     - The ingress: an Email Worker for (a), or a signed provider webhook for (b).
     - The OwnerDO inbox keyed by Message-ID; the alarm-run turn with external taint; the thread map; the caps.
   - Red tests:
     - A forged owner `From` stays external, and a change it asks for becomes a card.
     - Cold mail is dropped with no outbound mail at all.
     - A third-party reply-all on a known thread is read.
     - A duplicate delivery runs one turn.
     - Oversize and over-cap mail.
     - An attachment reaches the model only within `LLM_ATTACHMENTS_MAX`.
     - Logs carry fixed codes only.
2. **Outbound identity.**
   - Changes:
     - `send_email` gains an additive optional sender (owner's Gmail, or Waldo). Report the tool-definition token change, because the core budget is near 4,000.
     - The card's `From` line is an additive `app.v1`/approvals field. Tell the app lane before adding it.
     - The send effect with the Message-ID before the I/O, unknown on timeout, and bounce settlement.
     - The owner-reply path with its fixed recipient.
   - Red tests:
     - A reply never goes to `Reply-To`.
     - A changed draft is refused at send time.
     - A timeout ends unknown with no resend.
3. **Surfaces.**
   - The console and app show Waldo's address and the cold-mail count.
   - Handle choice at onboarding (with the app lane).
   - Mail turns appear in the owner's conversation.

## Alternatives

- **Gmail only (today).** Nobody can write to Waldo, and Waldo can't act as itself.
- **A real mailbox per owner (Workspace or Gmail account).** Seat cost and account management. [inference] Automated accounts sit badly with consumer-account terms.
- **One shared address with plus tags (`waldo+handle@`).** The owner tag leaks and is easy to guess. A forwarder may strip it.
- **Apex addresses (`handle@heywaldo.in`).** The apex MX is Google Workspace, and agent mail's reputation would mix with sign-in mail.

## Sources

Cloudflare pages, fetched 24 Oct 2026:
- Email Service overview: https://developers.cloudflare.com/email-service/
  - Email Sending is beta on Workers Paid.
  - "Arbitrary-recipient sending requires Workers Paid".
- Limits: https://developers.cloudflare.com/email-service/platform/limits/
  - Sending: 50 recipients; 5 MiB per message; any recipient after a sending domain is onboarded; "you can send only from routing domains"; a conservative daily quota for new accounts.
  - Routing: inbound 25 MiB; 200 rules per domain; 30 domains per zone.
- Postmaster: https://developers.cloudflare.com/email-routing/postmaster/
  - SPF or DKIM must pass.
  - DMARC is enforced per the sender's policy.
- Subdomain setup: https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/
  - Enterprise only.

DNS, observed with `dig` on 24 Oct 2026 around 10:00Z:
- `heywaldo.in` NS `ns65/ns66.domaincontrol.com`, MX `1 smtp.google.com`.
- `_dmarc.heywaldo.in` `p=quarantine; adkim=r; aspf=r`.
- `_dmarc.gmail.com` `p=none; sp=quarantine`.
- `mail.heywaldo.in` has no MX.

Other references:
- RFC 2142, mailbox names for common services: https://www.rfc-editor.org/rfc/rfc2142
- Repository: `docs/planning/CHANNEL_OPTIONS.md` ("Waldo agent mail"); `channels/approvals.ts` (the #1470 card and send-time checks); #1494 (the write gate).
