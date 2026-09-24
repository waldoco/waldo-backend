# Mac Dev Loop (2026-09-24)

How the lane (remote builder) and the Mac work together now that Claude Code is out of the loop.
The Mac runs commands; a Codex model on the Mac executes packets and pastes results back;
the lane reads the results, judges pass/fail, and builds the next slice.

## Roles

- Lane (remote): writes and pushes all code, decides what to test, judges results.
- Codex (on the Mac, any cheap model): runs packets EXACTLY as written. No judgment, no fixes, no improvisation. If a command errors, paste the error back verbatim and stop that packet.
- Owner: relays packets to Codex and results back.

## Packet format (what the lane sends)

Every packet is self-contained and paste-ready:

```
PACKET <id>: <one-line goal>
WORKDIR: ~/Developer/Pin4sf/waldo-backend-mvp
SETUP:
  git checkout beta-mvp && git pull origin beta-mvp
STEPS:
  1. <exact command>
  2. <exact command>
REPORT BACK (paste everything between the markers):
===RESULT <id>===
<full stdout/stderr of every step, plus the outputs listed below>
===END===
```

## Result format (what Codex pastes back)

- Full command output, never summarized. If output is long, the tail 80 lines plus the exit code of each command.
- Any line the packet marks `CAPTURE:` must be included verbatim.
- Screenshots go as files when a packet asks for one.
- Secrets rule: never paste values of secrets. If a command prints a secret, redact it and say REDACTED.

## Standard capture commands

- Worker logs: `npx wrangler tail waldo-runtime-staging --format pretty` (run during a repro, capture 2 minutes)
- Supabase row check: `supabase db execute --project-ref togdshayyxycitzckpqv --sql "<query the packet gives>"`
- Deploy: `./ship.sh` (this is the ONLY deploy path)

## Test order (what blocks what)

1. P1 DEPLOY: `./ship.sh` -> confirm worker version changes. Blocks everything below.
2. P2 SMOKE: telegram message to staging bot gets a reply; trace shows hops.
3. P3 S1 VERIFY: two live checks from VERIFICATION_CHECKLIST (egress_redacted hop; scrub migration hop, corrupted URL gone from history).
4. P4 GOOGLE CONNECT: button -> consent page -> callback page -> waldo.connections row -> "what's on my calendar" answers with real data. Needs the owner to tap through.
5. P5 GMAIL FETCH: "any new email?" returns real mail (checklist 14c).
6. P6 BROWSER LIVE: browse_page against a real URL (checklist 14/14b). Needs Browserbase free-plan secrets set.
7. P7 CONSOLE SIGN-IN: needs Resend key first (owner sets RESEND_API_KEY + sender). Then: /console sign-in sends a code email, code signs in.
8. P8 CLEANUP (owner-approved): June leftovers removal, packet below.

## Cleanup packet (owner approved 2026-09-24): delete June leftovers

```
PACKET C1: remove June-leftover functions and secrets
WORKDIR: ~/Developer/Pin4sf/waldo-backend-mvp
STEPS:
  1. supabase functions delete oauth-google agent calendar health-sync insights --project-ref togdshayyxycitzckpqv
  2. supabase secrets unset GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET OAUTH_STATE_SECRET --project-ref togdshayyxycitzckpqv
  3. supabase functions list --project-ref togdshayyxycitzckpqv
  4. supabase secrets list --project-ref togdshayyxycitzckpqv
REPORT BACK: full output of all four commands.
PASS: step 3 no longer lists the five functions; step 4 no longer lists the three secrets.
```

## Pass/fail evidence rules

- PASS requires the exact marker named in the packet (a hop name in the tail, a row in a query, a page title). "It seemed to work" is not evidence.
- FAIL = marker absent, any non-zero exit, or any error line. On FAIL, paste the full output; the lane decides the next packet.
- Live evidence goes into VERIFICATION_CHECKLIST_2026-09-24.md; a checklist box is only ticked when a packet result proves it.
