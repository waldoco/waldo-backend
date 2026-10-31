# Agent mail: draft paragraph for privacy notice v3

Status: **draft for the owner**. Not published. By owner ruling it goes in notice v3, not v2. The live notice is at heywaldo.in/privacy; its source is the waldo-landing repository. No waldo-landing change is made here.

Agent mail stays off (`AGENT_MAIL_INBOUND=0`) until this paragraph is live.

## Draft text

> **Mail sent to your Waldo address.** You can choose an address for Waldo, like `yourname@mail.heywaldo.in`.
>
> **What Waldo reads.** Waldo reads two kinds of mail sent to it:
> - mail whose From line is the address you sign in with;
> - replies in an email thread Waldo is already part of.
>
> **What Waldo ignores.** All other mail is discarded unread, without a reply or a bounce. Waldo keeps only a daily count of how many such messages arrived, for 30 days. Waldo reads at most 50 messages a day for you; mail beyond that is discarded the same way and counted.
>
> **Mail is not you.** Anyone can write any From line, so Waldo treats every mail as outside content, never as an instruction from you. A mail can't make Waldo act for you. If something in it calls for an action (a reply, a calendar change, a reminder), Waldo asks you first.
>
> **How Waldo reads it.** Waldo reads the message the way it reads your Gmail when you ask it to: the sender and recipients, the subject, the body and up to four attachments. It sends them to the AI model provider that runs Waldo, under the same terms as your chat messages. Waldo then tells you what matters in your chat, and that message is kept like the rest of your chat.
>
> **What Waldo stores.**
> - **The message itself.** Kept only until Waldo has read it, and never longer than 24 hours. After that Waldo keeps a fingerprint of the message for 30 days, so a repeated delivery is recognised. A fingerprint is a one-way digest; it can't be turned back into the mail.
> - **Thread records.** To recognise replies, Waldo keeps the message IDs of mail in its threads (technical identifiers, not subjects, names or text) until you delete your account.
>
> **Delivery.** Mail to your Waldo address is received by Cloudflare Email Routing, which passes it to Waldo. Cloudflare holds the routing rule for your address, which contains the address itself.
>
> **Changing or giving up your address.** When you do this, its routing rule is deleted and the address stops receiving mail. A released address is not given to anyone else, including you, for 180 days. The record that enforces this keeps only a digest of the address, not who held it.

## Each claim, and the code that makes it true

| Claim | Where it holds | Value |
|---|---|---|
| Reads only mail from the sign-in address, or a known thread | `agent-mail/inbox.ts` `admit` (`owner_from`, `thread`) | — |
| Other mail is discarded unread, with no reply or bounce | `agent-mail/ingress.ts` (never `setReject`, `reply` or `forward`); `admit` returns `cold_dropped` | — |
| Daily counts kept for 30 days | `inbox.ts` `COUNTS_KEPT_DAYS` | 30 |
| At most 50 a day | `inbox.ts` `AGENT_MAIL_DAILY_TURNS` | 50 |
| Outside content, never the owner | `agent-mail/turn.ts`: `source_taint: 'external'`, `AGENT_MAIL_TURN_TOOLS` (no egress reads), changes go to `propose_action` cards | — |
| Up to four attachments | `LLM_ATTACHMENTS_MAX` | 4 |
| Message kept until read, never past 24 h | `inbox.ts` `close` deletes `agent_mail_raw`; `AGENT_MAIL_HOLD_MS` | 24 h |
| Fingerprint for 30 days | `inbox.ts` `AGENT_MAIL_RETENTION_MS` (dedup digest only) | 30 days |
| Thread records until account deletion | `agent_mail_threads`, no age bound (residual risk in PR 1) | — |
| Cloudflare holds a rule naming the address | `agent-mail/rules.ts` (`create`, literal `to` matcher) | — |
| Rule deleted on change or release | `rules.ts` `reconcileAgentMailRules`; nightly `sweepAgentMailRules` after account deletion | — |
| Not reissued for 180 days; digest only | migration `20261029160000`, `agent_mail_handle_reissue` | 180 days |

## Open points for the owner

- **Diagnostics.** The draft says mail is handled "under the same terms as your chat messages". Whatever the notice says about chat, including the staging recording of model text for testers (owner ruling of 10 October 2026), then covers mail too. Check that the v3 chat wording is what should apply to mail. The draft makes no separate promise about traces.
- **Thread records.** They have no retention bound in code yet. Either v3 says "until you delete your account" (as drafted), or the code gains a bound first and the sentence changes to match.
- **Cloudflare.** Cloudflare isn't yet named as a processor for mail in notice v1. v3 should list it next to the other processors.
- **Sending.** Mail Waldo sends from the address (`AGENT_MAIL_SEND`) isn't built. When it is, it needs its own paragraph: the display name "Waldo, <first name>'s assistant", and what is kept of sent mail.
