# Decisions D4 and D6 (2026-10-02)

Source: owner iMessage on 2026-10-02 at 00:10 IST, answering two yes/no questions sent by the main agent at 00:00:52 IST. Reply, verbatim: "1 yes for now" and "2 yes".

## D6: sandbox tier for browser tasks - YES, for now
- Browser tasks may run in Cloudflare Containers that sleep when idle.
- Scope as asked: staging only, prepare-only (no payments, no signing, no submit), hard cap $5 per month.
- The $5 cap is the owner-approved limit; no per-task price is claimed or verified here.
- "For now": revisit before any raise of the cap, any production use or any spend-bearing task.

## D4: open browsing stance - YES
- Waldo reads public web pages by default, with a blocklist.
- Page text is untrusted data. The injection guard and sanitisation chain apply and get more investment as reads open.
- Anything with a side effect (submit, send, pay, sign, post) still asks first and goes through the egress hook.
- No extra spend: calls stay inside existing limits.

## What this does not authorize
Production, new spend beyond the cap, secrets, write scopes, or any effect without the usual approval.
