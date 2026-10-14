# Console web onboarding: implementation plan

14 October 2026. Written for the session that builds it. This is a plan, not shipped capability: every `[verified]` line was read in source at `beta-mvp` `e5c022ef`, every `[proposed]` line is work to do, and `[inference]` marks conclusions not proven by a test or a staging trace. Nothing here was checked against hosted staging.

**Status (14 Oct, evening):** this push carries the decisions, the current-state audit, the journey and the rules for the implementing session. The slice sections S0 to S6, merge order, copy deck and handoff prompts follow in the next push on this branch.

**Pins:** backend `beta-mvp` `e5c022ef` (#1234 merged). Design references: the Waldo design-system artifact (README decisions win over its `tokens.css`) and the current console (`packages/dashboard-app`). The Figma onboarding file was not readable from the planning session.

## Owner decisions (14 Oct)

| Topic | Decision |
|---|---|
| Environment for the showcase | Staging. |
| Admission | Admin-issued, per-email invite links from `#/admin`. No open signup, no shared event code, no admission migration. |
| Chat in the console | Yes. A csrf-checked `/console` route admits the console session onto the same main chat as the iPhone app. `/app/v1` stays bearer-only. This replaces the rule "a console cookie is never accepted as an app bearer". |
| iPhone app call to action | A link to `https://www.heywaldo.in/waitlist`, new tab, code constant. No backend waitlist store. |
| Defaults accepted | No health numbers in onboarding; body data is "through the iPhone app". Telegram is never offered to new people. The autonomy answer is a stated preference, never a grant. Onboarding answers reach memory only as the owner's own first chat message, saved by `remember`; no new memory writer. |
| Still open (owner actions, see S0) | Adding visitors' Google accounts as OAuth test users. Whether staging model-text capture stays on during the showcase. |

## Why conversation-first

The flow does only what needs a screen (sign up, confirm the time zone, quiet hours, connect Google), then hands the person's own words to Waldo in a console chat, where he gets to know them. Three reasons:

- **One memory writer.** Owner facts live in the owner object's `claims` table. Prompt-eligible, owner-grounded rows come from `remember` (grounded in text the owner wrote in the conversation) and the nightly pass; the console has no "add a fact" write [verified: `memory/claims.ts`, `tools/live/memory.ts`, `dashboard-control-actions.ts`]. A form that wrote claims would be a second writer and a new trust boundary.
- **It does not fight the Mac session's first conversation.** Draft #1227 has Waldo lead a getting-to-know-you conversation only while the owner has no owner-grounded profile claims [verified on `mac/first-conversation`]. Form-written claims would switch that off.
- **It proves itself.** What Waldo saved appears in Memory › Profile within the same session, which is the tour's proof moment.

Rejected: a form that writes setup answers through a new route (new trust boundary, ADR not accepted, silences #1227, interview leaves the console); a front-end-only shell (answers never reach Waldo, a placeholder under `AGENTS.md`).

## Where the console is today

[verified at `e5c022ef` unless marked]

**Works with no change:** an invite link takes a visitor through signup to Today; they can confirm the time zone, set quiet hours, browse Memory, Profile and Settings, and delete the account. Dashboard tests: 31 files, 215 tests pass locally; they are not run in CI.

**Breaks for a showcase visitor:**

1. A bare console link is a dead end: signup needs a single-use, email-bound invite (`console-signup.ts:56`). The sign-in page shows an invite-code field that spends the visitor's email code and fails (`console-signin.ts:170`, `console-auth.ts:143`).
2. Signup and sign-in are server-rendered pages outside the console's design, with internals in the copy ("Supabase Auth identity", "readable signed cookie") and an all-caps label the design system bans.
3. Google connect fails for every console-only owner: the console path never stores the owner's origin, and `connectUrl` returns null without it, so the receipt reads "Google connect could not start" (traced end to end; no test covers it).
4. The Google OAuth app is unverified and in Testing: only listed test users (up to 100) can connect, and one consent asks for every scope.
5. There is no chat in the browser (`ChannelKind` is `telegram|whatsapp|app|imessage`; the SPA has no composer).
6. A web-only owner gets no Brief, Check-in or Close: scheduled work runs only for Telegram-linked or app-bound owners.
7. A new owner lands on an empty Today in UTC.
8. The auth throttle is 30 attempts per 15 minutes per IP, shared by sign-in and every signup step: about 10 signups per 15 minutes on one network [inference from the constants].
9. Staging captures all model text to Langfuse, environment-wide.
10. Nothing in the backend captures waitlist or TestFlight interest.

## The journey after this plan

1. The presenter issues an invite link (S0). The visitor opens it, signs up in Waldo's design and lands on `/console#/welcome` (S2).
2. **Meet:** "Hello. I'm Waldo." The visitor confirms the time zone (S3).
3. **Your day:** quiet hours (S3).
4. **Connect:** Google with a pre-prompt; it opens in a new tab and the step notices when the account appears (S1, S3). iMessage when the shared number is live (S6). Body data: "comes through the iPhone app".
5. **Say hello:** a few skippable questions become an editable first message in the visitor's own words, sent in the console chat; Waldo replies and gets to know them (S4).
6. **All set and the tour:** what Waldo does now, the tour over Today, Waiting, Memory › Profile and Connections, and "Get the iPhone app" (S3, S5).

## Read this first (implementing session)

- **Base and branches.** Work from `beta-mvp` only. One branch and one PR per slice, base `beta-mvp`, named `onboarding/s<N>-<topic>`. Do not read or diff against `main`.
- **Build unit.** Each slice is one user-visible outcome with its serving-path caller, tests and safety in the same PR (`AGENTS.md`, Build Unit). Do not split a slice by layer, and do not merge a half that is not wired.
- **Single writer.** `packages/runtime/src/channels/owner-do.ts` is sequenced by the Mac lane. S1 and S4 touch it: ask for the slot on #1103 before opening the PR, keep the diff minimal, and rebase on the tip they name.
- **Before shipping a slice,** walk `docs/planning/waldo-agent-mvp/ENGINEERING_FUNDAMENTALS.md` for the touched surfaces. Every bug you find adds an adversarial test and a checklist line in the same commit.
- **Security review** (`security-reviewer`) is mandatory for S1, S2 and S4.
- **Evidence.** Record PASS, FAIL, NOT RUN and UNAVAILABLE separately at the exact head SHA. Dashboard tests are not in CI: run them and paste the result. Docker and Supabase are unavailable in the cloud container; label those checks UNAVAILABLE rather than skipping them silently.
- **Guards locally.** `origin/main` is absent in a `beta-mvp`-only checkout, so run guards with `WALDO_DO_MIGRATION_BASE_REF=HEAD^1 npx -y pnpm@10.34.4 verify:guards`.
- **Never write** an invite link, an email code, a visitor's email address or a health value into a PR, a test fixture, a screenshot caption or this file.
- **Stop and ask** before: any Supabase migration, any change to admission, any new dependency, any env var, any change to CI, or a deploy.
