# Console web onboarding: implementation plan

14 October 2026. Written for the session that builds it. This is a plan, not shipped capability: every `[verified]` line was read in source at the pinned base, every `[proposed]` line is work to do, and `[inference]` marks conclusions not proven by a test or a staging trace. Nothing here was checked against hosted staging.

**Pins:** sections are anchored at `a643bcab` (`beta-mvp` `04bb8c89`). The demo-freeze candidates merged after that; rebase and re-check anchors before editing. Design references: the Waldo design-system artifact (README decisions win over its `tokens.css`) and the current console (`packages/dashboard-app`). The Figma onboarding file was not readable from the planning session.

**Demo freeze:** on 14 Oct (19:27Z, #1103) Ansh froze `beta-mvp` until after the showcase. None of S1 to S6 is in the pinned demo build unless he adds it, so this plan is post-demo work; S0 covers the showcase itself, including the fallbacks.

## Owner decisions (14 Oct)

| Topic | Decision |
|---|---|
| Environment for the showcase | Staging. |
| Admission | Admin-issued, per-email invite links from `#/admin`. No open signup, no shared event code, no admission migration. |
| Chat in the console | Yes. A csrf-checked `/console` route admits the console session onto the same main chat as the iPhone app. `/app/v1` stays bearer-only. This replaces the rule "a console cookie is never accepted as an app bearer". |
| iPhone app call to action | "Join the iPhone app waitlist", linking to `https://www.heywaldo.in/waitlist` in a new tab, from one code constant (`IPHONE_WAITLIST_URL`). No backend waitlist store. |
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
6. **All set and the tour:** what Waldo does now, the tour over Today, Waiting, Memory › Profile and Connections, and "Join the iPhone app waitlist" (S3, S5).

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

## Slice status

Each section was written from source by one agent, attacked by an independent reviewer (source accuracy, then rules, security and copy), and revised. The review files are not in the repo; their findings are folded into the sections.

| Slice | PR(s) | Outcome | Review state |
|---|---|---|---|
| S0 | none (runbook) | The operator can run the showcase and the post-demo rollout without leaking invites or visitor data | Reviewed and revised |
| S1 | `onboarding/s1-console-origin` | A console-only owner can start Google connect | Reviewed; see the status line in the section |
| S2 | `onboarding/s2-pre-auth-pages` | Signup and sign-in in Waldo's design, landing on `#/welcome` | Reviewed and revised |
| S3 | `onboarding/s3-welcome` | The `#/welcome` flow and the Today resume card | Reviewed and revised |
| S4 | `onboarding/s4a-console-chat`, `onboarding/s4b-say-hello` | Chat with Waldo in the console; the visitor's answers become their first message | Reviewed; see the status line in the section |
| S5 | `onboarding/s5a-setup-and-copy`, `onboarding/s5b-tour-and-readback` | Setup that reflects onboarding, copy and contrast fixes; the tour and the "what he saved" readback | Reviewed and revised |
| S6 | `onboarding/s6-imessage-react` | iMessage linking in the React console when the shared number is live | Reviewed; see the status line in the section |

## Architecture at a glance

```mermaid
flowchart LR
  V[Visitor with an invite link] --> SU["/console/signup (server page, S2)"]
  SU -->|303| W["/console#/welcome (SPA, S3)"]
  W -->|timezone.set, proactivity.set| ACT["/console/dashboard/api/v1/actions"]
  W -->|google.connect, new tab| G["/c/ticket → Google consent → /oauth/google/callback"]
  W -->|Say hello (S4b)| CH["/console/dashboard/api/v1/chat (S4a)"]
  ACT --> DO[(OwnerDO)]
  CH --> DO
  G --> DO
  DO -->|AppInbox → drainApp → owner turn| M[Model + tools]
  M -->|remember| CL[(claims in the owner DO)]
  CL --> P["Memory › Profile (readback, S5b)"]
  DO -->|origin stored on the console path (S1)| G
```

| Component | Owner and store | Slice |
|---|---|---|
| Pre-auth pages | Worker, `console-signup.ts`, `console-signin.ts`, new `pre-auth-page.ts` | S2 |
| Welcome flow, chat view, tour | SPA, `packages/dashboard-app` | S3, S4, S5 |
| Console chat route | `OwnerDO.console()` plus new `console-chat.ts`; transcript in the existing app main chat | S4a |
| Owner facts | `claims` in the owner DO, written by `remember` from the owner's own words | none (reused) |
| Settings | `waldo.owner_settings` then the DO copy, via `timezone.set` and `proactivity.set` | none (reused) |
| Owner origin | DO identity storage, written on the console path | S1 |
| iMessage readiness | shared bridge DO plus one additive signed read function | S6 |

## Merge order and file ownership

The demo freeze approved on #1103 (19:27Z, 14 Oct) holds every slice until after the showcase unless Ansh adds it. After the freeze lifts:

| Order | Slice | Lane | Files | Depends on | Parallel with |
|---|---|---|---|---|---|
| 1 | S1 | `owner-do.ts` (Mac lane sequences) | `owner-do.ts` (2 lines), one new test, `imessage-e2e.test.ts` premise | none | S3, S4a, S5a |
| 2 | S3 | SPA | `App.tsx`, new `Welcome.tsx`, `welcome-model.ts`, `links.ts`, `style.css`, `preview.mjs`, tests | S1 for the Google sub-trace only | S1, S4a |
| 3 | S2 | runtime, non-owner-do | new `pre-auth-page.ts`, `console-signup.ts`, `console-signin.ts`, a test fixture, tests | S3 (the redirect target must exist) | S4a, S5a |
| 4 | S4a | runtime plus `owner-do.ts` (about 35 lines; Mac lane) plus SPA | new `console-chat.ts`, `console-auth.ts`, `app-api.ts`, `app-inbox.ts`, `surfaces/app.ts`, `console-link.ts`, `Chat.tsx`, `chat-model.ts`, `App.tsx` | S1 recommended; #1260 ordering per the section | S2, S3 |
| 5 | S4b | SPA | `SayHello.tsx`, `Welcome.tsx` hello step | S3, S4a | S5a |
| 6 | S5a | SPA plus non-owner-do runtime | `Panels.tsx`, `Controls.tsx`, `dashboard-controls.ts`, `style.css`, copy | S3 | S4 |
| 7 | S6 | SPA plus runtime plus one migration (owner-held) | `IMessage.tsx`, `Controls.tsx`, `Panels.tsx`, `imessage/**`, `dashboard-owner-controls.ts`, one migration | S5a; Ashish reviews `imessage/**` | none |
| 8 | S5b | SPA | `Tour.tsx`, `Chat.tsx` readback, `Welcome.tsx` finish | S4a, S5a | S6 |

**Conflicts with open work:** #1227/#1240 (prompt and turn assembly; no overlap with S1's `console()` hunk), #1260 (A2 surface runtime; S4a is designed for either order), #1063 (superseded for sign-in and sign-up by S2; comment on it first), #1133 (session code in `console-auth.ts`; rebase whichever lands second).

**Base:** every section is anchored at `a643bcab` (`beta-mvp` `04bb8c89`). Since then the freeze candidates merged into `beta-mvp`; in the files these slices touch, only `owner-do.ts` and `prompt/messaging-behavior.ts` moved. Rebase, then re-check each anchor before editing.

## Timeline

- **Showcase day:** run S0 only. Use its fallback script for every slice not in the pinned build.
- **After the freeze lifts, day 1:** S1 (2 h including review) and S3 (8 h) in parallel, then S2 (7 h) once S3 is merged.
- **Day 2:** S4a (about 10 h including security review), then S4b (2 h), then S5a (3 h).
- **Day 3:** S6 (7 to 9 h, after its migration is approved and applied) and S5b (4 h).
- **One staging deploy per day,** each followed by that day's acceptance traces from the sections. Deploys and migration applies are the owner's.

## Handoff prompts

Paste one per session. Each session reads this whole file first.

**Session A (SPA lane): S3, then S5a, then S5b**
> Implement S3, then S5a, then S5b from `docs/planning/lanes-2026-10-14/CONSOLE_WEB_ONBOARDING_PLAN.md` on branch `claude/focused-allen-85v68f`. Base each PR on the latest `beta-mvp`, one PR per slice, named as in the Slice status table. Read "Read this first" and your sections in full, rebase, and re-check every anchor before editing. Use TDD: write each listed test red first. Run the dashboard tests, typecheck, build and `verify:assets`, plus the guards with `WALDO_DO_MIGRATION_BASE_REF=HEAD^1`. Record PASS/FAIL/NOT RUN/UNAVAILABLE at the exact head in the PR, and attach the listed screenshots. Stop and ask before any migration, env var, dependency, CI change or deploy. Do not touch `owner-do.ts`.

**Session B (runtime and owner-do lane, coordinated with the Mac lane): S1, then S4a, then S4b**
> Implement S1, then S4a, then S4b from `docs/planning/lanes-2026-10-14/CONSOLE_WEB_ONBOARDING_PLAN.md` on branch `claude/focused-allen-85v68f`. Before each PR that touches `owner-do.ts`, post the claim and file list on #1103 and wait for the Mac lane's slot. Base each PR on the latest `beta-mvp`. Read "Read this first" and your sections in full, rebase, and re-check every anchor. S1 and S4a need `security-reviewer` on the exact head. Run the focused workerd tests listed in each section, typecheck, the guards with `WALDO_DO_MIGRATION_BASE_REF=HEAD^1`, and as much of the full wall as the container allows; label Supabase steps UNAVAILABLE. Stop and ask before any migration, env var, dependency, CI change or deploy.

**Session C (pre-auth pages): S2**
> Implement S2 from `docs/planning/lanes-2026-10-14/CONSOLE_WEB_ONBOARDING_PLAN.md` on branch `claude/focused-allen-85v68f` after S3 has merged. Comment on #1063 first, as the section says. Base the PR on the latest `beta-mvp`. Run the operator pre-merge checks (Safari and Firefox signup on staging, the privacy and terms pages, a fresh-email code) or record them as NOT RUN. `security-reviewer` is mandatory. Stop and ask before any env var, dependency, CI change or deploy.

**Session D (iMessage, with Ashish): S6**
> Implement S6 from `docs/planning/lanes-2026-10-14/CONSOLE_WEB_ONBOARDING_PLAN.md` on branch `claude/focused-allen-85v68f` after S5a has merged. Open it as a "needs owner (migration)" PR; Ashish reviews `channels/imessage/**`. Do not apply the migration yourself. Stop and ask before any env var, dependency, CI change or deploy.

**Operator (owner): S0** is the runbook; it needs no session.

## S0 Ops runbook before the showcase

Labels used in this section:
- **[verified]** read in source at `a643bcab` (`beta-mvp` `04bb8c89` plus docs), with the file:line given;
- **[reported]** read on GitHub (#1103, or the `beta-mvp` commit list) on 14 Oct up to 19:55Z, not checked against staging;
- **[inference]** not tested;
- **[proposed]** an action.

Nothing here was run against staging.

### Outcome

On 15 Oct staging runs one known, healthy build. The presenter can hand each visitor a working invite. Email codes arrive. Google admits the visitors it should. iMessage either answers or is left out. Everyone presenting knows which demo steps are live, which to skip, and what each visitor's data goes through. The job to be done: no visitor meets an undiagnosed failure in front of the room. Every failure is either fixed the night before or deliberately skipped. This slice ships no code. It is the checklist R1–R10, the demo script, and the evidence to post on #1103.

### Depends on / blocks

- **Blocks:** the showcase, and the STAGING acceptance traces of S1–S6. None of them can be traced until R1 deploys a build that contains it.
- **Depends on the owner (Ansh):**
  - the demo SHA, and whether any S-slice joins it (R1);
  - the Langfuse decision (R6);
  - the Google test-user list (R4);
  - hosted Supabase auth config (R5);
  - migration apply (R2).
- **The demo freeze [reported, #1103 6176559112 and 6176744721, 19:27Z and 19:37Z]:** Ansh approved it. Until after the demo, the only merges into `beta-mvp` are the candidate, in this order:
  1. #1258;
  2. #1259;
  3. headroom (`mac/headroom-fold`);
  4. #1261;
  5. the Mac browser fixes (`mac/browser-degrade-and-unstick`);
  6. #1227/#1240.

  This is the order as revised at 19:41Z (6176811003). Then one pinned SHA and one owner deploy. Merges keep the Mac gate: an independent PASS on the exact head, CI 6/6, and a clean merge-tree. **S1–S6 are not in the candidate.** A slice reaches the showcase only if Ansh adds its PR. Otherwise R9's fallbacks apply.
- **The owner's own demo [reported, 6176397565 and 6176528932]:** Ansh demos on Telegram and the web console. He keeps the current staging account as admin and onboards a new personal account. R3, R4, R5, R6 and R9 account for both.
- **Already in the tree [verified]:**
  - #1247/#1254: watch upkeep on connect.
  - #1257: iMessage "Open Messages" link page, a Setup item and a footer link.
  - #1241: Kennel pairing. It adds migration `20261014130000` and changes `console-signin.ts`.

### Current state

**Build and deploy**
- **Staging, 18:52Z [reported, 6175882296]:** release `04e02124`, Worker version `67e50f3c`. `healthz` and all three unsigned probes passed. Rollback target `6ef62710`.
- **`beta-mvp` is at `04bb8c89`** [verified]: 48 commits past `e5c022ef`, of which 10 are first-parent merges. CI on `04bb8c89` is green on all shards [reported, 6176744721].
- **`.github/workflows/deploy-staging.yml` [verified]:**
  - Hand dispatch only. It is headed "DRAFT - NOT ENABLED" and notes "No hosted run yet" (`:3-7,191`).
  - `deploy` runs typecheck, then `scripts/deploy-runtime.sh --env staging`, then the gate on `$GITHUB_SHA` (`:90-134`). It cannot pin a SHA.
- **`scripts/deploy-runtime.sh` [verified, `:9-17`]:** refuses a dirty tree, builds and checks the dashboard assets, then runs `wrangler deploy --var WALDO_RELEASE:<short sha> "$@"`.
- **Who deploys in practice:** the Mac orchestrator [reported].
- **Health [verified]:** `GET /healthz` returns `{ ok, release }` (`packages/runtime/src/index.ts:183-184`). `scripts/staging-gate.mjs` probes four refusal paths. With tokens it reads Worker versions and migration history, and it prints, never runs, the rollback (`docs/ops/STAGING_DEPLOY_GATE.md`).
- **Host [verified]:** `https://waldo-runtime-staging.piyushfulper3210.workers.dev` (`scripts/staging-gate.mjs:13`). There is no custom domain in `wrangler.jsonc`.
- **Rollback [verified]:** `scripts/staging-rollback.sh` runs `wrangler rollback`. That restores an earlier version's code and bindings, and vars count as bindings (`staging-gate.mjs:36`).

**Admission**
- **Migration `20261014060000` [verified]:** it removes the admin's lifetime cap. The earlier body refused once the admin had issued 5 invites ever, counting used, revoked and expired ones (`20260928190000_waldo_invite_chain.sql:94,104-105`).
- **Not proven applied.** `migration-apply` has never succeeded on hosted staging (`docs/ops/REVIEWED_STAGING_MIGRATION_ROUTE.md:3`).
- **`20261014130000` (#1241) will be pending** for any demo SHA, because `04bb8c89` contains it.
- **The Admin page always labels the current issuer "no limit"** (`dashboard-app/src/admin-model.ts:24`, `Admin.tsx:14`), so the page proves nothing about the migration.
- **Admin flag and the page [verified]:**
  - `is_admin` is set by hand (`20260924150000_waldo_admin.sql:2`).
  - `#/admin` shows "Invite management." to an admin and "Page not found." to others (`Admin.tsx:12,26`).
  - It lists every owner's and invitee's email (`Admin.tsx:34,40`). The receipt names the recipient and shows the full link (`channels/dashboard-admin.ts:26`, `Admin.tsx:10`).
- **Invite links [verified]:**
  - The link takes the admin's request origin (`identity/invite-code.ts:7-10`), and the SPA rejects any other origin (`admin-model.ts:49`).
  - Each invite is one-use, email-bound and valid for 14 days. Issuing is refused for an active owner or for an email that already holds an open invite (`20261014060000_waldo_admin_invite_uncapped.sql:18-21`).
  - **Any owner can issue 5 member invites** from `#/invites` (`channels/dashboard-owner-controls.ts:55,80`; `identity/console-auth.ts:165-169`).
- **Sessions [verified]:** 12 hours from sign-in, not extended by use (`channels/console.ts:20`).
- **IP throttle [verified]:**
  - 30 attempts per 15 minutes per IP, on one `ip:<ip>` key shared by sign-in, verify and every signup step (`console-signin.ts:22,224,268`; `console-signup.ts:74`).
  - Fixed buckets of `floor(epoch_s / 900)` (`20260925130000_waldo_open_signup.sql:105-121`; `identity/owner-directory.ts:67`), so windows reset at :00, :15, :30 and :45.
  - A clean signup costs 3 hits.

**Email [verified]**
- Signup sends only when the email is eligible: an active member, or a matching open invite. An ineligible send fails silently (`identity/console-signup.ts:55-56`; `invite_chain.sql:19-22`).
- A non-2xx from Supabase `/auth/v1/otp` shows "We could not confirm that an email code was sent…" (`identity/console-signup.ts:62`; `channels/console-signup.ts:42,79-82`).
- The repo customises only `magic_link` (`supabase/config.toml:6-8`). The hosted mailer was the shared default at 2 per hour on 24 Sep (`CONNECT_FLOW_DESIGN_2026-09-24.md:199`).

**Google [verified]**
- One combined consent, `access_type=offline`. The app is unverified, so only listed test users can connect (`connectors/google.ts:3-5,97-98`). Up to 100 test users (`OWNER_STEP_BY_STEP_SETUP_2026-09-24.md:33-44`).
- The redirect is `${stored origin}/oauth/google/callback` (`owner-do.ts:2270-2271`). A console-only owner has no stored origin, so connect fails with "Google connect could not start. Try again." (`console.ts:152`). S1 fixes this.
- The `connector-proxy` edge function imports `packages/runtime/src/connectors/*` (`supabase/functions/connector-proxy/*.ts`).

**Traces [verified]**
- Staging sets `LANGFUSE_CAPTURE_TEXT: "true"` (`wrangler.jsonc:87`). Any other value, and production always, turns capture off (`observability/trace-privacy.ts:65-66`).
- With capture on, staging Langfuse receives all of these (`channels/owner-turn.ts:257-263,452,584`; `observability/otlp-turns.ts:106-123`; `trace-privacy.ts:36-41`):
  - the full model input and output of each reply call;
  - every tool's arguments and output, including mail, calendar, files and contacts read from Google;
  - the owner's sign-up email.
- `CLAUDE.md:23` covers "opted-in testers". Visitors are not.

**iMessage [verified]**
- `/console/imessage` lists only the signed-in owner's own bridges (`20261014120000_waldo_imessage_shared_bridge.sql:252-260`). So the shared number's status shows only on the account that paired it.
- A row reads `online`/`offline` and `text verified`/`text not verified` (`channels/imessage/console.ts:34`). Online means a heartbeat within 90 s (`imessage/bridge-store.ts:169-171`; `wrangler.jsonc:87`).
- Link replies are at `bridge-do.ts:70-75`. Redeem is limited to 5 per sender per hour (`:409`).
- The page also shows "Pair a Mac host" to every owner (`imessage/console.ts:44`).

**Scheduled work [verified, read, not tested]**
- An owner that is neither Telegram-bound nor app-bound leaves the alarm before `setup()` (`owner-do.ts:1716-1733`; `appBound` at `:723-726`).
- Watch upkeep runs only as a scheduler job inside `setup()` (`:1826,3188`). Connect only schedules it (`:2336-2342`).
- So a console-only owner gets no Brief, check-ins, reminders or mail and calendar watching.

### Design

The design is one ordered checklist run by people. Each item says who runs it, the steps, how to check, and what to do on failure. Evidence goes to #1103 with no personal data. Anything that does not depend on the demo SHA runs tonight, so a failure leaves time to fix it.

| When | Items |
|---|---|
| Tonight (14 Oct), before the pin | R1 step 1; R2 read and any apply; R4 list and redirect URI; R5 full run on the current build; R6 decision; reserve Ansh's personal address; `brew install qrencode` on the presenter's Mac |
| 15 Oct, T−3 h | R1 deploy and health; R5 golden re-run on the demo build |
| T−90 min | R7; R8 read-out; open the waitlist URL on a phone |
| T−60 min | R3 admin sign-in on a non-mirrored device; rehearse R9 |
| During | R3 per visitor; R9 |
| After | R10 |

Rejected:
- A shared event code or open signup: the owner ruled both out.
- A throttle env var: `AGENTS.md` rejects env vars for non-secret config, and it would be a deploy under the freeze.
- Online QR makers or shorteners: they keep the link.
- Slices outside the freeze: only Ansh can amend it.

#### R1 Pin, deploy, check health twice
- **Who:**
  - Ansh names the SHA and deploys, or the Mac orchestrator does on his explicit go.
  - Implementing sessions never deploy.
- **Steps:**
  1. **What goes in.** Ansh posts on #1103 the 40-character demo SHA and which S-slice PRs, if any, it contains.
  2. **CI.** The row for the demo SHA must be `completed` / `success`:

     ```
     gh run list --repo waldoco/waldo-backend --workflow verify.yml --branch beta-mvp --limit 10 --json headSha,status,conclusion,databaseId
     ```

     Dashboard tests are not in CI, so each included S-slice PR must carry its local result.
  3. **R2 first.**
  4. **Path A (the Mac).** Needs pnpm 10.34.4 on PATH, because the script calls `pnpm`. Needs Cloudflare auth: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, or `wrangler login`.

     ```
     git fetch origin beta-mvp && git checkout --detach <DEMO_SHA>
     git status --porcelain     # must print nothing
     npx -y pnpm@10.34.4 install --frozen-lockfile
     scripts/deploy-runtime.sh --env staging --var LANGFUSE_CAPTURE_TEXT:false   # drop the --var if R6 chose A
     ```

  5. **Path B, untested.** Use it only if Path A is impossible, with Ansh's explicit go. It would be the workflow's first hosted run, and it cannot pin a SHA or apply R6 option B. First check that `git ls-remote origin refs/heads/beta-mvp` prints the demo SHA. Then:

     ```
     gh workflow run deploy-staging.yml --repo waldoco/waldo-backend --ref beta-mvp -f operation=deploy -f run_migrations=false
     ```

  6. **Health, twice, at least 10 s apart.** Both runs must print `{"ok":true,"release":"<first 7-8 chars of DEMO_SHA>"}` (`CURRENT_AGENT_ENTRYPOINT.md:15`).

     ```
     curl -sS https://waldo-runtime-staging.piyushfulper3210.workers.dev/healthz
     ```

  7. **Gate.** From a checkout at the demo SHA, after install:

     ```
     node scripts/staging-gate.mjs --expect-sha <DEMO_SHA>
     ```

     With `CLOUDFLARE_*` and `SUPABASE_ACCESS_TOKEN` it should end `GATE PASS`. Without them it ends `GATE INCOMPLETE`, with the four probes PASS.
  8. **Edge function.** If this prints anything, Ansh redeploys `connector-proxy` from the demo SHA (Mac lane), in the order the PR names:

     ```
     git diff --name-only 04e02124..<DEMO_SHA> -- packages/runtime/src/connectors supabase/functions
     ```
- **Verify:** one version at 100%, stamped with the demo SHA. Post the version id and the printed rollback id on #1103.
- **If it fails:**
  - **Fixed by a Worker rollback:**
    - `healthz`, `telegram-unsigned` or `gmail-push-unsigned` FAIL;
    - `worker-version`, `healthz-matches-version` or `browser-binding` FAIL;
    - the console will not load.

    Roll back, then run the gate again:

    ```
    scripts/staging-rollback.sh <id> --confirm <id> --message "showcase rollback"
    ```
  - **Not fixed by a Worker rollback:**
    - `connector-proxy-unsigned` or `edge-function <slug>`: redeploy that function from the previous reviewed SHA;
    - `migrations`: forward-only.
  - **After any rollback:**
    - Capture is back ON. Every earlier staging version carries `LANGFUSE_CAPTURE_TEXT: true`. Switch to R6 option A and say its disclosure line before anyone chats, or skip chat and Google for the rest of the event.
    - Switch R9 to the rollback build's slice set, which is none of S1–S6.

#### R2 Is `20261014060000` applied on hosted staging? (tonight)
- **Who:** an operator with `SUPABASE_ACCESS_TOKEN` or dashboard read access. Any apply needs Ansh.
- **Steps (read-only), any one of:**
  - **The gate's `migrations` line:** `last applied <version>, N pending against this checkout`. FAIL `history_not_canonical_prefix` means the hosted history is out of order. Stop, and the Mac lane investigates.
  - **The preflight receipt,** which lists `pending[]` filenames and `pendingManifestSha256`. The workflow requires the dispatched tip to equal `expected_source_sha`, so first check `git ls-remote origin refs/heads/beta-mvp`.

    ```
    gh workflow run deploy-staging.yml --repo waldoco/waldo-backend --ref beta-mvp -f operation=preflight -f expected_source_sha=<SHA> -f run_migrations=false
    ```

  - **The SQL editor** on project `togdshayyxycitzckpqv`, running only this. `true` means the uncapped body is live.

    ```sql
    select position('v_count' in pg_get_functiondef('waldo.admin_invite(text,text,bigint,text,text)'::regprocedure)) = 0 as uncapped;
    ```
- **Verify:**
  - `uncapped = true`, or last applied ≥ `20261014060000`;
  - pending is exactly `20261014130000_waldo_device_pairing_owner.sql`, or nothing.

  That migration only adds a function. Without it, only the browser "Get pairing code" on `/console/devices` breaks, which is not on the onboarding path [inference].
- **If it fails:**
  - **Without `20261014060000`:** an admin with 5 or more lifetime invites cannot issue any. The refusal reads "Not completed. Refresh records: the quota, recipient or invite state may have changed." (`admin-model.ts:39`).
  - **Apply tonight.** The Mac lane is the proven route. The alternative is `operation=migration-apply` with `expected_source_sha` plus the receipt's `pendingManifestSha256` as `reviewed_pending_sha256`. That has never succeeded on hosted staging.
  - Never apply automatically, and never as hand-written SQL.

#### R3 Admin account and issuing invites
- **Who:** the presenter, on Ansh's current staging (admin) account, using a device that is **not mirrored or projected**. `#/admin` shows every owner's and invitee's email.
- **Check admin:**
  1. Open `https://waldo-runtime-staging.piyushfulper3210.workers.dev/console/signin`. Enter the email only, and leave the invite and phone fields empty.
  2. Enter the code and open `/console#/admin`. Pass: "Invite management." with a "Create an invitation" panel. "Page not found." means the account is not admin.
  3. Read-only SQL: `select email, state, is_admin from waldo.owners where is_admin;`.
  4. If the flag is missing, Ansh sets it. This is a hosted write:

     ```sql
     update waldo.owners set is_admin = true where lower(email) = lower('<admin email>') and state = 'active';
     ```
- **Timing:** sign in at T−60 min at the earliest; the session ends 12 hours after sign-in. Keep that inbox open on the device.
- **Per visitor:**
  1. Enter the inbox the visitor will read on their phone, then select **Create one-use code**.
  2. In the receipt "Invite prepared. Copy it now.", select the **Recipient signup link** field and copy it. It is shown once.
  3. Run `pbpaste | qrencode -t ANSIUTF8` and let the visitor scan the QR, or send the link to the visitor's own inbox. **Never type or paste the link into a command,** a QR website, a shortener, a shared doc, a group chat or a screenshot.
  4. Select **Dismiss receipt**; the form stays disabled until you do.
  5. Before presenting, close `#/admin`. Never show it in the tour.
- **Ansh's personal account:** reserve its address. Never use it in R5 or a rehearsal; an invite is single-use, and a used address can be reused only after deleting that account. Issue its invite only when he signs up, from the non-mirrored device.
- **Host:** always issue from the workers.dev host above. It is the visitors' host and the registered Google redirect host.
- **If it fails:** "Not completed. Refresh records…" means the email is already an owner, already holds an open invite, or R2 is missing. For a typo: **Invites**, filter "open", **Revoke**, then reissue.

#### R4 Google OAuth test users (tonight)
- **Who:** Ansh, who owns the Google Cloud project behind staging's `GOOGLE_CLIENT_ID`.
- **Steps:**
  1. Collect each visitor's **Google** address. It may differ from their invite email. Include Ansh's personal Google account if his new account will connect.
  2. Go to console.cloud.google.com → the project → APIs & Services → OAuth consent screen. Newer consoles call it Google Auth Platform → Audience.
  3. Under **Test users**, select **Add users**, add the addresses and save. The cap is 100.
  4. Check that Credentials → the OAuth web client → Authorized redirect URIs contains exactly `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback`.
- **Verify:** only once S1 is live, a listed rehearsal account connects from the console and appears under Connections. Without S1, skip Google for every web visitor; only an operator-run account can use the Telegram workaround in R9 step 0.
- **What people see [inference, Google's Testing mode]:**
  - **Listed users** see "Google hasn't verified this app" and choose **Continue**.
  - **Unlisted users** get Google's "Access blocked … has not completed the Google verification process" (Error 403: access_denied). Nothing reaches Waldo, and they close the tab.
  - **Refresh tokens expire after 7 days,** so visitors will see "Reconnect needed" around 22 Oct. Tell them.
- **If it fails:** add the address on the spot, wait a minute, and start a fresh connect. The old consent state expires after 15 minutes.

#### R5 Email codes and the IP throttle (full run tonight; golden re-run at T−3 h)
- **Who:** an operator.
- **Steps:**
  1. From R3, invite a throwaway address you can read that has never been used on staging. A new plus-address works, because the invite matches the exact string [inference].
  2. On a phone, in a private window, open the link. "Your Waldo starts here." (`console-signup.ts:25`; S2 restyles it). Submit.
  3. "Check your email." should be followed within a couple of minutes by an email with a **numeric code**, not only a link.
  4. Enter the code. "Email verified. Finish signup." → **Finish signup** → `/console` (or `/console#/welcome` after S2). Progress expires 15 minutes after the start.
  5. Settings › Sessions → **Sign out of this browser** (`Controls.tsx:101`). Then sign in at `/console/signin` with the email only.
  6. Keep it as the rehearsal account, or delete it: Settings › Account, type `DELETE`.
- **If no code arrives**, read the page first:
  - **"Check your email." and nothing arrives.** Either no send was attempted (the invite was revoked, expired or used, or the typed email differs from the invite's), or delivery failed. Re-issue to rule out the invite, then check SMTP.
  - **"We could not confirm that an email code was sent…".** Supabase refused the send.
- **Ansh checks** (Supabase dashboard, project `togdshayyxycitzckpqv`; hosted config, owner-only):
  - Authentication → Sign In / Providers: **Allow new users to sign up** is on, and the Email provider is on.
  - Authentication → Emails → SMTP settings: custom SMTP is on.
  - Authentication → Rate limits: the email-send limit per hour covers visitors plus retries. It can be raised only once custom SMTP is on [inference].
  - Authentication → Emails → Templates: both **Confirm signup** and **Magic link** contain `{{ .Token }}`. A new user may get Confirm signup [inference].
  - If it can't be fixed tonight, invite only addresses proven to receive codes.
- **Throttle plan:**
  - About 10 clean signups per quarter-hour per public IP. A resend, a wrong code and any sign-in each cost a hit, Ansh's included.
  - Keep each network to 8 signups per window, starting new arrivals just after :00, :15, :30 and :45.
  - Ask visitors to use mobile data.
  - Put the presenter on a separate hotspot.
  - Raising the limit is a code change plus a deploy (`console-signin.ts:22` and `console-signup.ts:74` together) and is Ansh's call.
- **What throttled visitors see:**
  - **Signup:** "Too many attempts. No new code was requested. Wait a few minutes and retry below." or "Too many attempts. Wait a few minutes and retry." (`console-signup.ts:42,74`).
  - **Sign-in:** "Too many attempts. Wait a minute and try again." or "Too many attempts. Try again in a few minutes." (`console-signin.ts:218,230`).

#### R6 Langfuse text capture (decide tonight)
- **Who:** Ansh decides; the deployer applies it.
- **Option A, keep on.** Staging Langfuse receives each visitor's messages, Waldo's replies and the full model context. It also receives the output of every tool Waldo runs: once S1 is live, that includes mail, calendar, files and contacts read from the visitor's Google account, plus their sign-up email. The presenter says the disclosure line before anyone types. Visitors are not the "opted-in testers" `CLAUDE.md:23` covers.
- **Option B, off.** Deploy with `--var LANGFUSE_CAPTURE_TEXT:false` (R1 Path A).
  - It also removes text from Ansh's own Telegram turns and from round 2 of the eval on that build; hop codes remain.
  - Any rollback or later deploy turns capture back on (R1).
  - A lasting change is a PR to `wrangler.jsonc:87`.
- **Verify:** one turn, from Ansh's Telegram, iMessage if R7 passed, or S4 chat if live. The newest staging trace then has text (A) or none (B). Needs Langfuse read access.
- **Default without a decision:** B [proposed].

#### R7 iMessage shared number (T−90 min, before showing S6)
- **Who:** an operator on the admin account that paired the shared number.
- **Steps:**
  1. Open `/console/imessage`. The shared row must read `shared Waldo number · active · online · text verified`, with no "sending paused". Do not touch the pairing forms.
  2. On the rehearsal account, with an iPhone **not** linked to any Waldo:
     1. Select **Get an iMessage link code**, then **Open Messages** on the iPhone, then **Send**.
     2. The reply should be "Linked. Texts from this number now go to your own Waldo."
     3. The page shows `Linked: •••NNNN`.
     4. Send "hi" and get a reply.
     5. Select **Unlink this number**.
- **If it fails:**
  - **"offline":** no heartbeat in 90 s. Wake the Mac host. If it stays offline, leave iMessage out.
  - **"text not verified":** leave iMessage out.
  - **"This number is already linked…":** use another iPhone.
  - **Limits:** 5 link attempts per sender per hour. An unlinked sender gets the waitlist reply once every 30 days, so visitors link before texting.

#### R8 What not to promise a web-only visitor
A console-only owner gets no scheduled work, so:
- no Brief, check-ins or Close;
- no reminders delivered;
- no mail or calendar watching [verified, see Current state].

No `gmail_watch` log lines for such an owner is this known gap, not a fault.

Also do not promise:
- anything about body data or readiness;
- Telegram.

Safe once S1 and S4 are live [inference]: "Ask Waldo about your calendar or mail and he reads them when you ask."

#### R9 Demo script, with fallbacks
**Step 0, the owner segment.** Ansh demos Telegram on his existing account. It is not part of visitor onboarding, and Telegram is never offered to visitors.

**Google on Ansh's new personal account while S1 is not deployed.** This works on an operator-run account only. Run it tonight or before doors open.
1. In that account's console, select **Link a Telegram account** and redeem the code in the Waldo bot.
2. Send the bot one ordinary message. Not `/start` and not `/link`: a link or start command takes the setup path, which stores no origin.
3. That turn stores the webhook request's origin on the owner (`telegram-webhook.ts:102,127`; `owner-do.ts:460`).
4. Then, in the console on the registered staging host, select **Connect Google**.

[verified in source; not run on staging]

**Host caveat.** Use only `https://waldo-runtime-staging.piyushfulper3210.workers.dev` for the console, for invites and for Telegram's webhook. On any other host Google rejects the redirect with `redirect_uri_mismatch`, a Cloudflare version-preview URL included. The redirect is built from the stored origin (`owner-do.ts:2270-2271`), and only this host's callback is registered (R4).

**Visitor happy path, with S1–S5 live (S6 optional):**
1. Invite (R3), then scan.
2. Signup (S2), then `/console#/welcome`.
3. Meet: the time zone (S3).
4. Your day: quiet hours (S3).
5. Connect (S1+S3):
   - Google, for listed visitors only, in a new tab;
   - iMessage, if R7 passed (S6);
   - body data "comes through the iPhone app".
6. Say hello (S4): choose answers or "Or say it your way", edit, send. Waldo replies.
7. All set and the tour (S3/S5):
   - Today, Waiting and Connections;
   - Memory › Profile, showing what Waldo saved (S5);
   - "Get the iPhone app", which opens `https://www.heywaldo.in/waitlist`.

**Fallbacks:**
- **No S1:** visitors skip Google. Only Ansh's operator-run account connects, through the step 0 workaround.
- **No S2:** the old pages work, landing on Today; if S3 is live, open `/console#/welcome` by hand. Never use `/console/signin` with an invite code: it spends the visitor's email code and fails with a misleading message (`console-signin.ts:176`; `console-auth.ts:121-124,143`). The invite stays usable through `/console/signup`.
- **No S3:**
  - Settings › Your day → **Use this device** → **Save time zone**, and set quiet hours on the same page.
  - Google through Settings › Connections, in the same tab (S1 only).
- **No S4:** skip Say hello; there is no browser chat. If R7 passed, the visitor may chat on iMessage.
- **No S6, R7 passed:** use the footer link **iMessage** (`App.tsx:217`) and tap only **Get an iMessage link code**.
- **Never open in the tour, whatever is live:**
  - Setup or **Link a Telegram account**, until S5 (`Panels.tsx:147`; `Controls.tsx:93`). The one exception is the operator-run step above, done off-screen;
  - Files and Invites;
  - Classic console;
  - `#/admin`.
- **Nothing onboarding-related live:** signup, the time zone and quiet hours in Settings, Memory, then the waitlist. Say plainly that chat is in the iPhone app.

#### R10 After the showcase
1. In `#/admin` → **Invites**, filter "open" across all issuers and **Revoke** every unused invite, including those visitors issued themselves.
2. Ansh decides whether to keep, suspend or delete visitor accounts and their Google grants. Visitors can delete their own in Settings › Account.
3. Remove visitors from Google's test users, so they can no longer start a connect. Removing them may not free cap slots [inference].
4. If R6 chose B, Ansh decides whether the next deploy restores capture.
5. Collect feedback outside the repo. Never put a visitor's email, link, code or screenshot into a PR, an issue, a fixture or this doc.
6. Post on #1103: counts only (invites issued, used and revoked; Google connects; chats), plus each failure and the R-item it hit.

### Changes, file by file

None (runbook).

### UI and copy

No product UI ships in this slice. These are spoken lines: sentence case, Waldo is "he", and none of R8's promises.
- **Invite:** "Scan this. Use the email you gave me; Waldo sends a code there."
- **Code:** "Type the code from the email, then Finish."
- **R6 option A disclosure:** "This is our test server. What you type, Waldo's replies and anything he reads from your Google account during the chat are recorded so the team can fix things. If you'd rather not, skip the chat or skip Google."
- **Google, before consent:** "Google asks for your calendar, mail, tasks, files and contacts in one go."
- **Google blocked:** "Google only lets people on our test list in for now. Skip this. You can connect later."
- **iPhone app:** "Your body data comes through the iPhone app. It's in testing; join the waitlist and we'll tell you when there's a place."

### Security, privacy and authority

- **Invite links are bearer material:** each holds an email and a one-use code. Hand them over offline or to the visitor's own inbox. Never type, log, screenshot or shorten them, and never issue invites on a shared screen.
- **A leaked link cannot use the invite.** Using it needs the code sent to that inbox (`20260928190000_waldo_invite_chain.sql:38-46`). The holder can still request codes to that inbox, up to 5 per 15 minutes. Revoke and reissue if that happens.
- **Admin invites do not bound owners or spend.** Each visitor can issue 5 member invites, and so can each invitee. Owner turns have no spend cap [inference], and Sol (#1258) costs more per call [reported]. Keep Invites out of the tour, and revoke in R10.
- **Hosted writes are Ansh's alone:** `is_admin`, migration apply, Supabase auth config, Google test users and the Langfuse var. The only SQL anyone else runs is the two read-only queries in R2 and R3.
- **Traces:** R6 states what option A records. A rollback silently restores capture.
- **No health numbers** anywhere in the script. Telegram is never offered to visitors. #1103 evidence carries no emails, codes, links or handles.
- **Security-review trigger:** no. No code, auth flow or data path changes.

### Tests

Live checks, run by hand.
- **Golden (STAGING):** R5 steps 1–5. A fresh invite leads to a numeric code, then Finish, then landing, then email-only sign-in.
- **Null:** an unlisted Google account, with S1 live. Google blocks it, and Connections is unchanged.
- **Revoked:** revoke a spare rehearsal invite, then open its link and submit. "Check your email." appears, no email arrives, and nothing can be finished.
- **Failure:** R1 step 6 shows the old release after the gate's retries. Run the R1 failure path, then the gate.
- **Hostile:** open a **rehearsal** invite's link and type an email that is not a Waldo owner. No code is sent, and the invite stays usable for its own address.
- **Non-admin:** the rehearsal account opens `/console#/admin` and sees "Page not found."
- **Script logic (offline):** the command in Verification commands, step 2.

### Acceptance trace

Post one #1103 comment before doors open, each line labelled:
1. **SOURCE:** the demo SHA and its S-slices.
2. **CI:** the run id on that SHA.
3. **STAGING:** R2 result, with the pending filenames.
4. **STAGING:** `healthz` twice, with times and release.
5. **STAGING:** gate summary, version at 100%, and the rollback id.
6. **LIVE:** R5 tonight and at T−3 h, PASS or FAIL, with no address.
7. **LIVE:** the admin page renders.
8. **LIVE:** the R4 test-user count, and one listed connect if S1 is live.
9. **LIVE:** the R6 choice and its trace check.
10. **LIVE:** R7 status and the round trip, or "iMessage out".
11. **The R9 branch in use.**

Screenshots: terminal output only, plus `/console/imessage` cropped to the status cell. Never admin pages, emails, GCP lists or traces. The local preview recipe does not apply.

### Verification commands

| # | Command | Where |
|---|---|---|
| 1 | `git diff --check` | Cloud container |
| 2 | `node --test scripts/staging-gate.test.mjs scripts/staging-rollback.test.mjs scripts/staging-migration-preflight.test.mjs` | Cloud container; offline |
| 3 | `gh run list … --json headSha,status,conclusion,databaseId` (R1 step 2) | Operator; read-only |
| 4 | R2 read: the gate, the preflight or the SQL probe | Operator; read-only |
| 5 | R1 Path A deploy | Owner only |
| 6 | `curl -sS …/healthz`, twice | Operator machine; implementing sessions do not call staging |
| 7 | `node scripts/staging-gate.mjs --expect-sha <DEMO_SHA>`, after `npx -y pnpm@10.34.4 install --frozen-lockfile` | Operator |

No step needs Docker or Supabase locally. pgTAP and `verify:supabase` are not part of this slice.

### Rollback

- **Worker:** `scripts/staging-rollback.sh <id> --confirm <id> --message "<reason>"`, then the gate. Langfuse capture comes back ON and the slice set changes (R1).
- **Edge function:** redeploy from the previous reviewed SHA.
- **Migrations:** forward-only.
- **Invites:** revoke them.
- **Google test users:** remove them.
- **Accounts:** Settings › Account → `DELETE`.

### Risks and open questions

1. **The freeze excludes S1–S6.** Default: R9 fallbacks on the pinned SHA. Before the pin, ask Ansh whether any gated slice PR joins. S1 matters most.
2. **No email code for new addresses.** Default: R5 tonight. If unfixed, invite only proven addresses.
3. **`20261014060000` missing.** Default: Mac lane applies it tonight. Without it, there are no invites past the admin's 5th.
4. **Unlisted Google accounts.** Default: they skip Google.
5. **The venue IP throttle.** Default: 8 per network per quarter-hour, mobile data, and a presenter hotspot.
6. **No Langfuse decision.** Default: B through Path A. If Path B or a rollback is used, A applies, with the disclosure line.
7. **Admin session expiry.** Default: sign in at T−60 min.
8. **Line anchors drift.** They are at `a643bcab`. Re-check them against the demo SHA.

### Effort

S. About 2 h tonight (R1 step 1, R2, R4, R5, R6), 2 h on the morning (R1, the R5 re-run, R7, R3, rehearsal) and 30 min after (R10). Lane: ops and owner. No SPA, runtime, `owner-do.ts` or migration files are touched.

## S1 Google connect for console-only owners

> **Status:** designed and tested in a scratch copy (the new tests fail 5 of 8 before the fix and pass 8 of 8 after); the independent review is still running. Do not start S1 until this line is gone.

Anchors are at `beta-mvp` `04bb8c89`. The planning branch `a643bcab` has the same code tree plus one docs commit. `owner-do.ts` line numbers moved after `e5c022ef` (#1241, #1247/#1254, #1257). Every `[verified]` line below was read at `04bb8c89`. "Scratch run" means I ran vitest in a throwaway copy of `04bb8c89` under the scratchpad, with the repo's own `node_modules`. The repo itself was never edited.

### Outcome

A visitor who signed up from an invite, and who has only ever used the browser console, opens Settings › Connections (later the S3 Welcome "Connect" step) and presses **Connect Google**. They get "Receipt recorded. Google connect is ready to begin. Access has not been granted or tested." and a **Continue to Google** link to this deployment's own `/c/<ticket>`. Google's consent screen sends them back to the same staging host, the callback page says "Google is connected", and the account appears under Connections as "Access granted · read unverified". Today the same visitor gets "Change not applied. Google connect could not start. Try again." The job to be done: let Waldo read my calendar and mail without me needing Telegram or the iPhone app. Owners whose origin Telegram, the app or WhatsApp recorded keep working exactly as before.

### Depends on / blocks

- **Depends on:** no other slice.
  - Owner actions (S0): add each visitor's Google account as an OAuth test user, and deploy a SHA that contains S1.
  - The OAuth client must list `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback` as a redirect URI. The repo documents it (`docs/planning/waldo-agent-mvp/OWNER_STEP_BY_STEP_SETUP_2026-09-24.md:41`), but the live Google Cloud setting is UNVERIFIED.
- **Blocks:**
  - S3 Connect step. It posts the same `google.connect` action, so without S1 it fails for every visitor.
  - S0 rehearsal step "connect from the console".
  - S4, partly. S4's console chat route lives inside `OwnerDO.console()` after session admission, so S1's write also gives chat-issued `connect_service` links and console links a stored origin [inference].
- **Merge window:**
  - The coordinator reports that Ansh approved a demo freeze on #1103 at 19:27Z on 14 Oct. Only #1258, agent headroom, #1259, #1261 and #1227/#1240 merge before the showcase, with one pinned SHA and one deploy. `owner-do.ts` belongs to the Mac lane. (I did not read that comment myself; the #1103 thread is long and I read only its first page.)
  - **S1 therefore lands after the demo unless Ansh adds it to the pin.** It is a 2-line `owner-do.ts` change, so the Mac lane sequences it.
- **Textual overlap:** S1 inserts after `owner-do.ts:1379`.
  - #1241 is already merged.
  - Draft #1227/#1240 hunks touch the `setup()` region and the turn assembly, not `console()` [verified on `origin/mac/first-conversation` relative to its merge-base; re-check after that rebase].

**Demo-day workaround while S1 is not in the pin** [verified in source]. An owner whose origin a Telegram turn (or an app request) already recorded can connect Google from the console today. Use it only on an operator-run demo account. Visitors are never shown Telegram (owner default; S0).

1. On the staging host, sign in as the demo account and open Settings › Connections › **Link a Telegram account**. The receipt reads "Send this to the Waldo bot on Telegram within 10 minutes: /link CODE" (`owner-do.ts:1506`).
2. Send `/link CODE` to the bot from the demo Telegram account. A separate link object redeems it (`telegram-webhook.ts:103-121`, `owner-do.ts:570-578`). It does **not** write the owner's origin.
3. Send **one ordinary message** (not `/start` or `/link`) to the bot.
   - The webhook routes it to the owner object with `x-waldo-origin` set to the webhook request's own origin (`telegram-webhook.ts:102,127`).
   - The owner object stores it after admission (`owner-do.ts:460`).
   - `/start` and `/link` text returns before that write (`owner-do.ts:429-433`).
4. Press **Connect Google** in the console, **on the same host Telegram's webhook uses**. The receipt accepts only a ticket link whose origin equals the console request's origin (`dashboard-control-actions.ts:25`, `owner-do.ts:1503`). On any other host it reads "Google connect returned an unavailable destination. Try again later."
   - Scratch run: an owner with the console host already stored gets a `recorded` receipt at `04bb8c89` with no S1 change. That is the "same host" test below, which passes before and after S1.
   - Which host Telegram uses is the URL the bot webhook is registered at. The docs name `https://waldo-runtime-staging.piyushfulper3210.workers.dev` [inference]. An operator with the bot token can confirm it with Telegram's `getWebhookInfo`.
5. Side effect: the demo account becomes Telegram-bound, so its alarm runs scheduled Telegram work (`owner-do.ts:1716-1733`).

Alternative: open the main chat once in the iPhone app signed in as the same account.
- App chat, controls, actions and approvals requests carry `x-waldo-app-origin` set to the app API base (`app-api.ts:185-196`). The owner object stores it after app authentication (`owner-do.ts:887-893`).
- `/app/v1/session` alone never reaches the owner object.
- The app's API base must be the same host as the console.

### Current state

[verified at `04bb8c89` unless marked]

- **The Worker forwards console requests with the public URL and every client header.**
  - `handleConsole` does `new Request(request)` and sets only `x-waldo-do-name` (`console-signin.ts:350-353`). The ticket-console path does the same (`index.ts:140-142`).
  - The shell's owner check builds `new URL(DASHBOARD_OVERVIEW_PATH, url)` (`dashboard-static.ts:33`).
  - So inside `OwnerDO.console()`, `new URL(request.url).origin` is the public host the browser used. Any `x-waldo-origin`, `x-waldo-app-origin`, `Origin` or `X-Forwarded-Host` the client sent arrives unchanged.
- **The console never records an origin.**
  - In `OwnerDO.fetch`, `/grant-console` (`owner-do.ts:1027`) and every `/console*` path (`:1028`) return before the generic origin write (`:1043-1045`).
  - Signup's and sign-in's only owner-object call is `POST https://telegram-owner/grant-console`, an internal URL with no origin header (`console-signup.ts:114`, `console-signin.ts:287`).
  - The OAuth hops (`/google/begin-session` `:1034-1040`, Google finish `:1030-1033`) also use internal URLs.
- **The origin writers today all take the Worker-derived `new URL(request.url).origin`:**

  | Ingress | Header source | Owner-object write |
  |---|---|---|
  | Telegram enqueue, after admission | `telegram-webhook.ts:102,127` | `owner-do.ts:460` |
  | App route, after app session authority | `app-api.ts:196` | `owner-do.ts:893` |
  | Generic path; also re-registers the bot webhook when the origin changes | event-ingress `event-ingress.ts:199,212`, probe `probe-turn.ts:108` | `owner-do.ts:1043-1052` |
  | WhatsApp | `whatsapp-webhook.ts:83,95` | `owner-do.ts:1210` |

- **Readers that fail without an origin:**
  - `googleApp()` returns null, because the redirect URI is `${origin}/oauth/google/callback` (`owner-do.ts:2269-2271`).
  - `connectUrl()` returns null before issuing a ticket (`:2414-2429`).
  - The waiting link (`:2526-2527`), export links (`:2571`) and artifact delivery (`:2649`) need it too.
  - The calendar watch address skips (`:3190`; `calendar-push.ts:69`).
  - The consent attempt freezes `redirect_uri` when it starts (`connectors/google-consent.ts:51`). The code exchange uses that frozen value (`:77`).
- **The console action itself:**
  - `google.connect` calls `googleConnectReceipt(await runtime.googleConnectUrl(value,'console'), url.origin)` (`owner-do.ts:1503`). The receipt rejects a null link with `NOTICES['google.connect.failed']` = "Google connect could not start. Try again." (`console.ts:152`).
  - It also rejects a link whose origin is not the request's ("Google connect returned an unavailable destination. Try again later.", `dashboard-control-actions.ts:22-27`).
  - The legacy console path calls the same `googleConnectUrl` (`owner-do.ts:1569`).
  - The button shows anyway, because `connectAvailable` is `google.configured()`, which checks secrets only (`:2406`, `:3409`; `Controls.tsx:95`).
- **Observed failure (scratch run at `04bb8c89`):**
  - A console-only owner (signup grant, then the dashboard read and action) gets HTTP 409 with a `rejected` receipt.
  - The body read at `e5c022ef` on the same path was `{"receipt":{"state":"rejected","message":"Google connect could not start. Try again."},"duplicate":false}`.
  - The SPA shows that as "Change not applied." plus the message (`Controls.tsx:111-117`).
- **Telegram-first owner on a different host:** today the stored origin stays the Telegram host, so the `/c/` link fails the receipt's same-origin rule. The ticket has already been issued by then [inference from `connectUrl` order, `owner-do.ts:2419-2429`].
- **Consent completion:**
  - The callback routes by the signed state's owner (`google-oauth.ts:72-92`). A console ticket begins with surface `dashboard` (`owner-do.ts:2431-2435`), so the page's button is "Back to your console" (`google-oauth.ts:18-32`).
  - `finishGoogle` sends "Google is connected …" to Telegram only (`owner-do.ts:1664-1672`). For a console-only owner that send fails and is logged as `google_linked_notice`; the outcome is unaffected.
- **Hidden dependencies on Telegram secrets:**
  - The console controls read uses `this.setup()` (Telegram runtime) (`owner-do.ts:1481`). It throws "telegram owner runtime is unconfigured" without `TELEGRAM_BOT_TOKEN` (`:2121`); the scratch run without a token got 503 `controls_unavailable`.
  - `TELEGRAM_WEBHOOK_SECRET` is the OAuth state key (`:2406`).
  - Staging is believed to set both [inference].
- **Tests:**
  - No test covers a console `google.connect` for a console-only owner. The app twin exists: `test/app-google-connect.test.ts`.
  - `test/imessage-e2e.test.ts:509-519` ("an iMessage turn with no public origin on record mints nothing…") gets its "no origin" premise only because console pairing (`pairAndActivate`, `:70-80`, which posts `/console/action`) writes no origin. The scratch run with S1 applied: this test fails, 1 of 45 in `vitest.imessage.config.ts`.
- **No custom hosts:** `wrangler.jsonc` sets no `routes`, `custom_domain`, `workers_dev` or `preview_urls` (grep: 0 matches). The deployment answers on its `workers.dev` host. Whether Cloudflare version-preview hosts are enabled is UNVERIFIED.

### Design

**Change:** in `OwnerDO.console()`, right after the console session is validated, record the request's own origin:

```ts
if (this.ctx.storage.kv.get<string>('origin') !== url.origin) this.ctx.storage.kv.put('origin', url.origin);
```

Why this shape:

- **The only trusted source.**
  - On the console path the DO request URL is the public URL the browser used, and the Worker forwards client headers verbatim. So the URL is trusted and the headers are not.
  - Telegram, app and WhatsApp each derive origin the same way, from `new URL(request.url).origin` in the Worker. The console derives it one hop later, because its Worker forwarder passes the URL through.
- **After authentication, like the app path** (`owner-do.ts:887-893`).
  - A request without a live DO-local console session returns 401 at `:1379`, before the write. So a stale cookie, a signed-out session or the unauthenticated ticket passthrough cannot plant or move an origin.
  - SameSite=Strict cookies (`console-signin.ts:297`) mean no cross-site page can drive the write.
- **Every authenticated console request, compared first.**
  - It matches the other ingress paths, which record on every authenticated request.
  - It covers the whole bug class at once: React connect (`:1503`), legacy connect (`:1569`), waiting, export and artifact links, the calendar watch address, and S4's chat `connect_service`.
  - It heals a stale host.
  - The compare avoids one storage write per SPA poll.
- **The redirect URI.**
  - Google accepts only an exact registered redirect URI, and the stored origin decides it (`:2271`). Recording the host the owner is actually on makes the redirect equal the host serving the console.
  - Only registered hosts work. On staging that is the one `workers.dev` host. A console opened on an unregistered host, such as a version-preview URL, gets Google's `redirect_uri_mismatch` page instead of a silent wrong redirect.
- **Telegram-first owners do not regress.**
  - Same host: the compare makes it a no-op.
  - Different host: today's console connect already fails on the same-origin rule. After S1 it works, and the stored origin follows the host last used.
  - Their next Telegram update rewrites the origin to the webhook host (`:460`) without touching the webhook. Only an event-ingress or probe request on the generic path (`:1043-1052`) re-registers the bot webhook, and only when the hosts differ. App-origin writes (`:893`) already trigger that same behaviour today.
- **No surface compare**, so `guard-surface-neutral-core` stays at 58 for `owner-do.ts`.

Rejected:

- **Write at `/grant-console`.** That request's URL is the internal `https://telegram-owner/...`, so it would store the wrong origin, and it would never heal owners who already signed up.
- **The Worker sets `x-waldo-origin` and the DO reads it.** Two files for a fact the DO already holds. It also adds a header-read path that a future forwarder could leave client-controlled.
- **Pass `url.origin` into `connectUrl`/`googleApp` per call.** Begin-session and finish run on internal URLs, so the origin would have to be threaded through the ticket and consent records. That means a larger `owner-do.ts` diff, and the other origin readers stay broken.
- **Write only inside the `google.connect` branch.** Fixes one reader and leaves console links, export links, S4 chat connect and the calendar watch without an origin (AGENTS.md: fix the whole bug class).
- **Write only if absent.** Pins a console-only owner to the first host forever, and leaves the different-host Telegram owner on today's failure.
- **A code allowlist of hosts.** Production and staging differ, and AGENTS.md rejects env vars for non-secret config. The host trust is the same as for every other ingress.

### Changes, file by file

1. **`packages/runtime/src/channels/owner-do.ts`, `OwnerDO.console()`.** Insert after line 1379 (`if (!session) return new Response('Send /console to Waldo on Telegram for a sign-in link.', …)`) and before line 1380 (`/console/browser-handoff`). This is the exact diff I applied in the scratch copy:

   ```diff
   @@ -1379,2 +1379,4 @@ export class OwnerDO extends DurableObject<TelegramWebhookEnv> {
        if (!session) return new Response('Send /console to Waldo on Telegram for a sign-in link.', { status: 401, headers: overviewRoute ? DASHBOARD_OVERVIEW_HEADERS : undefined });
   +    // The Worker forwards console requests with the caller's own headers, so the public origin comes from the URL alone.
   +    if (this.ctx.storage.kv.get<string>('origin') !== url.origin) this.ctx.storage.kv.put('origin', url.origin);
        if (url.pathname === '/console/browser-handoff') return this.ownerBrowser.consoleHandoff(...);
   ```

   `url` is already `new URL(request.url)` at `:1362`. `kv.put` is synchronous, and the async `storage.get('origin')` readers see the same key; the existing tests mix both APIs on it (for example `whatsapp-owner-do-admission.test.ts:122`, `owner-do-google-profile.test.ts:113`).

2. **`packages/runtime/test/console-google-connect-origin.test.ts`, new.**
   - `vitest.config.ts` picks it up (`test/**/*.test.ts`, not excluded), so CI runs it through `verify:workers`.
   - It drives the real `handleConsole` forwarder into a real `OwnerDO`, starting from signup's actual `/grant-console` call.
   - It typechecks under `packages/runtime/tsconfig.json` (`tsc --noEmit` exit 0 in the scratch copy).
   - Paste as is:

   ```ts
   import { env, runInDurableObject } from 'cloudflare:test';
   import { expect, it, vi } from 'vitest';
   import { OwnerDO } from '../src/channels/owner-do';
   import { handleConsole } from '../src/channels/console-signin';
   import { BEGIN_SESSION_PATH, ticketHash } from '../src/channels/connect-link';
   import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
   import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
   import { GOOGLE_CALLBACK_PATH, readConsentState } from '../src/connectors/google';
   import { routerSignature } from '../src/identity/owner-directory';
   import type { ConsoleAuth } from '../src/identity/console-auth';

   vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

   const SECRET = 'fictional-console-connect-router-secret-000000', STATE_SECRET = 'fictional-console-connect-state-secret', DIRECTORY = 'https://console-connect.fixture.invalid';
   const ORIGIN = 'https://staging.fixture.invalid', HOSTILE = 'https://evil.fixture.invalid';
   const OWNER = '10000000-0000-0000-0000-000000000003';

   type Console = (path: string, init?: { form?: Record<string, string>; headers?: Record<string, string>; origin?: string; cookie?: string }) => Promise<Response>;
   type Fixture = Readonly<{ call: Console; issued: Record<string, string>[]; instance: OwnerDO; state: DurableObjectState; token: string; failIssue(): void }>;

   const fixture = async (opts: Readonly<{ google: boolean; storedOrigin?: string }>, run: (f: Fixture) => Promise<void>) => {
     const name = `console-connect-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
     await runInDurableObject(stub, async (_unused, state) => {
       const issued: Record<string, string>[] = []; let issueFails = false;
       const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
         const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body ?? '{}'));
         const fn = url.pathname.split('/').at(-1)!;
         if (fn === 'connect_session_issue') {
           if (issueFails) return new Response('unavailable', { status: 503 });
           expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `connsess.issue.${a.p_do_name}.${a.p_provider}.${a.p_channel}.${a.p_ticket_hash}`));
           issued.push(a); return Response.json('30000000-0000-0000-0000-000000000003');
         }
         if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: OWNER, do_name: name, state_version: 0, admission_revision: '1' } : null);
         if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'console-connect-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
         if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
         if (fn === 'google_connections' || fn === 'connections_list' || fn === 'console_session_list' || fn === 'health_log_recent') return Response.json([]);
         throw Error(`Unlisted fixture RPC ${fn}`);
       });
       const settings = { ...env, TELEGRAM_BOT_TOKEN: '123:synthetic', WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'console-connect-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined,
         TELEGRAM_WEBHOOK_SECRET: STATE_SECRET, GOOGLE_CLIENT_ID: opts.google ? 'fictional-client.apps.googleusercontent.com' : undefined, GOOGLE_CLIENT_SECRET: opts.google ? 'fictional-client-secret' : undefined };
       const instance = new OwnerDO(state, settings as never);
       if (opts.storedOrigin) state.storage.kv.put('origin', opts.storedOrigin);
       // Signup's only owner-DO call: the console grant, on the internal URL, with no origin header.
       const grant = await instance.fetch(new Request('https://telegram-owner/grant-console', { method: 'POST', headers: { 'x-waldo-do-name': name } }));
       expect(grant.status).toBe(200); const token = await grant.text();
       const owners = { idFromName: (n: string) => n, get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } as unknown as DurableObjectNamespace;
       const auth = { readOwnerCookie: async () => name } as unknown as ConsoleAuth;
       const call: Console = async (path, init = {}) => {
         const form = init.form ? new URLSearchParams(init.form) : undefined;
         const request = new Request(`${init.origin ?? ORIGIN}${path}`, { method: form ? 'POST' : 'GET', headers: { cookie: `waldo_owner=signed; waldo_console=${init.cookie ?? token}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...init.headers }, ...(form ? { body: form } : {}) });
         const response = await handleConsole(request, { OWNER_DO: owners } as never, auth);
         expect(response).not.toBeNull(); return response!;
       };
       try { await run({ call, issued, instance, state, token, failIssue: () => { issueFails = true; } }); } finally { fetcher.mockRestore(); }
     });
   };

   type Read = { csrf: string; revision: string; data: { google: { connectAvailable: boolean } } };
   const connections = async (call: Console, init?: Parameters<Console>[1]) => { const r = await call(`${CONTROLS_PATH}?view=connections`, init); expect(r.status).toBe(200); return r.json() as Promise<Read>; };
   const connect = (call: Console, read: Read, requestId: string, init?: Parameters<Console>[1]) =>
     call(CONTROL_ACTION_PATH, { ...init, form: { csrf: read.csrf, revision: read.revision, view: 'connections', action: 'google.connect', value: 'calendar', request_id: requestId } });

   it('a console-only owner (signup grant, then the dashboard) starts Google connect: a same-origin /c/ ticket whose consent returns to this host', async () => {
     await fixture({ google: true }, async ({ call, issued, instance, state }) => {
       expect(state.storage.kv.get('origin')).toBeUndefined();
       const read = await connections(call);
       expect(read.data.google.connectAvailable).toBe(true);
       const response = await connect(call, read, 'console-connect-0001');
       expect(response.status).toBe(200);
       const { receipt } = await response.json() as { receipt: { state: string; navigation?: string } };
       expect(receipt.state).toBe('recorded');
       expect(receipt.navigation).toMatch(/^\/c\/[A-Za-z0-9_-]{22}$/);
       expect(issued).toHaveLength(1);
       expect(issued[0]).toMatchObject({ p_provider: 'google', p_channel: 'console', p_ticket_hash: await ticketHash(receipt.navigation!.slice(3)) });
       expect(state.storage.kv.get('origin')).toBe(ORIGIN);
       const begun = await instance.fetch(new Request(`https://telegram-owner${BEGIN_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: issued[0]!.p_ticket_hash }) }));
       const consent = new URL((await begun.json() as { url: string }).url);
       expect(consent.origin).toBe('https://accounts.google.com');
       expect(consent.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`);
       expect((await readConsentState(STATE_SECRET, consent.searchParams.get('state')!))?.surface).toBe('dashboard');
     });
   });

   it('the origin comes from the request the Worker forwarded, never from a client-supplied origin header', async () => {
     await fixture({ google: true }, async ({ call, issued, instance, state }) => {
       const headers = { 'x-waldo-origin': HOSTILE, 'x-waldo-app-origin': HOSTILE, origin: HOSTILE, 'x-forwarded-host': 'evil.fixture.invalid' };
       const read = await connections(call, { headers });
       const { receipt } = await (await connect(call, read, 'console-connect-0002', { headers })).json() as { receipt: { state: string } };
       expect(receipt.state).toBe('recorded');
       expect(state.storage.kv.get('origin')).toBe(ORIGIN);
       const begun = await instance.fetch(new Request(`https://telegram-owner${BEGIN_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: issued[0]!.p_ticket_hash }) }));
       expect(new URL((await begun.json() as { url: string }).url).searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`);
     });
   });

   it('a request without a live console session cannot plant an origin', async () => {
     await fixture({ google: true }, async ({ call, state }) => {
       const response = await call(`${CONTROLS_PATH}?view=connections`, { cookie: 'not-a-session', origin: HOSTILE });
       expect(response.status).toBe(401);
       expect(state.storage.kv.get('origin')).toBeUndefined();
     });
   });

   it('an owner whose origin another surface recorded on this host keeps it and connects as before', async () => {
     await fixture({ google: true, storedOrigin: ORIGIN }, async ({ call, state }) => {
       const read = await connections(call);
       expect(state.storage.kv.get('origin')).toBe(ORIGIN);
       expect((await (await connect(call, read, 'console-connect-0003')).json() as { receipt: { state: string } }).receipt.state).toBe('recorded');
     });
   });

   it('an owner whose origin another host recorded connects from the console host, and the redirect follows that host', async () => {
     await fixture({ google: true, storedOrigin: 'https://telegram-host.fixture.invalid' }, async ({ call, issued, instance, state }) => {
       const read = await connections(call);
       expect(state.storage.kv.get('origin')).toBe(ORIGIN);
       const { receipt } = await (await connect(call, read, 'console-connect-0004')).json() as { receipt: { state: string; navigation?: string } };
       expect(receipt.state).toBe('recorded');
       const begun = await instance.fetch(new Request(`https://telegram-owner${BEGIN_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: issued[0]!.p_ticket_hash }) }));
       expect(new URL((await begun.json() as { url: string }).url).searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`);
     });
   });

   it('Google unconfigured: the button is unavailable and no ticket is issued', async () => {
     await fixture({ google: false }, async ({ call, issued }) => {
       const read = await connections(call);
       expect(read.data.google.connectAvailable).toBe(false);
       expect((await connect(call, read, 'console-connect-0005')).status).toBe(409);
       expect(issued).toHaveLength(0);
     });
   });

   it('a directory failure while issuing the ticket is an unconfirmed receipt with no destination', async () => {
     await fixture({ google: true }, async ({ call, issued, failIssue }) => {
       const read = await connections(call); failIssue();
       const response = await connect(call, read, 'console-connect-0006');
       expect(response.status).toBe(503);
       expect(await response.json()).toEqual({ duplicate: false, receipt: { state: 'unconfirmed', message: 'The outcome is not confirmed. Refresh the records before attempting another change.' } });
       expect(issued).toHaveLength(0);
     });
   });

   it('after sign-out the stale cookie can neither act nor move the origin', async () => {
     await fixture({ google: true }, async ({ call, state }) => {
       const read = await connections(call);
       const out = await call(CONTROL_ACTION_PATH, { form: { csrf: read.csrf, revision: read.revision, view: 'connections', action: 'session.signout', request_id: 'console-signout-0001' } });
       expect(out.status).toBe(200);
       expect((await connect(call, read, 'console-connect-0007', { origin: 'https://other.fixture.invalid' })).status).toBe(401);
       expect(state.storage.kv.get('origin')).toBe(ORIGIN);
     });
   });
   ```

3. **`packages/runtime/test/imessage-e2e.test.ts`, test at `:509`.** Insert after `await w.pairAndActivate();` (line 511). The premise is "an owner with no public origin on record". Pairing now goes through the console, which records one, so the test states the premise explicitly. The assertions stay unchanged. This is an in-branch failure class: the premise moved, the behaviour under test did not.

   ```ts
     // Pairing went through the console, which records the console's origin; this case is an owner with none on record.
     await runInDurableObject(w.ownerStub, (_i, state) => { state.storage.kv.delete('origin'); });
   ```

4. **`docs/planning/waldo-agent-mvp/ENGINEERING_FUNDAMENTALS.md`.** AGENTS.md requires a checklist line and a bug-log row in the same commit.
   - Under `### Trust boundaries` (lines 98-116), after line 106 (the connect-intent line), add:
     `- An owner ingress records the public origin only from the Worker-forwarded request URL, after its session or signature check: never from a client-supplied header, and never on an internal hop (https://telegram-owner/...). Every surface that can start a connect, including the console, records it.`
   - In `## Bug log`, after the header row at line 149, add this row, with `<landing date>` replaced by the day it merges:
     `| <landing date> | Console-only owners could not start Google connect: the console path returned before any origin write, so connectUrl and googleApp had no origin and the receipt said "Google connect could not start" | Trust boundaries | console-google-connect-origin.test.ts: fresh signup-grant owner connects through handleConsole; hostile origin headers, sessionless and signed-out requests cannot set it; imessage-e2e no-origin case states its premise | Ingress origin line under Trust boundaries |`

No change to `console-signin.ts`, `console-signup.ts`, contracts, the SPA, migrations or `wrangler.jsonc`.

### UI and copy

S1 adds no UI and no copy. These existing strings now appear for a console-only owner, verbatim and unchanged:

- **Settings › Connections receipt after Connect Google** (`Controls.tsx:111-117`, message from `dashboard-control-actions.ts:26`):
  - Heading: "Receipt recorded."
  - Body: "Google connect is ready to begin. Access has not been granted or tested."
  - Link: "Continue to Google". Same tab, `/c/<ticket>`.
- **Before S1** the owner saw "Change not applied." and "Google connect could not start. Try again." After S1 that string appears only when Google is configured but ticket issue returns no link.
- **Callback page** (`google-oauth.ts:35`): "Google is connected", the account email, "Google access was saved. This does not confirm a live Calendar or Gmail read yet. Try a request in chat to check it. You can close this tab.", and the button "Back to your console".
  - Copy drift, not fixed here: the runtime now checks one live read before "linked" (`owner-do.ts:2448-2457`), and a console-only owner has no chat until S4. The page copy and the "Google blocked you" help belong to S3/S4.
- **Connections row:** the account email plus "Access granted · read unverified" (`Controls.tsx:79`).

### Security, privacy and authority

- **Authentication:**
  - The Worker requires a valid signed owner cookie before forwarding (`console-signin.ts:339-349`).
  - The write sits after the DO-local console session check (`owner-do.ts:1378-1379`). Missing, expired and signed-out sessions return 401 first. The tests cover sessionless and signed-out requests.
- **Source of the value:** only `new URL(request.url).origin` of the forwarded request. The code never reads `x-waldo-origin`, `x-waldo-app-origin`, `Origin`, `Referer` or `X-Forwarded-*` on this path. The hostile test sends `x-waldo-origin`, `x-waldo-app-origin`, `Origin` and `X-Forwarded-Host` and asserts the stored value and the Google `redirect_uri`.
- **Host trust:** Cloudflare delivers requests to this Worker only on its hostnames, the same trust every other ingress already places in `request.url` [inference]. With no custom routes, that is the `workers.dev` host plus any version-preview host, which is UNVERIFIED.
- **CSRF:** no new endpoint or action. The write also happens on authenticated GETs. SameSite=Strict console cookies (`console-signin.ts:297`) keep cross-site pages from driving it, and the only value it can write is a hostname that reached this Worker.
- **Rate limits:** unchanged. Controls allow 90 reads and 20 actions per minute per owner (`owner-do.ts:1469-1472`). No new route.
- **Stored data:** one existing owner-object KV key, `origin`, holding a URL origin. No PII, health data, token or ticket.
  - No new logging; the existing connect hops log only an 8-character hash prefix (`owner-do.ts:2428`, `connect-link.ts:22`).
  - The ticket, consent URL, OAuth code and state must never be logged.
- **Health:** none touched. `guard-health-leak` was run on the repo at HEAD: ok.
- **Authority:** connecting Google stays an explicit owner click plus Google consent. S1 grants nothing; it only lets the existing flow start.
- **Security review trigger: yes.** The change sets the OAuth redirect URI for console owners and the host of every owner-delivered link (AGENTS.md "auth flows"). Ask one `security-reviewer` pass scoped to: the write position, the header-spoofing test, preview-host behaviour and the Telegram-first host flip.

### Tests

All tests sit in `packages/runtime/test/console-google-connect-origin.test.ts` unless named otherwise. They run through the real `handleConsole` → `OwnerDO.fetch` → `console()` path.

| Kind | Case | Setup | Action | Assert | RED at `04bb8c89` |
|---|---|---|---|---|---|
| Golden | Console-only owner connects | `/grant-console` only, no origin | Connections read, then `google.connect` | Origin unset first; then 200 `recorded`; navigation `/c/<22>`; one `connect_session_issue` with `p_channel:'console'` and a matching ticket hash; origin = request host; begin-session consent URL on `accounts.google.com` with `redirect_uri` = `https://staging.fixture.invalid/oauth/google/callback` and signed surface `dashboard` | Yes (409 `rejected`) |
| Hostile | Spoofed origin headers | Same | Read and act with `x-waldo-origin`, `x-waldo-app-origin`, `Origin`, `X-Forwarded-Host` = evil | Stored origin and `redirect_uri` use the request host, never evil | Yes |
| Hostile / null | Sessionless request | Same | Read with a bogus console cookie on the evil host | 401; origin unset | No (guard) |
| Regression | Telegram-first owner, same host | Origin preset to the request host | Read, connect | Origin unchanged; `recorded` | No (guard; also proves the demo workaround) |
| Regression | Telegram-first owner, other host | Origin preset to another host | Read, connect | Origin follows the console host; `recorded`; `redirect_uri` on the console host | Yes |
| Null / empty | Google unconfigured | No client id or secret | Read, connect | `connectAvailable:false`; 409; no ticket | No (guard) |
| Network failure | Directory RPC down at ticket issue | `connect_session_issue` → 503 | Connect | 503 `unconfirmed` with "The outcome is not confirmed. Refresh the records before attempting another change."; no navigation; no ticket | Yes (409 at base: no origin, so no RPC) |
| Revoked | Signed-out session | Read, then `session.signout` | Connect with the old cookie on another host | 401; origin still the first host | Yes (origin was never set at base) |
| Premise | `imessage-e2e.test.ts:509` | `pairAndActivate`, then delete `origin` | Unchanged | Unchanged | Fails with S1 unless the premise line is added |

Scratch runs, all on the `04bb8c89` code tree (locally run, not CI):
- **New test file:**
  - Without the `owner-do.ts` change: 5 failed and 3 passed. The three that pass are the guards: sessionless, same host and unconfigured.
  - With the change: 8/8 pass.
- **`vitest.imessage.config.ts`:**
  - With the change but without the premise lines: 1 failed of 45.
  - With both: 45/45.
- **Regression sweep with the change:**
  - The 48 default-config test files that touch console, dashboard or Worker routes: 501/501.
    - Two asset tests (`console-entry`, `dashboard-static-worker`) first failed only because the scratch copy lacked the gitignored `packages/dashboard-app/dist`. With `dist` copied in, they pass.
  - `vitest.console-ticket.config.ts`: 13/13. `vitest.link-routing.config.ts`: 37/37. `vitest.devices.config.ts`: 4/4.
- **Typecheck and guards:**
  - `tsc --noEmit` in `packages/runtime`: exit 0. It includes `test/`.
  - `guard-surface-neutral-core`: ok, 101 compares in 13 files.
- **NOT RUN:** the full default suite. I stopped it after 15 minutes, while another session's vitest was running on the same machine. The implementer runs it as `verify:workers`.

Suites:
- The new file and the default suite: `pnpm verify:workers` (CI).
- The iMessage premise: `pnpm --filter @waldo/runtime test:owner-ingress`, part of `pnpm verify`.

### Acceptance trace

Claims so far:
- SOURCE: the fix and the root cause, as cited above.
- CI: the new file and the iMessage premise, once the PR runs.
- STAGING: none yet. Nothing has been deployed or probed from this planning session.

**STAGING trace**, after the owner deploys a SHA containing S1 (S0):

1. As admin on `https://waldo-runtime-staging.piyushfulper3210.workers.dev/console#/admin`, issue an invite for an email whose Google account is on the OAuth test-user list.
2. In a fresh browser profile, open the invite link, sign up with the email code, and land on `/console`.
   - Do not link Telegram.
   - Do not open the iPhone app as this account.
3. Open Settings › Connections. You see **Connect Google**.
4. Click it.
   - Must see: "Receipt recorded." / "Google connect is ready to begin. Access has not been granted or tested." / **Continue to Google**.
   - Fail: "Change not applied." / "Google connect could not start. Try again."
5. Click **Continue to Google**. The browser is on `accounts.google.com`, and the address bar's `redirect_uri` parameter is `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback`.
6. Consent with the listed account. The callback page shows "Google is connected", the email, and **Back to your console**.
7. Return to Connections. The account email shows with "Access granted · read unverified".
8. In `wrangler tail` (operator), for that owner you see these hops in order:
   - `connect_issued` ok
   - `connect_link` ok
   - `connect_begin` ok:true
   - `oauth_exchange` ok
   - `oauth_callback` ok, detail `linked`
   - `google_linked`
   - `connect_completed` ok
   - `google_linked_notice` failing with `send_failed` is expected for a console-only owner.
9. Regression check: as a Telegram-first owner (the founder account), open the console on the same host and connect, or add a second Google account. It must be `recorded`. A later Telegram connect link still opens on the same host.

**Screenshots:** staging only.
- Capture `s1-staging-desktop-connections-receipt.png` (1440x900) and `s1-staging-phone-connections-receipt.png` (390x844) at step 4, and `s1-staging-callback.png` at step 6.
- Keep the visitor email out of the frame, or use a test account.
- The local preview (`packages/dashboard-app/scripts/preview.mjs`) serves synthetic fixtures with no owner object, so it cannot exercise this path.

LIVE (owner action): the Google Cloud redirect URI and test-user list (S0).

### Verification commands

Run from `/home/user/waldo-backend`, in order:

```bash
git diff --check
# RED first: add the test file, run it before the owner-do.ts change (expect 5 failed / 3 passed)
npx -y pnpm@10.34.4 --filter @waldo/runtime exec vitest run test/console-google-connect-origin.test.ts
# apply the owner-do.ts lines and the imessage premise line, then GREEN:
npx -y pnpm@10.34.4 --filter @waldo/runtime exec vitest run test/console-google-connect-origin.test.ts
npx -y pnpm@10.34.4 --filter @waldo/runtime exec vitest run --config vitest.imessage.config.ts
npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck
WALDO_DO_MIGRATION_BASE_REF=HEAD^1 npx -y pnpm@10.34.4 verify:guards   # origin/main is absent locally
npx -y pnpm@10.34.4 verify:workers
npx -y pnpm@10.34.4 --filter @waldo/runtime test:owner-ingress
npx -y pnpm@10.34.4 verify   # full wall: verify:supabase and verify:supabase:session-revocation need Docker/Supabase -> UNAVAILABLE in the cloud container; record them so
git status --short           # vitest must leave no tracked changes
```

Record PASS, FAIL, NOT RUN and UNAVAILABLE separately, at the exact head SHA. CI runs the Supabase parts.

### Rollback

- Revert the commit: two source lines, one test file, two test premise lines and two doc lines. Redeploy the previous staging Worker version with the S0 rollback command.
- No migration and no contract change.
- Origins that S1 wrote stay in owner objects. They hold the same kind of value the other ingress paths write, so leaving them is harmless. After a revert, owners who already have one can still connect; new console-only owners return to "could not start".

### Risks and open questions

- **Not in the demo pin** (freeze on #1103). Default: run the demo-day workaround above on an operator account, and have visitors skip Google (S0 fallbacks). Ask Ansh before the pin whether S1 joins; it is the highest-leverage slice for web visitors.
- **Second host** (a Cloudflare version-preview URL, or a future custom domain). The stored origin follows it, and Google refuses an unregistered redirect with `redirect_uri_mismatch`. Default: issue invites and open the console only on the one registered staging host (S0). Register any new host in Google Cloud before use.
- **Host flip for owners who use two hosts.** Telegram links and the Google redirect follow the last host used. An event-ingress or probe request on the generic path then re-registers the bot webhook to its own (live) host. Default: accept. It is the existing app-path behaviour, and staging has one host.
- **The console controls read depends on Telegram secrets.** It needs `TELEGRAM_BOT_TOKEN` (`owner-do.ts:1481,2121`) and `TELEGRAM_WEBHOOK_SECRET` (OAuth state key). Default: unchanged; staging has both [inference]. A deployment without them cannot run console connect, with or without S1.
- **Web-only owners get no post-connect push.** The "Google is connected" notice is Telegram-only, and console-only owners get no scheduled pass, so no calendar watch or Brief either (`owner-do.ts:1716-1733`) [inference]. Default: S3 polls Connections for the result; S4's console chat may bind the owner to the app chain.

### Effort

**S**, about 2 hours. That covers 30 minutes of code and tests already proven in a scratch copy, the full verify wall (the default runtime suite is long) and one security review.

Lanes:
- `owner-do.ts` (Mac lane, 2 lines)
- runtime tests (one new file, two lines in `imessage-e2e.test.ts`)
- one docs file

No SPA work and no migrations.

## S2 Sign-up and sign-in in Waldo's design, landing on #/welcome

### Outcome

A visitor opens their invite link and sees a page that looks like the console they are about to enter: warm canvas, a white card, Waldo's mark, plain words, no internals. Before pressing anything, they read what Waldo keeps and where it is kept. On a test server, they also read what is recorded. They confirm they are 18 or over, get a code, confirm their email and press **Set up my Waldo**. They land on `/console#/welcome`, where S3's welcome flow takes over.

A returning owner signs in on a matching page that asks only for an email. An invitee who goes to sign-in by mistake is told to use their invite link, and no code is spent. A sign-in or verify POST from another site is refused before anything is read, which closes login CSRF on the email-code door.

Every existing security property is kept: the nonce CSP, the Origin check, the signed progress cookie, CSRF, the throttles, non-enumeration and the honest copy when a result is uncertain.

JTBD: "let me into my Waldo without making me wonder what I just signed up for."

### Depends on / blocks

**Base.** All anchors are at `a643bcab`, which is `beta-mvp` `04bb8c89` merged into this branch.
- #1241 (Mac seamless pairing, merged) changed `console-signin.ts`. S2 builds on #1241's return-target seam and does not fork it. `consoleReturnTarget`, the devices note (keep the words "pair your Mac", which #1241's test asserts) and the client script's redirect allowlist stay exactly as they are.
- [verified] `console-signup.ts`, `identity/console-signup.ts`, `identity/console-auth.ts`, `dashboard-static.ts` and `index.ts` are unchanged since `e5c022ef`. `identity/owner-directory.ts` changed in `fea48136`, which does not affect S2.

**Merge order:** S1 → S3 → **S2** → S5a → S6; S4 → S5b.
- S2's 303 to `/console#/welcome` needs S3's `welcome` route. Today the SPA resolves `welcome` to `not-found` [verified `packages/dashboard-app/src/App.tsx:36`].
- Before merging, the reviewer checks that `resolveRoute('welcome') !== 'not-found'` on the base.

**Demo freeze.** Ansh froze merges on #1103 at 19:27Z. Only #1258, headroom, #1259, #1261 and #1227/#1240 merge before the showcase. **S2 lands after the demo unless Ansh adds it.** If it is not added, the showcase runs on today's pages, and S0 briefs the presenter: visitors use the invite link only and never type an invite into sign-in.

**#1063 (Ashish, draft).** S2 supersedes #1063's sign-in and sign-up changes.
- S2 uses its own module, `channels/pre-auth-page.ts`. It does not reuse #1063's `standalone-page.ts` name or API.
- S2 keeps its replacement of `no-referrer`: both pages move to `same-origin` plus CSP.
- #1063's other pages (invites, OAuth callback, devices and the rest) can adopt the shell later.
- The S2 author comments on #1063 before opening the PR. The comment asks Ashish to drop #1063's sign-in and sign-up hunks, and states that any later shell must keep `referrer-policy: same-origin` and the CSP on `/console/signin` and `/console/signup`. Credit #1063 in the PR body, not in code.

**Before merge (operator checks; S0 hosts them):**
- **(a) Origin falsifier for other browsers.** Complete one invite sign-up on today's staging in iPhone Safari and one in desktop Firefox. Today's sign-up already pairs `same-origin` with the same Origin check on the real host (`console-signup.ts:19,47`). A pass shows those browsers send a matching Origin. A 403 means S2 does not merge.
- **(b) Privacy and terms pages.** Open `https://www.heywaldo.in/privacy` and `/terms`, and record whether each describes the processing.
- **(c) Code delivery.** A brand-new email receives a code (the template check).

**Owner decision (S0 R6).** Whether staging text capture stays on. The page's testing notice follows that setting automatically (see Risks).

**Security review** (`security-reviewer`) is mandatory: S2 changes an auth flow, CSRF and CSP.

**Lane:** runtime only, not `owner-do.ts`. No SPA, migration or env var changes.

### Current state

[verified at `a643bcab` unless marked]

**Sign-up page** (`packages/runtime/src/channels/console-signup.ts`)
- Server HTML with an inline system-ui sheet (`:13`) and an all-caps `WALDO · INVITE SIGNUP` eyebrow (`:18`).
- Nonce CSP: `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, with `referrer-policy: same-origin` (`:19-20`).
- The copy shows internals: "can create a Supabase Auth identity…" (`:25`), and "Temporary progress is a readable signed cookie…" (`:28`).
- POSTs are refused unless `Origin` equals `url.origin` (`:47`).
- The entry form needs a 20-character invite (`:56`).
- Completion is a 303 to `CONSOLE_PATH` (`/console`) (`:120`). It sets `waldo_console` and `waldo_owner` (`:121-124`).
- Forms are native POSTs. The two scripts only read the fragment for `email` and `invite` (`:14-15`). No client code inspects a redirect, so nothing on this page can reject `#/welcome`.
- Code eligibility is `signin_allowed`, which admits an email with a matching invite **or** an active member (`identity/console-signup.ts:33-35`).
- The page has no 18+ step and no privacy line.

**Sign-in page** (`console-signin.ts`)
- Inline sheet, no CSP, and `referrer-policy: no-referrer` (`:166`).
- The form shows "Invite code (optional for existing members)" and "Phone … (optional, contact only, unverified)" fields (`:176`).
- **The trap.** The invite goes to `auth.sendCode(email, invite)` (`:233`), so an invitee gets a code. But `verify` resolves only existing owners: `join=false` (`identity/console-auth.ts:143`). `owner_for_auth` returns null for an empty phone before it would spend an invite (`supabase/migrations/20260928190000_waldo_invite_chain.sql:39`). The invitee burns a code and reads "That code did not work" (`:284`).
- The phone is dead input. It is validated (`:206`, `:249`) and round-tripped (`:178`), but `verify` ignores it (`console-auth.ts:143` `_phone`). `normalizePhone` (`:170`) has no other caller.
- **Login CSRF.** Neither POST checks Origin or a token: `/console/signin` (`:196`) and `/console/verify` (`:241`).
- The client script (`:43-164`) submits by `fetch(… mode:'same-origin')`. It renders each response by `new DOMParser().parseFromString(html)` (`:122`). On a non-OK response it shows "Could not confirm the result…" (`:48`, `:119`). It navigates only for a redirect to `/console`, or to `/console/devices` when that was the requested `return_to`, with no search and no hash (`:111-114`).

**Browser facts** [verified locally in Chromium 141 with Playwright on `http://127.0.0.1`; WebKit and Firefox are not installed here]
- A form POST answered by `303 Location: /console#/welcome` lands with `location.hash === '#/welcome'`.
- `fetch` drops the fragment from `response.url`. So sign-in keeps `Location: /console`, and `#/welcome` is only used on sign-up's native navigation.
- A native same-origin form POST sends:
  - `Origin: null` under `no-referrer`;
  - the real origin under `same-origin`.
- A `fetch` POST sent the real origin under both policies in Chromium.
- So an Origin check on sign-in without a referrer-policy change would refuse no-script submissions. The same bug was found and fixed on sign-up (`docs/planning/waldo-agent-mvp/ENGINEERING_FUNDAMENTALS.md:254,260`).
- A document built by `DOMParser` on a page with a nonce CSP reports "Refused to apply inline style" when its `<style>` carries a different nonce. With a hash source that matches the CSS, it reports nothing. A per-response style nonce on sign-in would therefore log a CSP error on every script-driven step.

**Other facts**
- `dashboard-static.ts:21-44` serves `/console` to an owner whose overview read passes. On 401 it sends a 303 to `/console/signin`. The fragment never reaches the server.
- `guard-health-leak` blocks `font-weight:600` in a TS string. Confirmed on a scratch file; commit `ebb070a5` was fixed for the same reason.
- `resolveCaptureText(env)` (`observability/trace-privacy.ts:65-66`) is the single switch for model-text capture. It is true on staging (`wrangler.jsonc:87`) and never in production.
- With capture on, these are exported to Langfuse:
  - the full model input: system prompt, memory, history and tool turns (`channels/owner-turn.ts:245,263`; `observability/otlp-turns.ts:109,120`);
  - tool outputs, including Gmail, Calendar and Drive reads, since the staging MCP servers are on (`wrangler.jsonc:87`);
  - the sign-up email (`trace-privacy.ts:35-38`).
- The only 18+ record that exists is `waldo.health_consents.age_attested_18_plus`, for app health grants (`supabase/migrations/20261011000000_health_plane.sql:14`).
- The app join door creates owners from the same invite with no age field: `/app/v1/auth/code` then `/auth/verify` → `verifyOrJoin` (`channels/app-api.ts:121,135`; `packages/contracts/src/app/core.ts:39,41`).
- Settings › Account exists (`dashboard-app/src/Settings.tsx:9`) with "Delete your Waldo account" (`OwnerControls.tsx:76`). There is no data export.
- The Telegram ticket redeem (`POST /console` with `t`, `index.ts:145-169`) also mints a session by POST, with no Origin check, from a `no-referrer` page (`channels/console.ts:99-101`).

**POST callers that will be refused until they send Origin:**
- `packages/runtime/scripts/device-bridge-local-harness.mjs:168`
- `test/fixtures/console-signin-server.ts:37-40` (rebuilds the browser request without Origin)
- `test/owner-do-registered-workspace.test.ts:457,461`
- the `form()` helper (`:86`) and the hand-built requests (`:317`, `:333`, `:477`) in `test/console-signin.test.ts`

**Baseline:**
- `console-signup*.test.ts` + `console-signin.test.ts`: 4 files, 109 tests PASS (Workers pool).
- `console-signin-browser.test.ts`: 24 PASS.
- `guard-health-leak`: ok.

### Design

**Shell.** Add one small module, `channels/pre-auth-page.ts`, used by both pages. It provides a card layout, the console tokens (`dashboard-app/src/style.css`) and the spots mark (identical to `dashboard-app/src/icons.tsx:45-53`).

Corrections to the console tokens, from the design system:
- Text greys `#5e5e5b` and `#6f6e69`: 5.86:1 and 4.60:1 on the canvas, 6.51:1 and 5.11:1 on the card.
- Spot (`#fb943f`) appears once, as a two-tone focus ring. Orange alone is 2.01:1 against the canvas, so an ink ring (15.7:1) carries the contrast.
- No eyebrow, and no numeric font weights.

**Fonts.** System stack only, the console's own `--font`, with `font-src` left at `'none'`. Mottle (171 KB) would need a `data:` font on every pre-auth response, or a new public font asset against the dashboard's two-file asset rule. The first Mottle moment is S3's welcome inside the SPA, where Mottle is already inlined.

**CSP per page**
- **Sign-up** keeps its current header, byte-identical.
- **Sign-in** uses `style-src '<sha256 of the card CSS>'` instead of a nonce, because its script parses each fetched response with `DOMParser`. Scripts keep a per-response nonce; parsed scripts never run. `connect-src 'self'` allows the script's own `fetch`.
- Both pages use `referrer-policy: same-origin`.

**Sign-up behaviour**
- Same state machine, cookie format and checks.
- New copy.
- A required 18+ attestation, checked on `/send` before any RPC. It is not recorded.
- A plain line about what is stored, where, and how to delete it.
- A testing notice, rendered from `resolveCaptureText(env)` and placed above the button.
- Completion is a 303 to `/console#/welcome`.

**Sign-in behaviour**
- Drop the invite and phone fields and stop reading them. Sign-in can then never send a code to a non-member. It tells new people to use their invite link.
- Origin check on both POSTs before the form is read, mirroring `console-signup.ts:47`.
- The script moves into a constant, byte-identical, with #1241's checks intact.

**Rejected**
- **Reuse or port #1063's `standalone-page.ts`.** Its API and headers differ (`no-referrer`, no CSP). Sharing the name would guarantee an add/add conflict and invite a rebase that undoes the Origin pairing.
- **Route a typed invite from sign-in to sign-up.** That adds a second admission path, when the link already pre-fills sign-up.
- **Mottle as a data URI.** About 228 KB on every pre-auth response.
- **Orange-only focus ring.** Fails contrast.
- **Nonce styles on sign-in.** CSP errors on every `DOMParser` step.
- **Client-only 18+ check.** Not a gate.
- **Keep `no-referrer` on sign-in.** It sends `Origin: null`.
- **Route `#/welcome` through sign-in's fetch.** The fragment is dropped.
- **Only a privacy link.** The pages are unverified, and a link alone states nothing in the page.

### Changes, file by file

**1. `packages/runtime/src/channels/pre-auth-page.ts` (new)** [proposed]

An earlier render of this CSS on a mock (scripts not exercised) showed no CSP errors and no horizontal scroll at 1440, 390 and 320 px, and passed `guard-health-leak`. The script flow is proven by the Acceptance run, not by that mock.

```ts
// The shell for the Worker-rendered pages a person sees before the console opens: the console's own
// tokens with the design system's text greys. Presentation and headers only; callers own status, forms,
// copy and every check. Weights use the `font` shorthand because guard-health-leak reads a numeric font
// weight declaration as a body-weight value.
export const WAITLIST_URL = 'https://www.heywaldo.in/waitlist';
export const PRIVACY_URL = 'https://www.heywaldo.in/privacy';
export const TERMS_URL = 'https://www.heywaldo.in/terms';
const SPOTS = [/* the 7 path strings from packages/dashboard-app/src/icons.tsx:46-52, verbatim */];
const MARK = `<svg class="mark" width="18" height="16" viewBox="0 0 23 20" fill="currentColor" aria-hidden="true" focusable="false">${SPOTS.map(d => `<path d="${d}"/>`).join('')}</svg>`;
export const PRE_AUTH_CSS = `:root{--canvas:#f4f3f0;--tile:#fff;--ink:#1a1a1a;--on-ink:#fff;--t2:#5e5e5b;--t3:#6f6e69;--hair:rgba(26,26,26,.08);--hair-strong:rgba(26,26,26,.16);--fill:rgba(26,26,26,.04);--fill-2:rgba(26,26,26,.07);--spot:#fb943f;--alert-soft:rgba(244,63,94,.1);--r-card:20px;--r-inner:12px;--ease:cubic-bezier(.22,1,.36,1);--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro',system-ui,'Segoe UI',sans-serif;color:var(--ink);background:var(--canvas)}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--canvas);font:400 16px/1.45 var(--font);-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
.frame{max-width:456px;margin:0 auto;padding:48px 16px 56px}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 20px 8px;font:500 16px/1 var(--font);letter-spacing:-.01em}
main{display:grid;gap:16px;background:var(--tile);border-radius:var(--r-card);box-shadow:0 0 0 .5px var(--hair);padding:32px 28px}
h1{margin:0;font:600 28px/1.15 var(--font);letter-spacing:-.025em}
p{margin:0;color:var(--t2)} strong{font:inherit;color:var(--ink)} .help{font-size:13.5px;color:var(--t3)}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair-strong);text-underline-offset:3px} a:hover{text-decoration-color:var(--ink)}
form{display:grid;gap:8px;margin:0} form+form{margin-top:-4px}
label{font:500 14px/1.3 var(--font);color:var(--ink);margin-top:6px}
input:not([type=checkbox]):not([type=hidden]){font:400 16px/1.3 var(--font);color:var(--ink);width:100%;min-height:48px;padding:11px 14px;border:0;border-radius:var(--r-inner);background:var(--fill);box-shadow:inset 0 0 0 .5px var(--hair-strong)}
input:not([type=checkbox]):focus{box-shadow:inset 0 0 0 1px var(--ink)}
.check{display:flex;align-items:flex-start;gap:10px;margin:8px 0 2px;font:400 15px/1.4 var(--font)} .check input{flex:none;width:20px;height:20px;margin:1px 0 0;accent-color:var(--ink)}
button,.button-link{font:500 15px/1.2 var(--font);cursor:pointer;display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin-top:8px;padding:12px 20px;border:0;border-radius:999px;background:var(--fill-2);color:var(--ink);text-decoration:none;transition:background-color .16s var(--ease),transform .16s var(--ease)}
button:hover:not(:disabled){background:rgba(26,26,26,.11)} button:active:not(:disabled){transform:scale(.97)}
button.primary,.button-link{background:var(--ink);color:var(--on-ink)} button.primary:hover:not(:disabled),.button-link:hover{background:#333331}
button:disabled{opacity:.4;cursor:wait}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;box-shadow:0 0 0 2px var(--spot)}
.note{padding:12px 14px;border-radius:var(--r-inner);background:var(--fill-2);color:var(--ink);font-size:14.5px} .note.alert{background:var(--alert-soft)}
.visually-hidden,#signin-progress:empty{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:480px){.frame{padding:20px 16px 32px}main{padding:24px 18px}h1{font-size:26px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;
// sha256 of PRE_AUTH_CSS. The pin test in pre-auth-copy.test.ts fails with the correct value whenever the CSS changes.
export const PRE_AUTH_STYLE_HASH = 'sha256-…';
const esc = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
export type PreAuthPage = Readonly<{ title: string; body: string; nonce: string; script?: string }>;
// Every value interpolated into `body` must already be escaped. The <style> content must stay exactly PRE_AUTH_CSS.
export const preAuthPage = ({ title, body, nonce, script = '' }: PreAuthPage): string =>
  `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#f4f3f0"><title>${esc(title)}</title><style nonce="${nonce}">${PRE_AUTH_CSS}</style></head><body><div class="frame"><header class="brand">${MARK}<span>Waldo</span></header><main>${body}</main></div>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
// Same-origin referrers keep a real Origin on native form POSTs (no-referrer sends Origin: null);
// both pre-auth Origin checks depend on it.
const headers = (csp: string): Record<string, string> => ({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'content-security-policy': csp });
export const signupHeaders = (nonce: string) => headers(`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
// Sign-in parses each fetched response with DOMParser, which applies this page's CSP to the parsed
// <style>; a per-response nonce would be refused there, the stable CSS hash is not.
export const signinHeaders = (nonce: string) => headers(`default-src 'none'; script-src 'nonce-${nonce}'; style-src '${PRE_AUTH_STYLE_HASH}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
export const newTab = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}<span class="visually-hidden"> (opens in a new tab)</span></a>`;
```

`signupHeaders` is byte-identical to today's sign-up header (`console-signup.ts:19-20`).

`WAITLIST_URL` deliberately duplicates S3's `IPHONE_WAITLIST_URL` in `packages/dashboard-app/src/links.ts`, because dashboard-app has no workspace dependency. Each package pins the literal in a test.

**2. `packages/runtime/src/channels/console-signup.ts`**

Use `’` (U+2019) in copy, as the console does (`App.tsx:78`). Verbatim strings are in UI and copy.

- **Imports.** Add `preAuthPage, signupHeaders, newTab, PRIVACY_URL, TERMS_URL` from `./pre-auth-page`, and `resolveCaptureText` from `../observability/trace-privacy`.
- **New constant.** `export const CONSOLE_WELCOME_LOCATION = \`${CONSOLE_PATH}#/welcome\`;`
- **`:10-12`.** Replace `unavailableInvite`, `unavailableCompletion` and `unavailable`. Add `adultRequired`, `badFields` and `resent`.
- **`:13`, `:16-22`.** Delete `css`. Change `page(body, status, script)` to:
  ```ts
  const nonce = crypto.randomUUID();
  return new Response(preAuthPage({ title: 'Join Waldo', body, nonce, script }), { status, headers: signupHeaders(nonce) });
  ```
- **`:23`.** Change `note` to:
  ```ts
  const note = (text: string, tone: 'alert' | 'status' = 'alert') => text ? `<p class="note${tone === 'alert' ? ' alert' : ''}" role="${tone}">${esc(text)}</p>` : '';
  ```
- **`:25` `entry`.** Becomes `entry(text = '', email = '', adult = false, testing = false)`, with the markup from UI and copy.
  - The `email` and `invite` ids and attributes are unchanged, so `entryScript` still fills them.
  - Order: the testing notice (when `testing`), then the 18+ checkbox `<label class="check" for="adult"><input id="adult" name="adult" type="checkbox" value="yes" required${adult ? ' checked' : ''}><span>…</span></label>`, then the button. The notice is a sibling `<p class="note">`, not inside the label.
- **`:27` `otp(p, text = '', tone = 'alert')`.** New markup. Same ids and forms. Drop the `<ol>`.
- **`:28` `finish`.** New markup. Same form and `restartScript`.
- **Inside `handleSignup`.** Add:
  ```ts
  const testing = resolveCaptureText(env);
  const showEntry = (text = '', email = '', adult = false) => entry(text, email, adult, testing);
  ```
  Use `showEntry` at `:42`, `:50`, `:53`, `:56` and `:78`.
- **`SignupEnv` (`:35`).** Add `LANGFUSE_CAPTURE_TEXT?: string; WALDO_ENVIRONMENT?: string`. These arrive from the Worker env through `handleConsole`, unchanged.
- **`:42`.** Replace the throttled and unconfirmed notes.
- **`:46-47`.** Both refusals become `page('<h1>Open your invite link to continue.</h1>', 405 | 403)`. Before the 403, add `consoleLog(trace, 'console_signup', false, 'cross_origin')`.
- **`:56`.** Keep the check, returning `showEntry(badFields, email, form.get('adult') === 'yes')`. Directly after it, and before `begin`, throttles or any RPC, add:
  ```ts
  if (action === '/send' && form.get('adult') !== 'yes') { consoleLog(trace, 'console_signup', false, 'age_unconfirmed'); return showEntry(adultRequired, email); }
  ```
- **`:57`.** Replace the message with "Confirm your email first…".
- **`:74`.** Replace the `retry('Too many attempts…')` string.
- **`:88`.** `return otp(progress!, resent, 'status');` (`:58` already guarantees the progress is unverified).
- **`:92`.** New empty-code message.
- **`:120`.** `location: CONSOLE_WELCOME_LOCATION`.
- **`:129`.** New uncertain-completion message.
- **Leave alone:** the crafted-POST-only phone message at `:98`, and `identity/console-signup.ts`. `SignupProgress` is unchanged, so an in-flight sign-up survives deploy and rollback.

**3. `packages/runtime/src/channels/console-signin.ts`** (on top of #1241)

- **Imports.** Add `preAuthPage, signinHeaders, newTab, WAITLIST_URL` from `./pre-auth-page`.
- **`:41-167`.** Move the script body (`:43-164`) unchanged into `const SIGNIN_SCRIPT = \`…\`;`, declared after `consoleReturnTarget` (it interpolates `CONSOLE_DEVICES_PATH` and `DOWNLOAD_RETURN_PATTERN`). Then:
  ```ts
  const page = (body: string, status = 200) => {
    const nonce = crypto.randomUUID();
    return new Response(preAuthPage({ title: 'Sign in to Waldo', nonce, script: SIGNIN_SCRIPT, body: `${body}<p id="signin-progress" role="status" aria-live="polite"></p><button id="signin-cancel" type="button" hidden>Stop waiting</button>` }), { status, headers: signinHeaders(nonce) });
  };
  ```
  This removes `:166` (`no-referrer`).
- **Delete** `normalizePhone` with its comment (`:168-173`) and `SigninDetails` (`:175`).
- **`:176` `signinEmailForm(note = '', email = '', target = null)`.** In order:
  - the continuation note: #1241's devices sentence or the existing download sentence, verbatim, in `<p class="note" role="status">`;
  - `<h1>` and lede;
  - `note alert`;
  - the form, which keeps `return_to`, `<label for="signin-email">` and `<input id="signin-email" name="email" value="…"` in that attribute order, plus the primary button;
  - the help line with `<a href="${CONSOLE_SIGNUP_PATH}">enter your invite code</a>` and `${newTab(WAITLIST_URL, 'Join the waitlist')}`.
- **`:178` `signinCodeForm(email, note = '', target = null)`.** The same two forms without the `phone` and `invite` hidden fields, and the new copy. No link to `/console/signin`.
- **`:193-194`.**
  ```ts
  const emailForm = (note = '', email = '') => signinEmailForm(note, email, target);
  const codeForm = (email: string, note = '') => signinCodeForm(email, note, target);
  ```
- **After `:195`.** Before `formData()`, the limiter, throttles, `auth` or the DO:
  ```ts
  if ((url.pathname === CONSOLE_SIGNIN_PATH || url.pathname === CONSOLE_VERIFY_PATH) && request.method === 'POST' && request.headers.get('origin') !== url.origin) {
    event(url.pathname === CONSOLE_SIGNIN_PATH ? 'console_signin' : 'console_verify', false, 'cross_origin');
    return finish(page(`<h1>Sign in from Waldo’s own page.</h1><p><a href="${CONSOLE_SIGNIN_PATH}">Open the sign-in page</a></p>`, 403));
  }
  ```
- **`:196-240`.** Read only `return_to` and `email`. Remove `rawPhone`, `phone`, `invite`, `details` and the phone refusal at `:206`. Use `emailForm(…, email)` and `codeForm(email, …)`. Call `auth.sendCode(email)` with one argument; the interface keeps its optional code. New strings at `:204`, `:205`, `:211`, `:218`, `:230` and `:236`.
- **`:241-303`.** The same removals, including `:249`.
  - Call `auth.verify(email, String(form.get('code') ?? ''))`. The `ConsoleAuth` signature and its legacy-bypass tests in `console-auth.test.ts` are unchanged.
  - New strings at `:255`, `:263`, `:274`, `:280`, `:284`, `:290` and `:295`.
  - Terminal page `:298`: `<h1>Signed in.</h1>`, and `class="button-link"` on `#signin-download`. The rest is unchanged.

**4. Callers that must send Origin**
- **`scripts/device-bridge-local-harness.mjs:168`.** Add `headers: { origin }`.
- **`test/owner-do-registered-workspace.test.ts:457,461`.** Add `headers: { origin: 'https://local.invalid' }`.
- **`test/fixtures/console-signin-server.ts:37-40`.** Forward the browser's header:
  ```ts
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(req.headers.origin ? { origin: String(req.headers.origin) } : {}) }
  ```
  Then add the sign-up routes described under Acceptance trace.

### UI and copy

**Shared across all pages**
- Canvas page, the brand (spots mark plus "Waldo", not a link), and one white card in `<main>`.
- At most one ink primary button per card; secondary buttons use `--fill-2`.
- Notes: `note alert` (pink, `role="alert"`) for errors; `note` (grey, `role="status"` or plain) for information.
- Every input has a `for` label and `aria-describedby` help.
- Controls are 48 px; inputs use 16 px text (no iOS zoom).
- At 480 px and narrower, card padding is 24/18 px. No horizontal scroll at 320 px.
- Focus: 2 px orange inside a 2 px ink ring.
- Titles are "Join Waldo" and "Sign in to Waldo". `lang="en-GB"`.

**Sign-up entry** (`GET /console/signup`; the invite link pre-fills email and code, and the fragment is stripped)
- H1: **Your Waldo starts here.**
- Lede: "Waldo is a personal assistant for life, work and health. Confirm your email to set yours up."
- Field **Email**. Help: "Use the address your invite was sent to."
- Field **Invite code**. Help: "Your invite link fills this in. Opening the link doesn’t use your invite. Invites last 14 days."
- Note, only when `resolveCaptureText(env)` is true: "This is a test version of Waldo. Your messages, his replies, the full context he works from, anything he reads from your Google account once you connect it, and your sign-up email are recorded so the Waldo team can fix problems. If you’d rather not, don’t connect Google or chat with him yet." This matches S0 R6's scope.
- Checkbox: "I’m 18 or over. Waldo is for adults." (required)
- Primary: **Email me a code**
- Help: "Asking for a code registers this email with Waldo’s sign-in service. Your Waldo is set up only when you finish."
- Help: "Waldo keeps what you tell him and what he reads from accounts you connect, so he can help you. It is stored with Waldo’s cloud providers, Cloudflare and Supabase. Your messages and what he reads are sent to the AI service that writes his replies. You can delete your account in Settings › Account. More on our [privacy page] and [terms page]." The links open a new tab.
- "Already have an account? [Sign in]"
- `<noscript>`: "If the email and invite code are empty, copy them from your invite link. Nothing is sent until you press Email me a code."

**Entry errors.** Each is a note on the re-rendered entry. The email and the 18+ tick are kept; the code never is.
- Bad email or code: "Check the email and the 20-character invite code from your invite link."
- No 18+: "Waldo is for adults. Confirm you’re 18 or over, then open your invite link again."
- Unreadable form: "Waldo couldn’t read that form. Open your invite link again."
- Expired or CSRF: "This sign-up has expired or couldn’t be checked. Open your invite link again to start over."
- 405 and 403: H1 "Open your invite link to continue."
- No auth configured: H1 "Sign-up is unavailable right now." plus `unavailable`.
- 404: H1 "This page doesn’t exist."

**Code sent**
- H1: **Check your email.**
- Body: "Enter the code from your email. Waldo sends it to **{email}** only if that address has an invite or a Waldo account. It can take a few minutes." Never "on its way".
- Field **Code from your email**
- Primary: **Confirm my email**
- Secondary: **Send another code**
- Help: "Nothing after a few minutes? Check this is the address your invite was sent to, then send another code."
- Link: "Use a different email or invite"

**Code-sent notes**
- Throttled on send (`:42`): "Too many attempts. No new code was requested. Wait a few minutes, then send another."
- Unconfirmed (`:42`): "Waldo couldn’t confirm a code was sent. If one arrives, enter it here. Otherwise send another."
- Resent (`status`): "If this email has an invite or a Waldo account, Waldo asked for another code. Use the newest one."
- Verify error: "That code didn’t work. Check it’s the newest one, or send another. If it still fails, your invite may have expired or been used. Ask whoever invited you for a new link."
- Empty code: "Enter the code from your email."
- Throttled (`:74`): "Too many attempts. Wait a few minutes, then try again."
- `unavailable`: "Sign-up is temporarily unavailable. Try again in a minute."

**Finish**
- H1: **Email confirmed.**
- Body: "**{email}** is confirmed. One step left: set up your Waldo."
- Primary: **Set up my Waldo**
- Help: "This uses your invite. If an earlier try was interrupted, pressing it again opens the same account without a new code."
- Help: "This step is saved in this browser for 15 minutes from when you started. Until then, anyone with this browser, or a copy of what it saved, can finish it. What it saves includes your email address and isn’t encrypted." This keeps the substance the #499 review required (`ENGINEERING_FUNDAMENTALS.md:269`).
- Link: "Start again". Help: "Starting again clears this browser only."

**Finish notes**
- Before the email is confirmed: "Confirm your email first. Enter the code from your email."
- Admission refused: "Waldo couldn’t set up your account. Your invite may have expired or been used. If an earlier try was interrupted, press Set up my Waldo again to open the same account. Otherwise ask whoever invited you for a new link."
- Uncertain: "Waldo couldn’t confirm your account is ready. Press Set up my Waldo again. Your confirmed email is kept, so you won’t need another code."

**Finished.** A 303 to `/console#/welcome`, which is S3's Meet step.

**Sign-in**
- The continuation note, when present (verbatim from today's code).
- H1: **Sign in to Waldo.**
- Lede: "Waldo emails you a code. There’s no password."
- Field **Email** (no placeholder).
- Primary: **Email me a code**. `data-pending` stays "Requesting an email code…".
- Help: "New to Waldo? Open the invite link you were sent, or [enter your invite code]. No invite yet? [Join the waitlist]." The waitlist link opens a new tab.

**Sign-in errors**
- Edit (`:204`): "Check your email address, then send another code."
- No `@` (`:205`): "Enter your email address."
- Limiter missing (`:211`): "Sign-in is temporarily unavailable. No code was sent. Try again in a few minutes."
- Rate-limited (`:218`): "Too many attempts. Wait a minute, then try again."
- Throttled (`:230`): "Too many attempts. Wait a few minutes, then try again."
- Cross-origin (403): H1 "Sign in from Waldo’s own page." with the link "Open the sign-in page".

**Sign-in code**
- H1: **Check your email.**
- Status: "If **{email}** has a Waldo account, Waldo asked for a sign-in code for it. It can take a few minutes."
- Field **Code from your email**
- Primary: **Sign in**, with pending text "Checking your code…"
- Secondary: **Send another code or change email**, with pending text "Opening your details…"
- Help: "New to Waldo? Sign-in codes only go to existing accounts. Open your invite link to sign up."

**Sign-in code notes**
- Unconfirmed (`:236`): "Waldo couldn’t confirm a code was sent. If one arrives, enter it here. Otherwise send another."
- `:255`: "Sign-in is temporarily unavailable. Try again in a few minutes."
- `:263`: "Too many attempts. Wait a minute, then try again."
- `:274`: "Too many attempts. Wait a few minutes, then try again."
- `:280`: "Verification is temporarily unavailable. Try again in a minute."
- Wrong code (`:284`): "That code didn’t match. Check the newest email from Waldo. New to Waldo? Use your invite link instead."
- `:290` and `:295`: "Sign-in is having trouble. Your code was accepted, but Waldo couldn’t open your session. Send another code and try again."
- "Stop waiting" and the script's uncertain notes are unchanged.

### Security, privacy and authority

**Login CSRF on the email-code door is closed.**
- Both sign-in POSTs require `Origin === url.origin` before the form is parsed.
- The referrer policy moves to `same-origin`, so legitimate native and fetch submissions carry the real origin.
- A missing, `null` or foreign Origin is refused.
- The Telegram ticket redeem (`index.ts:145-169`) is the same bug class and is not in S2; see Risks.

**Privacy effect of the referrer change: neutral.**
- A Referer never includes the fragment, so `#email=…&invite=…` cannot leak.
- Cross-origin requests get no Referer under `same-origin`, and every external link also carries `noreferrer`.
- The only new Referer is same-origin (`/console/signin?return_to=…`) to Waldo's own Worker, which does not log request headers (`wrangler.jsonc` `invocation_logs: false`).

**CSP**
- Sign-in gains a CSP: nonce scripts, a hash-pinned style, `connect-src 'self'`, `form-action 'self'` (which also covers the 303), `img-src 'none'`, no framing, and `nosniff`.
- Sign-up headers are unchanged, and so are its Origin and CSRF checks.

**Admission is unchanged.** No migration; `signin_allowed` and `signup_owner_for_auth` are untouched. Sign-in now sends no invite hash, so it can only ever send codes to existing owners.

**18+ gate**
- The console sign-up door refuses `/send` without the attestation. It is not recorded. The only existing record is `health_consents.age_attested_18_plus`, for app health grants.
- It is not bound into progress minted before the deploy, which lasts at most 15 minutes.
- The app join door (`/app/v1/auth/verify` with an invite) has no server-side attestation.
- The PR must not call this "the" age gate. File a follow-up for the record and the app door: a cross-repo contract change, outside S2.

**Throttles and limiters** are unchanged and fail closed. Cross-origin and 18+ refusals happen before any limiter or RPC.

**Storage:** nothing new. No health data anywhere.

**Never log** the email, invite, OTP, cookies or the Origin value. New log codes: `cross_origin` and `age_unconfirmed`.

**Disclosure.**
- The testing notice is gated by the same `resolveCaptureText` that controls capture. If the Langfuse keys are absent, it over-discloses, which is the safe direction.
- Whether it is enough to count as an opt-in is an owner decision (see Risks).
- The privacy line states only what the source supports: what is kept, where, model-provider egress, and deletion in Settings › Account.

**Security review: yes.** Reviewers check:
- the Origin and referrer pairing;
- the style hash pin;
- the script nonce;
- that the moved script is byte-identical;
- that no new path issues codes or cookies.

### Tests

Workers pool unless noted. Use synthetic `example.com` and `example.test` data only.

**Golden test.** Extend "routes two fresh email-only members…" (`test/console-signup.test.ts:192`):
- Every `/send` adds `adult: 'yes'`.
- Assert `done.headers.get('location') === '/console#/welcome'`.
- Then `serveDashboard(new Request('https://w.test/console', { headers: { cookie: ownerCookie } }), assetsFixture, r => handleConsole(r, e, auth))` returns 200 with the index body. Here `assetsFixture = { fetch: async () => new Response('<div id="root"></div>') } as unknown as Fetcher`; the existing DO fixture answers the overview with 200.

**Updates to `test/console-signup.test.ts`**
- `start()` (`:38`) and every `/send` add `adult: 'yes'`.
- `:149` expects `/console#/welcome`.
- String updates:
  - `:48`, `:134`: "asked for another code"
  - `:54`: "Email confirmed."
  - `:61`: `not.toMatch(/\bphone\b|SMS/i)`
  - `:63`: "pressing it again opens the same account"
  - `:84`, `:185`: "Confirm your email first"
  - `:94`: "That code didn’t work"
  - `:111`: `/Too many attempts|couldn’t confirm/`
  - `:130`: "couldn’t confirm" (keep `:131`'s not "on its way")
  - `:268`: "Press Set up my Waldo again"

**New tests in `test/console-signup.test.ts`**
- **18+ (hostile).** `it.each([undefined, '', 'on', 'no', 'YES'])` for `adult` on `/send`:
  - Expect 200, "Waldo is for adults", the email kept, the invite not reflected, and no `set-cookie`.
  - `s.fetcher`, `a.throttle` and the limiter are never called.
- **CSP on every state** (entry, code sent, finish, refusals, 403):
  - The header matches `/^default-src 'none'; script-src 'nonce-([0-9a-f-]{36})'; style-src 'nonce-\1'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/`.
  - The `<style nonce>` and, when present, `<script nonce>` equal it.
  - `referrer-policy` is `same-origin`.
- **Testing notice.**
  - With `{ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' }`, the entry contains "This is a test version of Waldo", and `html.indexOf('This is a test version') < html.indexOf('<button')`.
  - It is absent for `'production'` and for `'false'`.

**`test/console-signup-entered-values.test.ts`**
- `begin()` (`:49`) adds `adult: 'yes'`.
- `:16`, `:23`: "Check the email and the 20-character invite code".
- `:69`: not "asked for another code".

**Updates to `test/console-signin.test.ts`**
- `form()` (`:86`) and the hand-built requests (`:317`, `:333`, `:477`) add `origin: 'https://w.test'`.
- `:229-236`: strip `nonce="…"` before comparing.
- String updates:
  - `:255`: "didn’t match"
  - `:299`: "Code from your email"
  - `:384`: `<label for="signin-code">Code from your email</label>`
- Argument updates:
  - `:325`: `toHaveBeenCalledWith('fresh@example.test')`
  - `:410`: keep as is (attribute order is preserved)
- Remove the phone and invite expectations at `:288`, `:301`, `:308`, `:337`, `:348`, `:360-361`, `:395-396` and `:411-412`. Assert the kept `name="email" value=…` instead.
- `:378-379`: email only.
- `:419-431`:
  - reduce each case's `details` to `{ email }`;
  - drop the `phone` case;
  - `:429` then checks only the email.
- `:442-454`:
  - drop "invalid verify phone";
  - `:451` checks only `fields.email`.
- Rewrite `:268-279` (**invitee trap**):
  - POST `/console/signin` with `{ email, invite }`;
  - `sendCode.mock.calls[0]` equals `['invitee@example.com']`;
  - no `name="invite"`;
  - the page contains "Sign-in codes only go to existing accounts".
- Rewrite `:281-310` (**phone ignored**): `verify` is called with `(email, code)`, and there is no `type="tel"`.

**New tests in `test/console-signin.test.ts`**
- **Login CSRF (hostile).**
  - `it.each` over Origin `[undefined /* no header */, 'https://attacker.test', 'null', '']` × `['/console/signin', '/console/verify']`.
  - Expect 403, and `sendCode`, `verify`, `throttle`, the limiter and `owners.fetch` are never called.
  - No `set-cookie`.
  - The log contains `cross_origin` and not the email.
- **Headers on every sign-in state:** email form (GET), code page after send, wrong code, the download terminal page (200) and the 403.
  - CSP matches `/^default-src 'none'; script-src 'nonce-([0-9a-f-]{36})'; style-src 'sha256-[A-Za-z0-9+/]+=*'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/`.
  - The `<script nonce>` equals the header nonce.
  - `referrer-policy` is `same-origin` (pins `ENGINEERING_FUNDAMENTALS.md:254`).
  - `nosniff` is set.
  - Two GETs differ in nonce.
- **Script unchanged.** The extracted script still contains `destination.pathname === '/console' ||` and `body.get('return_to') === '/console/devices'`.

**`test/console-signin-browser.test.ts`** (browser-fixture config)
- `:11`: regex becomes `/<script nonce="[^"]+">([\s\S]*?)<\/script>/`.
- All 24 cases stay green, including #1241's two devices cases.

**`test/owner-do-registered-workspace.test.ts:457`:** add Origin and assert `invalid.status === 200` before the `signin-download` check. Without that, a 403 also passes.

**New `test/pre-auth-copy.test.ts`**
- **Style hash pin.**
  ```ts
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PRE_AUTH_CSS));
  expect(`sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`).toBe(PRE_AUTH_STYLE_HASH);
  ```
  The failure message gives the value to paste.
- **Links pinned.** `WAITLIST_URL`, `PRIVACY_URL` and `TERMS_URL` equal their literals.
- **Banned words.** Render every state above through `handleSignup` and `handleConsole` with stubs. Extract visible text: strip `<script>` and `<style>`, keep the `placeholder`, `aria-label`, `title` and `data-pending` values, strip tags, decode entities. Assert:
  - no match for `/\b(wellness|wellbeing|mindfulness|holistic|journey|optimi[sz]e|hustle|grind|empower|unlock|seamless|powerful|smart|intelligent|AI-powered|AI-driven|health (?:app|tracker)|dashboard|streaks?|badges?|rewards?|Oops|Get started|Learn more|Something went wrong|Loading|Thinking|Waldo AI|Meet Waldo|Hey Waldo|Supabase Auth|cookie|OTP|owner account|Submit|only for what you approve)\b/i`;
  - no `!` in visible text;
  - no all-caps heading;
  - at most one `class="primary"` per card.

**Edge cases covered**
- Null or empty: empty code, missing `adult`, missing Origin.
- Revoked or expired: expired progress; revoked invite (existing `:116`).
- Failure: OTP provider 5xx; grant and session failures; a hanging grant (existing `:252`).
- Hostile: cross-site POST; forged `adult`; escaped email (entered-values `:30`).

**Run commands**
```
cd packages/runtime
./node_modules/.bin/vitest run test/console-signup.test.ts test/console-signup-auth.test.ts test/console-signup-entered-values.test.ts test/console-signin.test.ts test/pre-auth-copy.test.ts test/owner-do-registered-workspace.test.ts test/dashboard-static.test.ts
./node_modules/.bin/vitest run --config vitest.browser-fixture.config.ts test/console-signin-browser.test.ts
```

### Acceptance trace

**SOURCE/CI:** the tests above, recorded at the PR head SHA.

**LOCAL BROWSER (Chromium; required before review).** Use the in-repo fixture `packages/runtime/test/fixtures/console-signin-server.ts` (port 4316, real handlers, synthetic stubs).

Two changes to the fixture:
1. Forward Origin (Changes, file 4).
2. Add sign-up routes, then route by pathname (`new URL(req.url ?? '/', 'http://127.0.0.1:4316').pathname`) instead of the raw `req.url`:

```ts
import { handleSignup } from '../../src/channels/console-signup';
import type { SignupAuth, SignupProgress } from '../../src/identity/console-signup';
let stage: 'entry' | 'otp' | 'finish' = 'entry';
const progress = (): SignupProgress => ({ authUser: stage === 'finish' ? 'fixture-auth' : null, emailVerified: stage === 'finish', csrf: 'fixture-csrf', email: 'sample@example.test', inviteHash: '0'.repeat(64), expires: Math.floor(Date.now() / 1000) + 900, phone: null, phoneVerification: 'not_configured', complete: false });
const signup = {
  read: async () => stage === 'entry' ? null : progress(),
  begin: async () => { stage = 'otp'; return 'fixture-progress'; },
  sendCode: async () => true,
  verifyEmail: async (_p: SignupProgress, code: string) => code === '000000' ? (stage = 'finish', 'fixture-progress') : null,
  collectPhone: async () => 'fixture-progress',
  complete: async () => 'fixture-owner',
} as unknown as SignupAuth;
const signupEnv = { ...env, LANGFUSE_CAPTURE_TEXT: process.argv.includes('--capture-off') ? 'false' : 'true', WALDO_ENVIRONMENT: 'staging' };
// In the handler: if path is /console/signup or starts with /console/signup/, set `stage` from ?stage= on GET,
// build the Request exactly as for sign-in (body and forwarded Origin), call handleSignup(request, signupEnv, auth, signup),
// and write the response the same way as the sign-in branch.
```

Run it with `packages/runtime/node_modules/.bin/tsx packages/runtime/test/fixtures/console-signin-server.ts`. Code `000000` passes; any other code fails.

Then run this script from a scratch directory, not the repo. Playwright is not a repo dependency. In this container: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node shoot.cjs <outDir>`. If Playwright is unavailable, record UNAVAILABLE.

```js
const { chromium } = require(process.env.PW ?? '/opt/node-tools/node_modules/playwright');
const base = 'http://127.0.0.1:4316', out = process.argv[2], problems = [];
const states = { 'signup-entry': '/console/signup?stage=entry#email=sample%40example.test&invite=ABCDEFGHJKLMNPQRSTUV',
  'signup-otp': '/console/signup?stage=otp', 'signup-otp-throttled': '/console/signup?stage=otp&send=throttled',
  'signup-otp-unconfirmed': '/console/signup?stage=otp&send=unconfirmed', 'signup-finish': '/console/signup?stage=finish',
  'signin': '/console/signin', 'signin-devices': '/console/signin?return_to=%2Fconsole%2Fdevices' };
(async () => {
  const browser = await chromium.launch();
  const open = async (viewport, javaScriptEnabled = true) => { const ctx = await browser.newContext({ viewport, javaScriptEnabled }); const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); }); page.on('pageerror', e => problems.push(e.message)); return { ctx, page }; };
  for (const [vp, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 640 } }))
    for (const [name, path] of Object.entries(states)) { const { ctx, page } = await open(viewport); await page.goto(base + path);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) problems.push(`${vp} ${name}: horizontal scroll`);
      if (vp !== 'narrow') await page.screenshot({ path: `${out}/s2-${vp}-${name}.png`, fullPage: true }); await ctx.close(); }
  { const { ctx, page } = await open({ width: 390, height: 844 }); await page.goto(base + states['signup-entry']);   // sign-up end to end
    await page.check('#adult'); await page.click('button.primary'); await page.fill('#code', '111111'); await page.click('button.primary');
    await page.screenshot({ path: `${out}/s2-phone-signup-verify-error.png`, fullPage: true });
    await page.fill('#code', '000000'); await page.click('button.primary'); await page.getByText('Email confirmed.').waitFor();
    await page.click('button.primary'); await page.waitForURL(base + '/console#/welcome'); await ctx.close(); }
  for (const js of [true, false]) { const { ctx, page } = await open({ width: 1440, height: 900 }, js); await page.goto(base + '/console/signin');   // sign-in, with and without JS
    await page.fill('#signin-email', 'sample@example.test'); await page.click('button.primary'); await page.locator('#signin-code').waitFor();
    await page.fill('#signin-code', '111111'); await page.click('button.primary'); await page.getByText('didn’t match').waitFor();
    if (js) await page.screenshot({ path: `${out}/s2-desktop-signin-wrong-code.png`, fullPage: true });
    await page.fill('#signin-code', '000000'); await page.click('button.primary'); await page.waitForURL(base + '/console'); await ctx.close(); }
  await browser.close(); console.log(problems.length ? problems.join('\n') : 'no problems'); process.exitCode = problems.length ? 1 : 0;
})();
```

Expected result: "no problems". That means:
- no CSP errors, including the script's `DOMParser` steps;
- no horizontal scroll at 320 px;
- sign-up lands on `/console#/welcome`;
- sign-in reaches `/console` both with and without JavaScript, which proves the no-script Origin path.

**STAGING (pre-merge, today's pages).** Operator check (a) under Depends on: one sign-up each in iPhone Safari and desktop Firefox.

**STAGING (after an approved deploy; S2 is after the demo freeze)**
1. The admin issues an invite on `#/admin` to a fresh test inbox.
2. Open the link in a private desktop Chrome window. Observe the new entry page:
   - email and code are pre-filled;
   - the URL is `/console/signup`;
   - the testing notice is above the button, if capture is on;
   - DevTools shows no errors.
3. Press the button without ticking 18+. The browser blocks the submit.
4. Tick 18+ and send. "Check your email." The code arrives.
5. Enter a wrong code. "That code didn’t work…"
6. Enter the right code. "Email confirmed."
7. Press **Set up my Waldo**. The URL is `…/console#/welcome` and S3's Meet step shows. Take a screenshot.
8. Open a private window on `/console/signin`:
   - there is no invite or phone field;
   - an invited-but-unregistered address gets "Sign-in codes only go to existing accounts";
   - no email arrives;
   - the invite link still works afterwards.
9. Run `curl -si -X POST https://<staging-host>/console/verify -H 'origin: https://attacker.test' -d 'email=nobody@example.com&code=000000'`. Expect 403 and no `set-cookie`.
10. Repeat steps 2-7 and a sign-in on iPhone Safari at 390 px.
11. For one hour after the deploy, watch Worker logs for `console_signin` or `console_verify` lines with code `cross_origin` from a real visitor. Any such line triggers Rollback of the Origin change.

### Verification commands

Run from `/home/user/waldo-backend`, in order:
1. `git diff --check`
2. `npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck`
3. The two vitest commands under Tests.
4. `node scripts/guards/guard-health-leak.mjs`. If it flags something, change the CSS or copy, never the guard.
5. `WALDO_DO_MIGRATION_BASE_REF=HEAD^1 npx -y pnpm@10.34.4 verify:guards`. The pgTAP gate is UNAVAILABLE without Postgres.
6. `npx -y pnpm@10.34.4 --filter @waldo/dashboard-app build`, then `npx -y pnpm@10.34.4 --filter @waldo/runtime test`. `console-entry` needs the dashboard build.
7. `node packages/runtime/scripts/device-bridge-trace.mjs`. Record UNAVAILABLE if local wrangler or the RPC stub cannot start.
8. `npx -y pnpm@10.34.4 verify`. The `verify:supabase` steps need Docker and are UNAVAILABLE here.
9. The local browser run above.

Record PASS, FAIL, NOT RUN and UNAVAILABLE at the exact head SHA.

### Rollback

Revert the PR and redeploy.
- **No data or schema impact.** Progress cookies, owner and session cookies, RPCs and limits are unchanged, so in-flight sign-ups survive deploy and rollback.
- **Old tabs after deploy.**
  - An entry page loaded before the deploy posts without `adult`. It gets the 18+ note with an empty code field and must reopen the invite link.
  - A sign-in tab loaded before the deploy runs under `no-referrer`. In a spec-following browser its JS submissions may carry `Origin: null`. They show the script's uncertain note ("Could not confirm the result…"), not the 403 page. A reload fixes it.
- **Trigger.** If Worker logs show a real visitor's `cross_origin` refusal in the first hour, revert at least the Origin hunk. It is a few lines and is separable from the copy and the `#/welcome` Location change.

### Risks and open questions

- **Testing notice and opt-in (owner decision).** `CLAUDE.md` limits staging text capture to opted-in testers. The notice is shown before the visitor acts.
  - **Default:** the showcase runs with capture off (S0 R6 default B), so the notice is not shown, unless the owner chooses otherwise.
  - **If capture stays on**, the owner rules either (a) that this notice, read before acting, is the opt-in, or (b) that a second required tick is added, server-checked like `adult` and shown only when `resolveCaptureText(env)` is true.
- **Demo freeze.** S2 likely ships after the showcase. **Default:** the S0 presenter brief covers today's trap.
- **Merge order.** S2 merges strictly after S3. Otherwise the 303 shows "Page not found".
- **Safari and Firefox Origin.** **Default:** pre-merge check (a). A 403 there blocks the merge; the post-deploy log watch is the second net.
- **Privacy and terms pages may be stubs.** The design system lists them as a heading and a paragraph each (A05), unverified live.
  - Check (b) records whether each page describes what is stored, the processors (sign-in service, Cloudflare, model provider, staging tracing, Google), retention and deletion.
  - **Default if not:** keep the link text "privacy page" and "terms page", never "notice". Record the gap in the PR body and a follow-up issue. The in-page sentence is the substantive disclosure.
- **18+ not recorded, and the app door has no attestation.** **Default:** S2 adds the console gate only. A follow-up issue covers the record and `/app/v1` (cross-repo contract).
- **Telegram ticket redeem (`POST /console` with `t`) has the same login-CSRF class.** Exposure is low: it needs a Telegram-linked owner, and Telegram is not offered to new people. **Default:** a follow-up issue applying the Origin check and `same-origin` together on `channels/console.ts:99-101` and its POST.
- **`signout-all` has no Origin check.** SameSite=Strict limits this to logout CSRF. S4 owns sign-out.
- **The SPA keeps `no-referrer`.** S4 should rely on its CSRF token, not Origin.
- **No Mottle before sign-in.** A design-system deviation. **Default:** system stack.
- **Venue-network IP throttle** (30 attempts per 15 minutes per IP, shared): S0.

### Effort

**M, about 7 hours.** Lane: runtime non-owner-do only (`channels/pre-auth-page.ts`, `console-signup.ts`, `console-signin.ts`, one script, one test fixture, tests). No `owner-do.ts`, SPA or migrations.

| Work | Hours |
|---|---|
| Shell and hash pin | 1 |
| Sign-up copy, 18+ and notice | 1.5 |
| Sign-in on top of #1241 | 1.5 |
| Tests and caller updates | 2 |
| Fixture extension and browser run | 1 |
| Security review | separate |

## S3 Welcome flow at #/welcome

Base: worktree `a643bcab` (beta-mvp `04bb8c89` merged onto `e5c022ef` plus the plan docs commit). All anchors below were re-read at that tree. Lane: `packages/dashboard-app` only. No runtime, `owner-do.ts`, contract or migration change.

### Outcome

A newly invited visitor finishes signup and lands on a full-screen welcome at `/console#/welcome`, with no nav or tab bar. Four sections follow under a progress row (Meet, Your day, Connect, All set).
- **Meet**: "Hello. I'm Waldo." plus one promise, then the visitor confirms the time zone this device reports, shown by name ("India Standard Time").
- **Your day**: quiet hours, 22:00 to 07:00 by default.
- **Connect**: a Google pre-prompt that says what Waldo can and can't do and what connecting keeps. Google opens in a new tab, and the step notices by itself when the account appears or comes back broken. Body data is offered as "through the iPhone app".
- **All set**: what was actually saved, what happens next given the time-zone state, and a link to the iPhone app waitlist.

Every step after the first has Back, and every question can be skipped. If the visitor leaves part-way, or finishes Google in a second tab, Today shows a "Pick up where you left off" card that leads back.

The job to be done: "get Waldo set up enough to be useful, in a couple of minutes, without being lied to." Each write uses the existing owner controls (`timezone.set`, `proactivity.set`, `google.connect`). The time-zone write is load-bearing. Once the owner is on the app chain, a confirmed zone is what lets Waldo schedule the Brief, Check-in and Close (`owner-do.ts:2621-2622`). Without it the person gets nothing proactive.

### Depends on / blocks

- **Merge order:** S1 → **S3** → S2 → S5a → S6. S4 → S5b runs on its own track.
  - S3 needs nothing merged first to compile: the server already projects `timezone_confirmed`, and every action S3 uses is already allowlisted.
  - S1 goes first because, without it, the Connect step always shows "Google didn't start." for a console-only owner (traced in Current state). S3's Google sub-trace on staging needs S1 merged **and deployed**.
- **Demo freeze.** Ansh approved a freeze on #1103 at 19:27Z, 14 Oct. Only #1258, headroom, #1259, #1261 and #1227/#1240 merge before the showcase, so **S3 lands after the demo** unless Ansh adds it. Tomorrow's existing flow does not depend on S3.
- **S0 (owner actions).** Admin invite links. Visitors' Google accounts added as OAuth test users, without which Google blocks them; S3 shows help copy for that case. A staging deploy, which needs separate authority.
- **S2 must follow S3.** S2's signup redirect to `/console#/welcome` renders "Page not found" without S3 (`App.tsx:36,78`).
- **S4 (Say hello).** Whichever of S3 and S4 lands second wires S4's `SayHello` into a `hello` step. The seam is exact: see "S4 seam" under Changes. S4 also adds `chat` to the `Route` union on the line S3 edits (`App.tsx:21`), so the second PR rebases one line.
- **S5.**
  - S5a imports `IPHONE_WAITLIST_URL` from S3's `links.ts`.
  - S5b gives S3's `finish` a destination and adds "Show me around" to `DoneStep`; see "S5 seam".
  - S5 also fixes `--t3` contrast globally. S3 puts no essential copy in `.label`/`.meta`.
- **S6** mounts `<IMessageLink placement="welcome"/>` in S3's Connect step; see "S6 seam". The Setup checklist has had a "Connect iMessage" row to `/console/imessage` since `04bb8c89` (`Panels.tsx:149`); S3 does not touch it.
- **No overlap** with #1063 (server-rendered pages), #1227/#1240 (prompt/runtime) or #1241 (merged; `console-signin.ts` return_to).

### Current state

What exists to reuse ([verified] at `a643bcab`):
- **Routing.** Routing is hash-only. `resolveRoute` strips `?…` (`App.tsx:30`) and maps known keys (`:26-37`); anything unknown is `not-found` (`:36`). The `Route` union is at `:21`. No `welcome` route exists.
- **The overview gate.** `App()` renders every route except `#/admin` only after the overview read is ready (`:214-216`). The shell chrome is one tree at `:207-221`. The footer now also links `/console/imessage` (`:217`). App's overview poll, every 15 s, keeps running whatever the route (`:167-190`).
- **The shell needs no Worker change.** The Worker serves the SPA at `/console` behind the owner session and sends a 303 to `/console/signin` on 401 (`dashboard-static.ts:21-38`). A hash never reaches the server, so `/console#/welcome` works as is.
- **Day read.** `GET /console/dashboard/api/v1/controls?view=day` already returns `timezone_confirmed` (`dashboard-controls.ts:36`, from `owner-do.ts:3407`). The SPA reader drops it: `DayRecord` lacks the field (`controls-model.ts:5-10`) and the day branch copies only timezone/date/cards/proactivity (`:68-76`). The revision is a hash of the full server projection (`owner-do.ts:1494`; `dashboard-control-actions.ts:60`), so reading one more field changes nothing on the wire.
- **Both revisions move together.** The connections projection formats `sessionUntil` and the session rows in the owner's zone (`owner-do.ts:3408`). After `timezone.set`, the connections revision changes as well, so the flow re-reads both views after each save.
- **Controls limits.** Reads and actions are serialised per owner DO and rate-limited at **90 reads and 20 actions per minute**. Past that they return 429 with `retry-after: 60` (`owner-do.ts:1464-1472`). Every tab shares the budget.
- **What a controls read costs.** Each one builds the full console view (`owner-do.ts:3398-3428`), including two Supabase RPCs:
  - `health_log_recent`, through `ledger()` (`owner-do.ts:2577,2582,3424`; `health-log.ts:57-60`)
  - the iMessage `presence_hint` (`owner-do.ts:3411-3414`)
- **What the overview read costs.** It goes through `runtime.overview()` (`owner-do.ts:1532-1538`), which reads only DO-local state: plans, desk, runs, traces and `google.state()` (`owner-do.ts:3429-3434`, `:2380-2384`; storage reads for a new owner). It is session-checked (`:1379`) but not counted by the controls limiter (`:1464`). It already carries `services[].account_id/email/health` (`dashboard-overview.ts:49-53`; `model.ts:9`), with the same ids and health rule as the connections read (`dashboard-controls.ts:45`).
- **Actions.** `submitControl` posts csrf, revision, view and request_id as FormData (`controls-model.ts:171-195`).
  - A 401 throws `SignInRequired` (`:178`).
  - A 409 without a receipt throws a `stale_read|no_longer_eligible|request_reused` code (`:189-192`).
  - A 403 throws `invalid_action` (`:193`).
  - Anything else, including 429, throws the uncertain `outcome_unavailable` (`:194`).
  - The server allowlists `day:[timezone.set, proactivity.set, …]` and `connections:[google.connect, …]` (`dashboard-control-actions.ts:19`), checks csrf (`console.ts:124-129`) and revision (`dashboard-control-actions.ts:60`), and caps receipts at 100 per session (`:17,57`).
- **`timezone.set`** validates the zone, saves it to the directory, then puts `timezone` and `timezone_confirmed=true` and arms jobs (`owner-do.ts:3450-3455`). A runtime test pins it (`app-owner-proactive.test.ts:112-125`). App-channel owners get no proactive work until the zone is confirmed (`owner-do.ts:2620-2622`).
- **`proactivity.set`** needs all three of quiet_start, quiet_end and volume (`console.ts:127` pipe-joins them; schema `contracts/src/tools/schemas/loops.ts:18-23`). An empty field parses as null, meaning no quiet hours (`owner-do.ts:3443-3449`).
- **`google.connect`** from the console calls `googleConnectReceipt(..., url.origin)` (`owner-do.ts:1503`). The receipt carries only a same-origin `/c/<22>` path (`dashboard-control-actions.ts:22-27`). The SPA accepts only that path or the exact Google auth endpoint, and only over https (`controls-model.ts:148-155`). `/c/<ticket>` needs no cookie: the ticket is the bearer and the response is a 302 to Google consent (`connect-link.ts:26-63`).
- **Today's console connect is a same-tab second click.** The receipt renders "Continue to Google" as a plain anchor (`Controls.tsx:117`).
- **The callback stores the account before the readback.** `google.keep` runs at `owner-do.ts:2448`, before `confirmGoogleReadback` at `:2457`.
  - A readback 401 marks the account `needs_reconnect` (`connectors/connections.ts:70`).
  - A non-401 readback failure leaves it `access_granted`, while the callback page says "Google could not be connected" (`google-oauth.ts:39`).
  - The console itself labels saved access "Access granted · read unverified" (`Controls.tsx:79`).
- **The completion page.** It always links "Back to your console" to `/console`, with no hash (`google-oauth.ts:18-31`). Its linked copy ends "…You can close this tab." (`:35`). There is no `postMessage`.
- **Reusable UI.**
  - Styles: `.tile`, buttons, `.quiet-link`, `.access-label`, `.control-form`/`.control-fields`, `.disclosure`, skeletons, `.route` rise, `.visually-hidden` (`style.css:56,70-80,113,156,247,458,467`).
  - Components: `DayRail` takes a quiet band (`Infographics.tsx:36-49`). `Logo` (gmail, googleCalendar) and `Icon` (check, warning) are at `icons.tsx:36-42`, `WaldoMark` at `:54-55`. The hairline `Phone` figure is exported by `@lucasmarkes/hairline/react`.
  - Helpers: `shouldPoll` (`live.ts:11-13`), `fetchOverview` (`model.ts:43`). `clockMinutes` (`Controls.tsx:12`) and `validZone` (`controls-model.ts:63`) exist but are not exported.
- **Vocabulary.** The console names the day cards "The Brief, Check-in and Close" (`Controls.tsx:44`; `App.tsx:119`).
- **V8 returns the legacy zone ID.** It canonicalises India's zone to `Asia/Calcutta`. In this container, Node 22 returns `Asia/Calcutta` for `resolvedOptions().timeZone` under `TZ=Asia/Kolkata`, and for an explicit `timeZone:'Asia/Kolkata'`. `timeZoneName:'longGeneric'` gives "India Standard Time". Chrome behaves the same [inference: same V8/ICU].

What is broken or absent for a new visitor ([verified] unless marked):
- No first-run flow exists. A new owner lands on an empty Today in the fallback zone (`owner-do.ts:2162`).
- **Google connect for console-only owners.** `connectUrl` returns null without a stored `origin` (`owner-do.ts:2414-2419`), and the console path never stores one. The action therefore yields the rejected receipt "Google connect could not start. Try again." This is S1's fix. [inference from a source trace; no test covers it]
- **Scheduled work.** A web-only owner gets none. The alarm returns early unless the owner is Telegram-bound or app-admitted (`owner-do.ts:1716-1733`). `app_subject` is bound only on a chat send (`owner-do.ts:979,1072`).
- **Watch upkeep after connect.** A Google connect arms `watch_upkeep` due now (`owner-do.ts:2338-2343`; `watch-upkeep.ts:26-34`), but that job runs from the same gated alarm (`owner-do.ts:1728-1732`). For a web-only owner, Gmail/Calendar watching therefore starts only once they are bound, and even then it "sends nothing" (`watch-upkeep.ts:8-10`). [inference] All set therefore claims nothing about watching.
- **Health.** Body data cannot come from the browser: sources are `apple|samsung|health_connect` (`health-ingest.ts:15`).
- **Dashboard tests.** They run only locally. CI only typechecks, builds and runs `verify:assets` (`verify.yml:115`; root `package.json:12,21`). Local baseline at `a643bcab`: **31 files, 216 tests PASS**.

### Design

1. **Hash route, full screen, own reads, no overview gate.** `#/welcome` is a `Route`. `App()` returns `<Welcome/>` after all its hooks, so the top bar, nav, tab bar and footer are all hidden.
   - The flow needs `controls?view=day` and `controls?view=connections`, which carry the csrf and revision its writes need. Gating on the overview would only add a serial round trip.
   - It handles its own 401. The shell itself is already session-gated by the Worker.
   - Rejected: a `/console/welcome` path, which needs a `dashboard-static.ts` change for no gain.
   - Rejected: an overlay on Today, which offers no way to hide the chrome and draws focus traps over live polling.
2. **Resume comes from the server, not storage.** On load the flow opens at the first unfinished step, using:
   - `timezone_confirmed`;
   - `quiet_start !== null`, the same rule as the setup projection (`dashboard-controls.ts:82`);
   - an `access_granted` Google account.

   This works across tabs, after the OAuth tab, and on a shared demo device. A skipped step is offered again after a reload, which is honest and cheap. Rejected: a stored step index, which a second visitor on the same browser would inherit and which would disagree with the server.
3. **Three local flags, only for the Today card.** `localStorage['waldo.welcome.v1'] = {started, done, dismissed}`, wrapped in try/catch.
   - The card shows while this browser has been to `#/welcome` and has not finished or dismissed it. That includes the second tab the OAuth completion page opens: "Back to your console" lands on Today, and the card leads to `#/welcome`, which resumes at the first open step, or at All set.
   - Its lines name what is still open. When nothing is open it says only "You're nearly done."
   - Existing owners who never open `#/welcome` never see the card.
   - Entering `#/welcome` resets `done` and `dismissed`, so the next visitor on a shared device starts clean.
   - Rejected: `sessionStorage`, which is empty in the OAuth tab.
   - Rejected: changing the completion page's return link to `/console#/welcome`. That is a runtime change in a file S1 and #1063 already touch, and the card closes the gap without it.
4. **The server read decides every save.** After any save the step re-reads day and connections; both revisions can change (Current state).
   - If the outcome was not a recorded receipt (lost response, 503 unconfirmed, 409 stale, 403, 429), the fresh day read decides. If it shows the value saved, the step counts as done; otherwise the step shows a specific message, and the refreshed revision makes "Try again" valid.
   - The settings are idempotent (they set a value), so a retry with a fresh request_id is safe.
   - Rejected: `ControlsPanel`'s "Check this request" resubmit machinery, which idempotent settings don't need.
5. **Google uses a second, real click on a new-tab anchor.** "Connect Google" posts `google.connect`. The recorded receipt's `/c/` link becomes an ink `<a target="_blank" rel="noopener noreferrer">Open Google</a>`, and focus moves to it. A real anchor click is never popup-blocked, including on iOS Safari.
   - Rejected: `window.open` after the POST resolves. The await loses the user gesture, so Safari blocks it.
   - Rejected: pre-opening a blank tab in the click. On failure it leaves an orphan tab and needs opener juggling.
   - Rejected: minting the ticket when the step renders. That is a write the person didn't ask for.
6. **Detection polls the overview, not the controls view.** After "Open Google", the step reads `GET /console/dashboard/api/v1/overview`, which is DO-local, carries no Supabase call, and is outside the controls limiter (Current state):
   - every 5 s while the tab is visible;
   - at once on `visibilitychange` to visible and on `focus`.

   A hidden tab never expires. On a phone the visitor is in Google the whole time, so expiry happens only after a visible read past 10 minutes finds nothing. "Check again" starts a fresh window.

   An **arrival** is either an account id that did not exist at click time, whatever its health, or a `needs_reconnect` account that came back `access_granted`. The baseline comes from the connections read used for the POST; the overview uses the same ids.
   - An `access_granted` arrival shows "Access saved".
   - A `needs_reconnect` arrival shows "I couldn't read it" with "Try again".
   - After an arrival the step does one controls `reload()` so All set has fresh values.

   On mount the Connect step also does one overview read, so an account finished in the other tab while the person was on another step still shows. This polling also stops controls reads from touching the health plane every 5 s just to find a Google account. Rejected: polling `controls?view=connections`, which has that health-plane cost and uses the shared 90-per-minute read budget.
7. **Copy claims only what is true now.**
   - "Access saved" mirrors the console's own "Access granted · read unverified". The flow never says "Connected", "verified" or "watching".
   - All set says what starts the Brief, Check-in and Close, in two fixed sentences chosen by `timezone_confirmed`. S4 replaces that element.
   - "Already on it." is not used: on S3 alone nothing runs for a web-only owner, so the line would overclaim.
8. **The time zone is shown by name.** `zoneName(zone)` gives the long generic name, for example "India Standard Time", with the IANA ID as a hint. The button says "Use this time zone". The ID saved is exactly the one the device reported, so the saved check stays a string compare.
9. **One waitlist constant.** `src/links.ts` exports `IPHONE_WAITLIST_URL = 'https://www.heywaldo.in/waitlist'` for every slice. It is a code constant, not an env var (`AGENTS.md:57`). The button reads "Join the iPhone app waitlist" and opens in a new tab.

### Changes, file by file

**1. `packages/dashboard-app/src/links.ts` (new)**
```ts
export const IPHONE_WAITLIST_URL = 'https://www.heywaldo.in/waitlist';
```

**2. `packages/dashboard-app/src/controls-model.ts`**
- `:5-10` `DayRecord`: add `timezone_confirmed: boolean;` after `timezone: string;`.
- `:63`: change `const validZone` to `export const validZone`.
- `:69` day shape check: append `|| typeof data.timezone_confirmed !== 'boolean'` inside the `throw shapeError()` condition.
- `:71` returned `data`: add `timezone_confirmed: data.timezone_confirmed,` after `timezone`.

This is strict on purpose. The server always sends the field (`dashboard-controls.ts:36`), and the SPA and Worker deploy together (`wrangler.jsonc:21,88`; `scripts/deploy-runtime.sh` builds the dashboard first).

**3. `packages/dashboard-app/src/Controls.tsx`**
- `:12`: `const clockMinutes` becomes `export const clockMinutes`. No other change.

**4. `packages/dashboard-app/src/welcome-model.ts` (new, pure, testable in the node env)**
```ts
import { validZone, type ConnectionsRecord, type DayRecord } from './controls-model';
import type { OverviewV1 } from './model';

export const QUIET_DEFAULT = { start: '22:00', end: '07:00' } as const;
export const GOOGLE_POLL_MS = 5_000;
export const GOOGLE_WAIT_MS = 10 * 60_000;

export type StepId = 'meet' | 'day' | 'connect' | 'done';
export const STEPS: readonly Readonly<{ id: StepId; label: string; title: string }>[] = [
  { id: 'meet', label: 'Meet', title: 'Hello. I’m Waldo.' },
  { id: 'day', label: 'Your day', title: 'When should I stay quiet?' },
  { id: 'connect', label: 'Connect', title: 'Connect your calendar and mail.' },
  { id: 'done', label: 'All set', title: 'All set.' },
];
export type WelcomeReads = Readonly<{ day: DayRecord; connections: ConnectionsRecord }>;
type Account = ConnectionsRecord['data']['google']['accounts'][number];
export type GoogleHealth = Account['health'];
type Service = OverviewV1['services'][number];

export const granted = (record: ConnectionsRecord): Account[] => record.data.google.accounts.filter(account => account.health === 'access_granted');
const finished: Record<StepId, (reads: WelcomeReads) => boolean> = {
  meet: reads => reads.day.data.timezone_confirmed,
  day: reads => reads.day.data.proactivity.quiet_start !== null,
  connect: reads => granted(reads.connections).length > 0,
  done: () => false,
};
export const resumeStep = (reads: WelcomeReads): StepId => STEPS.find(step => !finished[step.id](reads))?.id ?? 'done';

export const accountHealth = (record: ConnectionsRecord): ReadonlyMap<string, GoogleHealth> => new Map(record.data.google.accounts.map(account => [account.id, account.health]));
// Overview services carry the same ids as the connections read. A new id counts whatever its health; a broken account counts once it is fixed.
export const googleArrival = (before: ReadonlyMap<string, GoogleHealth>, services: OverviewV1['services']): Service | null =>
  services.find(service => !before.has(service.account_id) || (before.get(service.account_id) === 'needs_reconnect' && service.health === 'access_granted')) ?? null;

export const deviceZone = (): string | null => {
  try { const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; return zone && validZone(zone) ? zone : null; } catch { return null; }
};
export const zoneName = (zone: string): string => {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value ?? zone; } catch { return zone; }
};
export const openSetup = (day: DayRecord | null, services: OverviewV1['services']) => ({
  zone: day !== null && !day.data.timezone_confirmed,
  google: !services.some(service => service.health === 'access_granted'),
});

export type WelcomeLocal = Readonly<{ started: boolean; done: boolean; dismissed: boolean }>;
const KEY = 'waldo.welcome.v1';
const NONE: WelcomeLocal = { started: false, done: false, dismissed: false };
// Three per-browser flags for the Today card, nothing about the owner. Blocked or cleared storage reads as "not started".
export const readLocal = (): WelcomeLocal => {
  try {
    const row: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null');
    if (!row || typeof row !== 'object') return NONE;
    const flags = row as Record<string, unknown>;
    return { started: flags.started === true, done: flags.done === true, dismissed: flags.dismissed === true };
  } catch { return NONE; }
};
export const writeLocal = (next: Partial<WelcomeLocal>): void => {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...readLocal(), ...next })); } catch { return; }
};
```
`timeZoneName: 'longGeneric'` is typed in TypeScript 5.9's `lib.es5.d.ts`.

**5. `packages/dashboard-app/src/Welcome.tsx` (new)**

The frame, progress row, problem state and save hook:
```tsx
import { useEffect, useRef, useState } from 'react';
import { Phone } from '@lucasmarkes/hairline/react';
import { ControlsActionError, fetchControls, submitControl, validZone, type ControlAction, type ControlFields, type DayRecord } from './controls-model';
import { clockMinutes } from './Controls';
import { fetchOverview, SignInRequired, type OverviewV1 } from './model';
import { Icon, Logo, WaldoMark } from './icons';
import { DayRail, localMinutes } from './Infographics';
import { shouldPoll } from './live';
import { IPHONE_WAITLIST_URL } from './links';
import { GOOGLE_POLL_MS, GOOGLE_WAIT_MS, QUIET_DEFAULT, STEPS, accountHealth, deviceZone, googleArrival, granted, openSetup, readLocal, resumeStep, writeLocal, zoneName, type GoogleHealth, type StepId, type WelcomeReads } from './welcome-model';

type Load = { kind: 'loading' } | { kind: 'ready'; reads: WelcomeReads } | { kind: 'error'; signedOut: boolean };
type StepProps = Readonly<{ reads: WelcomeReads; reload: () => Promise<WelcomeReads>; advance: () => void; signedOut: () => void }>;
const readAll = async (signal?: AbortSignal): Promise<WelcomeReads> => {
  const [day, connections] = await Promise.all([fetchControls('day', signal), fetchControls('connections', signal)]);
  return { day, connections };
};
const NewTab = () => <span className="visually-hidden"> (opens in a new tab)</span>;

export function Welcome({ onLeave }: { onLeave: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [step, setStep] = useState<StepId | null>(null);
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { writeLocal({ started: true, done: false, dismissed: false }); }, []);
  useEffect(() => {
    const abort = new AbortController();
    readAll(abort.signal).then(reads => {
      if (abort.signal.aborted) return;
      setLoad({ kind: 'ready', reads }); setStep(current => current ?? resumeStep(reads));
    }).catch((error: unknown) => { if (!abort.signal.aborted) setLoad({ kind: 'error', signedOut: error instanceof SignInRequired }); });
    return () => abort.abort();
  }, [attempt]);
  useEffect(() => { if (step) heading.current?.focus(); }, [step]);
  const reload = async () => { const reads = await readAll(); setLoad({ kind: 'ready', reads }); return reads; };
  const signedOut = () => setLoad({ kind: 'error', signedOut: true });
  const index = Math.max(0, STEPS.findIndex(item => item.id === step));
  const current = STEPS[index]!;
  // A save that resolves after Back or Skip must not move the person a second time.
  const move = (from: StepId, to: StepId) => setStep(now => now === from ? to : now);
  const offset = (by: 1 | -1) => STEPS[Math.min(STEPS.length - 1, Math.max(0, index + by))]!.id;
  const finish = () => { writeLocal({ done: true }); onLeave(); window.location.hash = '#/today'; };
  const ready = load.kind === 'ready' && step !== null;
  const props: StepProps | null = load.kind === 'ready' ? { reads: load.reads, reload, advance: () => move(current.id, offset(1)), signedOut } : null;
  return <main id="main" className="welcome" tabIndex={-1}>
    <header className="welcome-top"><span className="brand"><WaldoMark/><span>Waldo</span></span><a className="quiet-link" href="#/today" onClick={onLeave}>Finish later</a></header>
    <p className="visually-hidden" aria-live="polite">{ready ? `Step ${index + 1} of ${STEPS.length}: ${current.label}` : ''}</p>
    {load.kind === 'loading' ? <div role="status" className="skeleton-block welcome-body"><span className="visually-hidden">Checking your settings…</span><i className="sk sk-title"/><i className="sk sk-card"/></div>
      : load.kind === 'error' ? <WelcomeProblem signedOut={load.signedOut} onRetry={() => { setLoad({ kind: 'loading' }); setAttempt(n => n + 1); }}/>
      : props && <>
        <ProgressSteps index={index}/>
        <section className="welcome-body route" key={current.id} aria-labelledby="welcome-title">
          <h1 id="welcome-title" ref={heading} tabIndex={-1}>{current.title}</h1>
          {current.id === 'meet' ? <MeetStep {...props}/> : current.id === 'day' ? <DayStep {...props}/>
            : current.id === 'connect' ? <ConnectStep {...props}/> : <DoneStep {...props} goTo={id => move('done', id)} onFinish={finish}/>}
        </section>
        <footer className="welcome-footer">
          {index > 0 ? <button type="button" className="quiet" onClick={() => move(current.id, offset(-1))}>Back</button> : <span/>}
          {(current.id === 'meet' || current.id === 'day') && <button type="button" className="quiet" onClick={() => move(current.id, offset(1))}>Skip for now</button>}
        </footer>
      </>}
  </main>;
}

function ProgressSteps({ index }: { index: number }) {
  return <div className="welcome-steps"><ol aria-label="Setup steps">{STEPS.map((item, i) =>
    <li key={item.id} className={i < index ? 'done' : i === index ? 'current' : undefined} aria-current={i === index ? 'step' : undefined}>
      <i aria-hidden="true"/>{item.label}{i < index && <span className="visually-hidden">, done</span>}</li>)}</ol></div>;
}

function WelcomeProblem({ signedOut, onRetry }: { signedOut: boolean; onRetry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="welcome-body" role="alert">
    <h1 ref={heading} tabIndex={-1}>{signedOut ? 'Sign in to your Waldo.' : 'I couldn’t read your settings.'}</h1>
    <p className="welcome-lead">{signedOut ? 'Your session ended. Sign in again to carry on.' : 'Nothing was changed. Try again in a moment.'}</p>
    {signedOut ? <a className="button-link" href="/console/signin">Sign in</a> : <button type="button" className="primary" onClick={onRetry}>Try again</button>}
  </section>;
}

type Failure = 'unconfirmed' | 'changed' | 'refused';
const FAILURE: Record<Failure, string> = {
  unconfirmed: 'I couldn’t confirm that saved. Try again.',
  changed: 'Your settings changed while this page was open. I’ve refreshed them, so try again.',
  refused: 'That change wasn’t accepted. Reload the page and try again.',
};
function useSave({ reload, signedOut }: Pick<StepProps, 'reload' | 'signedOut'>) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const save = async (record: DayRecord, action: ControlAction, fields: ControlFields, saved: (day: DayRecord) => boolean): Promise<boolean> => {
    if (busy) return false;
    setBusy(true); setFailure(null);
    let outcome: Failure | 'recorded';
    try {
      const { receipt } = await submitControl(record, action, fields, crypto.randomUUID());
      outcome = receipt.state === 'recorded' ? 'recorded' : receipt.state === 'rejected' ? 'refused' : 'unconfirmed';
    } catch (error) {
      if (error instanceof SignInRequired) { setBusy(false); signedOut(); return false; }
      outcome = !(error instanceof ControlsActionError) || error.uncertain ? 'unconfirmed' : error.code === 'invalid_action' ? 'refused' : 'changed';
    }
    // The read decides: a lost response whose change landed still counts, and a stale form gets fresh values.
    const fresh = await reload().catch((error: unknown) => { if (error instanceof SignInRequired) signedOut(); return null; });
    setBusy(false);
    if (outcome === 'recorded' || (fresh && saved(fresh.day))) return true;
    setFailure(outcome);
    return false;
  };
  return { busy, failure, save };
}
```

**Meet**
- `const [device] = useState(deviceZone)`.
- Shown zone: `confirmed ? timezone : device`. With none, the "choose" form shows straight away.
- Primary "Use this time zone": `save(reads.day, 'timezone.set', { value: zone }, d => d.data.timezone_confirmed && d.data.timezone === zone)`, then `advance()`.
- "Choose another time zone" opens `<form className="control-form" onSubmit={…}>` with a `required` text input. The handler trims, rejects `!validZone(typed)` with inline copy and no POST, then saves the same way.
- Busy buttons use `aria-disabled` plus a handler guard, so they keep focus.
- Local clock: `new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date())` in a try.

**Your day**
- One `<form className="control-form" onSubmit={event => { event.preventDefault(); if (start && end) void submit(); }}>`, so the browser enforces `required` on both `type="time"` inputs. The handler also refuses empty values.
- Defaults: `proactivity.quiet_start ?? QUIET_DEFAULT.start` and likewise for the end.
- If both equal the saved values, the `type="submit"` primary reads "Continue" and submit just advances.
- Otherwise: `save(reads.day, 'proactivity.set', { quiet_start: start, quiet_end: end, volume: reads.day.data.proactivity.volume }, d => d.data.proactivity.quiet_start === start && d.data.proactivity.quiet_end === end)`. Volume is passed through unchanged; the schema requires it.
- Preview: `<DayRail marks={[]} now={localMinutes(new Date(), zone) ?? 0} quiet={from !== null && to !== null ? { start: from, end: to } : null} summary={`Quiet from ${start} to ${end}, ${zoneName(zone)}.`}/>`, with `from = clockMinutes(start)` and `to = clockMinutes(end)`.

**Connect: state, start and watch**
```tsx
type Watch = Readonly<{ href: string; before: ReadonlyMap<string, GoogleHealth>; round: number }>;
type Connect = { kind: 'idle' } | { kind: 'starting' } | { kind: 'failed' } | ({ kind: 'ready' | 'waiting' | 'timeout' } & Watch)
  | { kind: 'saved'; email: string } | { kind: 'broken'; email: string };

function ConnectStep({ reads, reload, advance, signedOut }: StepProps) {
  const [state, setState] = useState<Connect>({ kind: 'idle' });
  const open = useRef<HTMLAnchorElement>(null), proceed = useRef<HTMLButtonElement>(null);
  // Google may have finished in the other tab while this step was off screen.
  useEffect(() => {
    const abort = new AbortController();
    fetchOverview(abort.signal).then(overview => {
      if (!abort.signal.aborted && googleArrival(accountHealth(reads.connections), overview.services)) void reload().catch(() => null);
    }, () => undefined);
    return () => abort.abort();
  }, []);
  const start = async () => {
    if (state.kind === 'starting') return;
    const before = accountHealth(reads.connections);
    setState({ kind: 'starting' });
    try {
      const { receipt } = await submitControl(reads.connections, 'google.connect', { value: 'calendar' }, crypto.randomUUID());
      setState(receipt.state === 'recorded' && receipt.navigation ? { kind: 'ready', href: receipt.navigation, before, round: 0 } : { kind: 'failed' });
    } catch (error) {
      if (error instanceof SignInRequired) return signedOut();
      setState({ kind: 'failed' });
      await reload().catch(() => null);
    }
  };
  const watch = () => setState(s => s.kind === 'ready' || s.kind === 'timeout' ? { ...s, kind: 'waiting', round: s.round + 1 } : s);
  useEffect(() => { if (state.kind === 'ready') open.current?.focus(); if (state.kind === 'saved') proceed.current?.focus(); }, [state.kind]);
  useGoogleWatch(state, service => {
    setState(service.health === 'access_granted' ? { kind: 'saved', email: service.email } : { kind: 'broken', email: service.email });
    void reload().catch(() => null);
  }, () => setState(s => s.kind === 'waiting' ? { ...s, kind: 'timeout' } : s), signedOut);
  // Render per "UI and copy › Connect". The anchor in ready, waiting and timeout is
  // <a ref={open} className="button-link" href={state.href} target="_blank" rel="noopener noreferrer" onClick={watch}>Open Google<NewTab/></a>
  // "Check again" in timeout calls watch(); "Try again" in failed and broken calls start(); "Continue" in saved is <button ref={proceed} …>.
}

function useGoogleWatch(state: Connect, arrived: (service: OverviewV1['services'][number]) => void, expired: () => void, signedOut: () => void) {
  const handlers = useRef({ arrived, expired, signedOut }); handlers.current = { arrived, expired, signedOut };
  const waiting = state.kind === 'waiting' ? state : null;
  useEffect(() => {
    if (!waiting) return;
    const { before } = waiting, deadline = Date.now() + GOOGLE_WAIT_MS;
    let stopped = false, timer = 0, controller: AbortController | null = null;
    const stop = () => { stopped = true; window.clearTimeout(timer); controller?.abort(); };
    const schedule = () => { window.clearTimeout(timer); if (!stopped) timer = window.setTimeout(check, GOOGLE_POLL_MS); };
    // A hidden tab never expires: the person is in Google, and the read on their return decides.
    const check = () => {
      if (stopped) return;
      if (!shouldPoll(document.visibilityState)) { schedule(); return; }
      controller?.abort(); const mine = controller = new AbortController();
      fetchOverview(mine.signal).then(overview => {
        if (mine.signal.aborted || stopped) return;
        const service = googleArrival(before, overview.services);
        if (service) { stop(); handlers.current.arrived(service); }
        else if (Date.now() > deadline) { stop(); handlers.current.expired(); }
        else schedule();
      }).catch((error: unknown) => {
        if (mine.signal.aborted || stopped) return;
        if (error instanceof SignInRequired) { stop(); handlers.current.signedOut(); } else schedule();
      });
    };
    const wake = () => { if (document.visibilityState === 'visible') { window.clearTimeout(timer); check(); } };
    document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake);
    check();
    return () => { stop(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); };
  }, [waiting?.round]);
}
```

Other Connect cases:
- **Already connected.** On entry, or after the mount read triggers `reload()`, a non-empty `granted(reads.connections)` shows those emails with an "Access saved" chip, primary "Continue", and "Add another Google account", which calls `start()`.
- **Connect unavailable.** If `!reads.connections.data.google.connectAvailable`, the step shows the unavailable copy and "Continue".
- **Layout.** The Google tile is `<section className="tile welcome-permission reveal" aria-labelledby="welcome-google">`. The Body data tile is `<section className="tile welcome-body-data reveal" aria-labelledby="welcome-body-data">`.

**All set**
- `DoneStep({ reads, reload, goTo, onFinish }: StepProps & { goTo: (id: StepId) => void; onFinish: () => void })` calls `reload()` once on mount, best effort.
- Rows come from `reads`. An unsaved row gets a quiet "Set it now" button that calls `goTo('meet' | 'day' | 'connect')`.
- The next-steps note is one element, `<p className="welcome-note">`. It renders one of two fixed sentences from `reads.day.data.timezone_confirmed`.
- Primary "Go to Today" calls `onFinish`.

**Today card**
```tsx
export function WelcomeResume({ services }: { services: OverviewV1['services'] }) {
  const [shown, setShown] = useState<{ day: DayRecord | null } | null>(null);
  useEffect(() => {
    const local = readLocal();
    if (!local.started || local.done || local.dismissed) return;
    const abort = new AbortController();
    // The read only words the card; if it fails, the card still leads back with its plain line.
    fetchControls('day', abort.signal).then(day => day, () => null).then(day => { if (!abort.signal.aborted) setShown({ day }); });
    return () => abort.abort();
  }, []);
  if (!shown) return null;
  const open = openSetup(shown.day, services);
  return <section className="tile welcome-resume reveal" aria-labelledby="welcome-resume-title">
    <h2 id="welcome-resume-title">Pick up where you left off.</h2>
    {open.zone && <p>Your time zone isn’t confirmed, so I’m not scheduling anything for you yet.</p>}
    {open.google && <p>Google isn’t connected, so I can’t see your calendar or mail.</p>}
    {!open.zone && !open.google && <p>You’re nearly done.</p>}
    <div className="control-actions"><a className="button-link secondary" href="#/welcome">Finish setting up</a>
      <button type="button" className="quiet" onClick={() => { writeLocal({ dismissed: true }); setShown(null); }}>Not now</button></div>
  </section>;
}
```

**S4 seam (Say hello; whichever of S3 and S4 lands second does this, in S3's files):**
- **`welcome-model.ts`.**
  - Add `'hello'` to `StepId`, and insert `{ id: 'hello', label: 'Say hello', title: 'Tell me a little about you.' }` before `done`.
  - Extend `WelcomeReads` with `chat: ChatPage | null` (S4's `chat-model.ts`).
  - Add `hello: reads => (reads.chat?.messages.length ?? 0) > 0` to `finished`.

  `finished` stays the only place that decides resume. The chat read is S4's `GET /console/dashboard/api/v1/chat?limit=1` through `fetchChat({ limit: 1 }, signal)`. [inference] Rows in the main chat imply that the owner has sent at least once, because the Brief, Check-in and Close arm only after a send binds `app_subject` (`owner-do.ts:1072,1716-1733`).
- **`Welcome.tsx` `readAll`.** Add the chat read, keeping `SignInRequired` fatal and making anything else non-fatal, so a chat outage (S4's route fails closed with a 503 without its limiter binding) never blocks the flow:

  `fetchChat({ limit: 1 }, signal).catch((error: unknown) => { if (error instanceof SignInRequired) throw error; return null; })`
- **`Welcome.tsx` step switch.** Render:

  `current.id === 'hello' ? <SayHello variant="welcome" onSkip={props.advance} onSent={() => { window.location.hash = '#/chat?from=welcome'; }}/>`

  `onSent` writes nothing local, because the chat read marks the step done on return. The footer's "Skip for now" stays limited to `meet` and `day`, since `SayHello` has its own skip.
- **`DoneStep`.** S4 replaces the `welcome-note` element with the copy true once chat exists.

**S5 seam:**
- S5a imports `IPHONE_WAITLIST_URL` from `./links`.
- S5b changes `Welcome`'s `finish` to `(to = '#/today') => { writeLocal({ done: true }); onLeave(); window.location.hash = to; }` and `DoneStep`'s `onFinish` prop to `(to?: string) => void`. It then adds a quiet "Show me around" button that calls `onFinish(TOUR_HASH)` (`'#/today?tour=1'`, which resolves to Today). That sets `done`, so the resume card does not sit under the tour.

**S6 seam:**
- In `ConnectStep`, S6 inserts `<IMessageLink placement="welcome"/>` as a sibling directly after the Google tile's closing `</section>` (`aria-labelledby="welcome-google"`) and before the Body data tile (`className="tile welcome-body-data …"`).
- It renders nothing when hidden, so the step needs no conditional.

Write no comment in code that names a slice or a PR (`mental-model.md` §5).

**6. `packages/dashboard-app/src/App.tsx`**
- Imports: add `import { Welcome, WelcomeResume } from './Welcome';`.
- `:21`: add `'welcome'` to the `Route` union.
- `resolveRoute`: insert `if (value === 'welcome') return 'welcome';` before `:35`. `'welcome?x'` resolves through the split at `:30`, and `'welcome/x'` stays not-found.
- Today: insert `<WelcomeResume services={data.services}/>` between the page heading (`:99`) and the rail tile (`:100`).
- `App()`: after `const ready = …` (`:206`) and before `return <div className="console-shell">` (`:207`), add `if (route === 'welcome') return <Welcome onLeave={() => setRetry(n => n + 1)}/>;`. All hooks sit above this line. `onLeave` re-reads the overview, so Today greets in the new zone straight away.
- Do not touch `:67,126,210` (S5's 'dashboard' copy) or `:217`.

**7. `packages/dashboard-app/src/style.css`.** Append at the end of the file. Use only existing tokens; the health guard does not scan `.css` (`guard-health-leak.mjs:24`).
```css
/* Welcome: the first run, full screen, one step at a time. */
.welcome { display:flex; flex-direction:column; min-height:100vh; min-height:100dvh; max-width:600px; margin:0 auto; padding:0 28px calc(32px + env(safe-area-inset-bottom)); outline:none; }
.welcome-top { display:flex; align-items:center; justify-content:space-between; gap:16px; height:60px; }
.welcome-steps ol { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0,1fr); gap:6px; margin:4px 0 0; padding:0; list-style:none; }
.welcome-steps li { display:grid; gap:6px; font-size:12.5px; color:var(--t2); overflow-wrap:anywhere; }
.welcome-steps li i { display:block; height:3px; border-radius:2px; background:var(--fill-2); }
.welcome-steps li.done i,.welcome-steps li.current i { background:var(--ink); }
.welcome-steps li.current { color:var(--ink); font-weight:500; }
.welcome-body { padding:36px 0 8px; }
.welcome h1 { font-family:var(--serif); font-weight:460; font-size:clamp(1.9rem,1.55rem + 1.2vw,2.4rem); letter-spacing:-.01em; line-height:1.1; outline:none; }
.welcome-lead { font-size:16px; color:var(--t2); margin:12px 0 22px; max-width:46ch; }
.welcome .tile p,.welcome-note,.welcome-hint { color:var(--t2); }
.welcome .tile .welcome-purpose { font-size:16px; color:var(--ink); }
.welcome-hint { font-size:13px; }
.welcome-zone { display:grid; gap:2px; margin:14px 0 4px; }
.welcome-zone strong { font-size:20px; overflow-wrap:anywhere; }
.welcome-actions { display:grid; gap:8px; margin-top:18px; }
.welcome-actions>* { width:100%; }
button.secondary,.button-link.secondary { background:transparent; color:var(--ink); box-shadow:inset 0 0 0 1px var(--hair-strong); }
button.secondary:hover:not(:disabled),.button-link.secondary:hover { background:var(--fill); }
button[aria-disabled=true] { opacity:.6; cursor:progress; }
.welcome-error { color:var(--ink); margin-top:12px; }
.welcome-permission-head { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
.welcome-permission-head h2 { margin:0; flex:1; }
.welcome-icon-tile { display:inline-flex; gap:6px; padding:10px; border-radius:14px; background:var(--fill); }
.welcome-icon-tile .logo { width:22px; height:22px; }
.welcome-lists { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin:16px 0; }
.welcome-lists h3 { font-size:13px; margin-bottom:8px; }
.welcome-lists ul { display:grid; gap:8px; margin:0; padding:0; list-style:none; font-size:14px; color:var(--ink); }
.welcome-lists li { display:flex; gap:8px; align-items:flex-start; }
.welcome-lists .icon,.welcome-cross { flex:none; width:14px; height:14px; margin-top:3px; }
.welcome-cross { fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; }
.welcome-status { font-size:13.5px; color:var(--t2); margin-top:10px; }
.welcome-help { margin-top:14px; border-top:.5px solid var(--hair); }
.welcome-summary { list-style:none; margin:0; padding:0; }
.welcome-summary li { display:grid; grid-template-columns:110px minmax(0,1fr) auto; gap:12px; align-items:center; padding:12px 0; border-top:.5px solid var(--hair); }
.welcome-summary li:first-child { border-top:0; }
.welcome-app { display:grid; grid-template-columns:120px minmax(0,1fr); gap:18px; align-items:center; }
.welcome-footer { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:auto; padding-top:24px; }
@media(max-width:640px) {
  .welcome { padding:0 16px calc(24px + env(safe-area-inset-bottom)); }
  .welcome-top { height:54px; }
  .welcome-body { padding:24px 0 8px; }
  .welcome-lists,.welcome-app { grid-template-columns:1fr; }
  .welcome-summary li { grid-template-columns:minmax(0,1fr) auto; }
  .welcome-summary li>:first-child { grid-column:1 / -1; }
  .welcome-app .figure { max-width:160px; margin:0 auto; }
}
```
- No new assets, fonts or `import()`, so the build still emits one JS file and one CSS file (`verify-assets.mjs:4-7`).
- The cross mark is inline SVG reusing the path at `Infographics.tsx:65`.
- In TSX, never set `fontWeight` or any style key containing "weight" (guard-health-leak's `weight` token).

**8. `packages/dashboard-app/scripts/preview.mjs`** (synthetic, local only, never bundled; `:1`)
- `:6`: add `'fresh'` to `cases`.
- `:21-25`: add `timezone_confirmed: true` to the base `day` fixture, or the existing preview's Your day page fails the stricter reader.
- Add fresh-owner state: `const fresh = { zone: 'UTC', confirmed: false, quiet: [null, null], connectedAt: 0 };`.
  - Accounts appear 8 s after the connect action: `[{ id: 'synthetic-google', email: 'sample@example.test', calendar: true, mail: true, tasks: true, health: 'access_granted' }]`.
  - For `fresh`:
    - **day read**: `{ timezone, timezone_confirmed, date, cards: <three base cards, reason 'not planned yet', sent false, pin null>, proactivity: { quiet_start, quiet_end, volume: 'normal' } }`
    - **connections read**: `{ google: { connectAvailable: true, accounts }, telegram: { linked: false, unlinkAvailable: false }, sessions: { until, count: 1, items: [{ signed_in, until, current: true }] } }`
    - **overview**: the `empty` shape with `timezone: fresh.zone` and `services` built from the same accounts (`account_id`, `email`, `grants: ['calendar','gmail','tasks']`, `health`)
- Add `POST /console/dashboard/api/v1/actions` for `fresh` only:
  - Parse the body with `await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()`.
  - `timezone.set` and `proactivity.set` update `fresh` and return `{receipt:{state:'recorded',message},duplicate:false}`.
  - `google.connect` sets `connectedAt` and returns `navigation: 'https://accounts.google.com/o/oauth2/v2/auth'`. The SPA refuses a `/c/` path on `http://127.0.0.1` (`controls-model.ts:153`); the bare Google endpoint is the other destination it allows, and the new tab only shows a Google error page.

### UI and copy

Global rules:
- Copy uses the typographic apostrophe `’`, as the console does (`App.tsx:47`).
- Waldo speaks as "I"; chrome says "Waldo".
- No exclamation marks.
- Body text is `--t2` (4.82:1 on canvas, 5.35:1 on white; computed with node), never `.label`/`.meta` (`--t3` is 3.16:1).
- One ink primary per screen. "Continue without it" and the waitlist link are `secondary`, an outline.
- Phone (≤640px): 16 px gutters, no horizontal scroll, every action full width, buttons at least 44 px (`style.css:409`).
- Reduced motion turns the rise off (`style.css:433-435`).

**Frame (every state)**
- `main.welcome#main`, max-width 600.
- Top row: `WaldoMark` + "Waldo", and a `.quiet-link` "Finish later" to `#/today`.
- A visually hidden polite live line, mounted from first paint, reads "Step 2 of 4: Your day". Because it exists before the steps load, the first step is announced too.
- Progress row: `div.welcome-steps > ol aria-label="Setup steps"` with Meet · Your day · Connect · All set. Finished and current bars are ink; upcoming bars are `--fill-2`. The current item has `aria-current="step"`, and finished items carry a hidden ", done".
- The Mottle 460 `h1` gets focus on every step change.
- Footer: quiet "Back" (not on Meet) and quiet "Skip for now" (Meet and Your day).
- Loading: skeleton with hidden "Checking your settings…".
- Problem state: `section role="alert"` with its `h1` focused.
  - Signed out: "Sign in to your Waldo." / "Your session ended. Sign in again to carry on." / link "Sign in" to `/console/signin`.
  - Read failed: "I couldn’t read your settings." / "Nothing was changed. Try again in a moment." / primary "Try again".

**Meet**
- h1 "Hello. I’m Waldo."
- lead "I’m your personal assistant. I read what you connect, plan around your day, and ask before anything counts."
- `.tile`:
  - h2 "A few things I’ll need."
  - p "First, your time zone. I plan your day in it, and I don’t schedule anything for you until you’ve confirmed it."
  - `.welcome-zone`: hint "This device", strong "{India Standard Time}", hint "{Asia/Kolkata} · It’s {7:42 pm} there now."
- Actions: primary "Use this time zone" (busy "Saving your time zone…"); secondary "Choose another time zone".
- Choosing:
  - form label "Time zone", hint "A name like Europe/London or America/New_York."
  - primary "Save time zone"
  - invalid: "I don’t know that time zone. Try a name like Europe/London."
- No device zone: the form shows straight away, with "I couldn’t read this device’s time zone. Type yours below."
- Confirmed already: hint "Saved", strong "{zone name}"; primary "Continue", secondary "Change it".
- Errors (`role="alert"`, `.welcome-error`): the three `FAILURE` lines.

**Your day**
- h1 "When should I stay quiet?"
- lead "During quiet hours I hold cards, updates and event briefs. Reminders you set still go off." (matches `Controls.tsx:57`)
- `.tile`:
  - `DayRail` preview with a quiet band, aria-label "Quiet from 22:00 to 07:00, {zone name}."
  - Fields "Quiet from" and "Quiet until" (`required`).
  - hint "In {zone name} time. You can change this any time in Settings › Your day."
- Submit "Save quiet hours" (busy "Saving quiet hours…"). When unchanged from a saved value it reads "Continue", with an `access-label done` "Saved".
- Errors: the `FAILURE` lines.

**Connect**
- h1 "Connect your calendar and mail."
- lead "Calendar and mail are how I learn what’s on your plate. You can do this later, too."
- Google tile:
  - Head: icon tile (Google Calendar and Gmail logos), h2 "Google" (`id="welcome-google"`), and an "Access saved" chip when an account is granted.
  - Purpose: "I read your calendar and mail to plan your day around what’s on it."
  - h3 "Waldo can" with checks:
    - "Read your calendar, mail, tasks, contacts and Drive files."
    - "Save email drafts in Gmail for you to review."
    - "Prepare calendar changes, task changes and emails for you to approve."
  - h3 "Waldo can’t" with crosses:
    - "Send an email, or change your calendar or tasks, until you approve that exact change."
    - "See your Google password."
  - Note: "Google asks for all of this on one screen and lets you pick the account. What’s kept from connecting: the access key Google issues, locked in Waldo’s key vault and never shown to the model, plus your Google name, email address and phone number if Google has one. Facts I save about you show in Memory, where you can remove them. Disconnect Google any time in Settings › Connections."
  - Sources: `google.ts:92`; `connections.ts:6-7`; `google.ts:42`; `tools/live/google.ts:356-366,373-401,403-433`; `tools/live/tasks.ts:11`; Memory forget at `dashboard-control-actions.ts:19`.
- States:
  - **Idle**: ink "Connect Google" (busy "Getting Google ready…"); secondary "Continue without it".
  - **Ready**:
    - p "Google is ready. Open it in a new tab, choose your account and approve. I’ll notice here when you’re done."
    - ink anchor "Open Google" + hidden "(opens in a new tab)", focused
    - secondary "Continue without it"
  - **Waiting**:
    - `role="status"` "Waiting for Google. Come back to this tab when you’re done."
    - the anchor stays, so the person can reopen Google
    - secondary "Continue without it"
  - **Saved**:
    - `role="status"`: "Access saved" chip and strong "{email}"
    - p "Google access is saved. You can disconnect it any time in Settings › Connections."
    - primary "Continue" (focused); secondary "Add another Google account"
  - **Broken**:
    - `role="status"` "Google sent {email}, but I couldn’t read it. Try again, or continue without it."
    - primary "Try again"; secondary "Continue without it"
  - **Timeout**:
    - `role="status"` "I haven’t seen a Google account yet. If you finished in Google, check again. If Google stopped you, see below."
    - secondary "Check again"; secondary "Continue without it"
  - **Failed** (rejected receipt, refused, stale, lost response or blocked navigation):
    - alert "Google didn’t start. Try again in a moment, or continue without it."
    - primary "Try again"; secondary "Continue without it"
  - **Unavailable**: "Google isn’t available on this server right now." and primary "Continue".
- Help: `details.disclosure.welcome-help`, summary "If Google stops you". The body has two paragraphs:
  - "If Google warns that it hasn’t verified Waldo: Waldo is still in Google’s testing stage, so the warning is expected. Choose Continue to go on."
  - "If Google says access is blocked (Error 403: access_denied): your Google account isn’t on Waldo’s testing list yet. Ask the person who invited you to add it, then connect again. Or continue without Google for now."

  The exact wording is Google's [inference]; the copy quotes only the error code.
- Body data tile:
  - h2 "Body data" (`id="welcome-body-data"`)
  - "Sleep and activity from your watch reach me through the iPhone app, not the browser."
  - secondary "Join the iPhone app waitlist" + hidden "(opens in a new tab)", `target="_blank" rel="noopener noreferrer"`

**All set**
- h1 "All set."
- lead "Here’s what’s saved. You can change any of it in Settings."
- `.tile ul.welcome-summary`, each row `name | value | state`:
  - "Time zone" | "{zone name} · {IANA id}", or "Not confirmed" | "Saved", or quiet "Set it now"
  - "Quiet hours" | "22:00 to 07:00", or "None" | "Saved", or "Set it now"
  - "Google" | "{email, email}", or "Not connected" | "Access saved", or "Set it now"
- `p.welcome-note` (S4 replaces this element):
  - Zone confirmed: "Here on the web you can see what’s waiting for you, what I’ve saved and what I’ve done. My Brief, Check-in and Close start after your first message to me. For now that happens in the iPhone app."
  - Zone not confirmed: "Here on the web you can see what’s waiting for you, what I’ve saved and what I’ve done. My Brief, Check-in and Close start once your time zone is confirmed and you’ve sent me your first message. For now that happens in the iPhone app."
- `.tile.welcome-app`:
  - `Phone` figure, label "A phone, an interactive illustration. Decorative."
  - h2 "The iPhone app"
  - "It’s where we chat and where your body data comes in. It isn’t open to everyone yet."
  - secondary "Join the iPhone app waitlist" (new tab)
- primary "Go to Today", which sets `done` and goes to `#/today`.

**Today card** (after a visit to `#/welcome`, not finished and not dismissed)
- `.tile` placed after the greeting.
- h2 "Pick up where you left off."
- Whichever lines apply:
  - "Your time zone isn’t confirmed, so I’m not scheduling anything for you yet."
  - "Google isn’t connected, so I can’t see your calendar or mail."
  - If neither: "You’re nearly done."
- secondary "Finish setting up" to `#/welcome`; quiet "Not now".

### Security, privacy and authority

- **No new endpoint, auth path or writer.** Reads are the existing owner-gated GETs: controls, and the overview, which is session-checked at `owner-do.ts:1379`. Writes are the existing csrf-, revision- and request-id-checked actions, allowlisted per view (`dashboard-control-actions.ts:19,46-72`; `console.ts:124-129`). Answers never reach memory: there is no `remember`, claims, goals or profile write.
- **Navigation.**
  - The only off-page destination is the receipt's same-origin `/c/<22>` path. It is validated twice: server `dashboard-control-actions.ts:22-27`, client `controls-model.ts:148-155`.
  - It opens with `rel="noopener noreferrer"`.
  - The ticket exists only in the anchor's `href` in the owner's own tab, and is never stored or logged by the SPA. It lives 12 h, and issuing a new one revokes the old.
  - The waitlist link is a fixed constant in `links.ts`, and the shell sends `referrer-policy: no-referrer` (`dashboard-overview.ts:8`).
- **Storage.** localStorage holds three booleans and nothing about the owner.
- **Health.**
  - The flow has no numbers; body data is described qualitatively.
  - Google detection polls the DO-local overview, so it never reads the health plane. A controls read would call `health_log_recent` (Current state).
  - `guard-health-leak` scans `.tsx`, so avoid health tokens next to number literals and any `fontWeight` key.
- **Rate limits and cost.**
  - Controls reads and actions are capped at 90 and 20 per minute per owner DO, returning 429 with `retry-after: 60` (`owner-do.ts:1464-1472`). Every tab shares the cap.
  - The flow uses about two controls reads per save and one per step entry. That is well under the cap, unless several console tabs are busy at once.
  - A 429 on a save surfaces as "I couldn’t confirm that saved. Try again." (`submitControl` → `outcome_unavailable`, then a reload that may also be limited). A 429 on the first read surfaces as "I couldn’t read your settings."
  - Polling is the uncounted overview: at most about 122 reads per 10-minute attempt, and none while the tab is hidden. App's own 15 s overview poll runs alongside.
- **Errors.** The flow never renders server receipt text or provider errors. React escapes emails and zones.
- **Logging and traces.** No logging and no model calls, so staging Langfuse capture is unaffected.
- **Security-review trigger: no.** It touches no auth flow, health path, RLS, DO memory write or EF (`AGENTS.md:90-97`). One independent review on the exact head.

### Tests

Unless noted, every test is local vitest in `packages/dashboard-app` (not run by CI; record it as LOCAL). Interactive files use `// @vitest-environment happy-dom`, `createRoot` and `act`, as in `App.live.test.tsx:1-37`. Do not add a testing library.

Shared setup for `Welcome.test.tsx`:
- Call `(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://console.test/console/dashboard#/welcome')`. https is required for navigation (`controls-model.ts:153`).
- Spy `vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')` to return `{ ...real, timeZone: 'Asia/Kolkata' }`.
- Use an in-memory fetch stub with the preview's fresh state. It serves `controls?view=day|connections`, `overview` and `POST actions`, and records `[url, method, FormData]`.
- Use a JSON helper `new Response(JSON.stringify(body), { status })`.
- Add a capturing `document` click listener that calls `preventDefault()` only on `a[target="_blank"]`, so same-tab hash links still navigate.
- Use `vi.useFakeTimers()` for polling, and `localStorage.clear()` in `afterEach`.

**`src/welcome-model.test.ts`** (node env)
- `resumeStep`:
  - fresh owner → `meet`
  - confirmed → `day`
  - plus quiet → `connect`
  - plus an `access_granted` account → `done`
  - only `needs_reconnect` → `connect`
- `googleArrival`:
  - a new id that is `access_granted` → returned
  - a new id that is `needs_reconnect` → returned
  - a known id going from `needs_reconnect` to `access_granted` → returned
  - a known id going from `access_granted` to `needs_reconnect` → `null`
  - no change → `null`
- `openSetup`: `null` day → `zone:false`, and every combination of the rest.
- `deviceZone` returns `null` for an `undefined` or invalid zone.
- `zoneName('Asia/Kolkata') === 'India Standard Time'`, and an invalid zone returns itself.
- `readLocal` without storage returns all false.

**`src/Welcome.test.tsx`** (happy-dom)
1. **Golden: fresh owner, end to end.** Render `<Welcome onLeave={spy}/>`.
   - The live line reads "Step 1 of 4: Meet". "India Standard Time" and "Use this time zone" show.
   - Click "Use this time zone". The POST is `{csrf, revision: <day revision>, view: 'day', action: 'timezone.set', value: 'Asia/Kolkata'}`, and `request_id` matches `/^[A-Za-z0-9_-]{8,80}$/`.
   - "Step 2 of 4: Your day" appears with `value="22:00"`/`"07:00"`. Submitting the form sends `{action: 'proactivity.set', quiet_start: '22:00', quiet_end: '07:00', volume: 'normal', view: 'day'}`, with the **re-read** day revision.
   - On Connect, "Connect Google" sends `{action: 'google.connect', value: 'calendar', view: 'connections'}`. The receipt `/c/AAAAAAAAAAAAAAAAAAAAAA` renders an anchor with `href="https://console.test/c/AAAAAAAAAAAAAAAAAAAAAA"`, `target="_blank"` and a `rel` containing `noopener`, and it has focus.
   - Click the anchor; the stub adds an `access_granted` service. Within 5 s the "Access saved" status and the email show, "Continue" has focus, and the text "Connected" appears nowhere.
   - All set shows "India Standard Time · Asia/Kolkata", "22:00 to 07:00", the email and the confirmed-zone sentence. The waitlist `href === 'https://www.heywaldo.in/waitlist'` with `target="_blank"`.
   - "Go to Today" sets `location.hash === '#/today'`, calls `spy` once, and sets `localStorage['waldo.welcome.v1'].done` to true.
   - Exactly 3 POSTs. All Google detection reads are `overview` URLs.
2. **Chrome hidden.** `<App/>` at `#/welcome`, with the overview, controls and admin (404) stubbed. No `.topbar`, no `.primary-nav`, no `/console/legacy` link; the h1 reads "Hello. I’m Waldo.".
3. **Resume.**
   - Confirmed + quiet + no Google → "Step 3 of 4: Connect". Back → Your day shows the saved times and "Continue", and submitting posts nothing.
   - Everything done → "All set.".
4. **Skip and Back.**
   - Skip, Skip, then "Continue without it" → All set shows "Not confirmed", "None", "Not connected" and the **unconfirmed** sentence.
   - "Set it now" on Time zone → Meet.
   - Zero POSTs.
5. **Late save after Skip.** Hold the `timezone.set` fetch on a deferred promise, click Skip, then resolve it as recorded. The page stays on Your day.
6. **Null and empty.**
   - `timeZone` undefined → the form shows "I couldn’t read this device’s time zone…".
   - `Mars/Olympus` → "I don’t know that time zone…" and no POST.
   - A cleared "Quiet from" plus submit → no POST.
   - `connectAvailable:false` → the unavailable copy and no Connect button.
7. **Revoked or expired.**
   - The day GET returns 401 → `role="alert"` with "Sign in to your Waldo.", the h1 focused, and `href="/console/signin"`.
   - On a second run, the `proactivity.set` POST returns 401 → the same state, and no fetches after it.
8. **Network failure mid-flight.**
   - The `timezone.set` fetch rejects with `TypeError` and the re-read shows it confirmed → the flow advances.
   - Same rejection, re-read unconfirmed → "I couldn’t confirm that saved. Try again." and the step does not change.
   - The POST returns 429 `{error:'rate_limited'}` → the same unconfirmed line.
9. **Stale.** The POST returns 409 `{error:'stale_read'}` → the changed-settings line shows, and the next POST carries the new revision.
10. **Google rejected.** A 409 rejected receipt shows "Google didn’t start…" with no `/c/` anchor. "Try again" posts with a new `request_id`.
11. **Arrives broken.** After the anchor click, a new service appears as `needs_reconnect`. "Google sent … but I couldn’t read it" shows, with no "Access saved".
12. **Poll timeout, bounded.** The stub never adds a service. Count overview GETs from the anchor click, then advance 10 min + 10 s:
    - "I haven’t seen a Google account yet." shows;
    - `100 ≤ n ≤ 123`;
    - zero controls GETs during the window;
    - the POST count stays 1.

    "Check again" makes one immediate overview GET.
13. **Hidden tab and slow return.**
    - Set `Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })` after the click and advance 11 min: zero overview GETs, and no timeout copy.
    - Add the service, set `visible` and dispatch `visibilitychange`: exactly one GET, then "Access saved".
14. **Back stops the poll; re-entry catches up.**
    - While waiting, click Back and advance 30 s: zero overview GETs.
    - Add the service and go forward to Connect: the mount overview read triggers one `reload()`, and "Access saved" with the email shows.
15. **Finish later.** Clicking it calls `onLeave` once and sets `location.hash === '#/today'`. `done` stays false.
16. **Hostile input.**
    - (a) A service email of `<img src=x onerror=alert(1)>` renders as text, and `img[src="x"]` is absent.
    - (b) Receipt navigation `https://evil.test/c/AAAAAAAAAAAAAAAAAAAAAA` → no such `href`, and the failed alert shows.
    - (c) Zone input `"><script>alert(1)</script>` → no POST and no `script` element.
17. **Today card (`WelcomeResume`).**
    - No marker → `fetch` never called; nothing renders.
    - `{started:true}`, day unconfirmed, `services: []` → both lines and `href="#/welcome"`. "Not now" removes the card and sets `dismissed`, and a remount makes no fetch.
    - **Second-tab case:** started, everything done, not `done` → "You’re nearly done.".
    - `done:true` → no fetch.
    - Day read 503 → the card shows with the Google line or the plain line, with no zone line.
    - `Storage.prototype.getItem` throws → no fetch, no card, no throw.

**Extend existing files**
- `src/controls-model.test.ts:5`: add `timezone_confirmed: false` to the fixture. New cases: the reader throws 'unsupported' when the field is missing or is the string `'true'`, and carries `true`/`false` through.
- `src/Controls.test.tsx:6`: add `timezone_confirmed: true` to the typed fixture.
- `src/App.test.tsx`: `resolveRoute('welcome') === 'welcome'`, `resolveRoute('welcome?owner=other') === 'welcome'`, `resolveRoute('welcome/x') === 'not-found'`. The `:7` nav pin stays unchanged and green.

### Acceptance trace

The labels are SOURCE, LOCAL (dashboard vitest, not in CI), CI (typecheck, build and `verify:assets`, `verify.yml:115`) and STAGING (manual, after a deploy with authority). LIVE does not apply.

1. **SOURCE + LOCAL:** tests 1–17 and the extended files pass at the PR head SHA. Paste the counts; the baseline is 31 files / 216 tests.
2. **CI:** typecheck, build and `verify:assets` are green. The build still emits one JS file and one CSS file.
3. **STAGING (after deploy; after the demo).** Use a fresh browser profile on desktop and on a phone (390 wide).
   - (a) Open an admin-issued invite link and sign up. With S2 the browser lands on `/console#/welcome`; without S2, open it by hand. Expect "Hello. I’m Waldo.", the progress row with Meet as current, and no nav or tab bar.
   - (b) "Use this time zone". The strong line shows the zone's name (for example "India Standard Time"). In devtools, `GET …/controls?view=day` returns `"timezone_confirmed":true`.
   - (c) Save 22:00 to 07:00. Settings › Setup shows "Set quiet hours · Setting recorded".
   - (d) Needs S1 deployed and a Google test user.
     - "Connect Google", then "Open Google" opens a new tab.
     - Google shows its unverified-app warning; choose Continue and approve. The callback says "Google is connected".
     - Close that tab. The welcome tab shows "Access saved" and the email within about 5 s.
     - Devtools shows the detection reads hitting `/overview`, not `/controls`.
   - (e) Instead tap "Back to your console" on the callback page. That second tab shows Today with "Pick up where you left off. You’re nearly done.", and "Finish setting up" lands on All set.
   - (f) A non-test Google account is blocked by Google. The help disclosure explains why, and "Continue without it" works.
   - (g) All set rows match the reads, and the next-steps sentence matches the zone state. The waitlist opens `heywaldo.in/waitlist` in a new tab. "Go to Today" shows the greeting in the new zone, with no card.
   - (h) With a second fresh account, skip Connect and use "Finish later". Today shows the card with the Google line. "Not now" hides it, and a reload keeps it hidden.
   - (i) On the phone: no horizontal scroll and full-width actions. VoiceOver reads the step title on load and "Step n of 4" on each change.
4. **Without S1**, step 3(d) shows "Google didn’t start…". Record that as the expected pre-S1 result, not a pass.
5. **Screenshots.** Use the local preview: `--case=fresh`, desktop 1440×900 and phone 390×844.
   - welcome-meet and welcome-meet-choose
   - welcome-day
   - welcome-connect and welcome-connect-ready
   - welcome-connect-saved: wait with Playwright `getByText('Access saved')`, up to 15 s, never a fixed sleep
   - welcome-done
   - today-resume: restart the preview, use "Finish later" on Connect, then open `#/today`

   Restart the preview between runs, because its state is in memory. Captions must contain no email, invite or code.

### Verification commands

Run from `/home/user/waldo-backend` at the PR head and record PASS, FAIL, NOT RUN or UNAVAILABLE for each.
```bash
git diff --check
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app typecheck
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app test            # LOCAL only, not in CI (baseline 31 files / 216 tests at a643bcab)
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app build
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app verify:assets
npx -y pnpm@10.34.4 --filter @waldo/runtime exec vitest run test/dashboard-static-worker.test.ts test/dashboard-controls.test.ts   # 2 files / 15 tests PASS at a643bcab
WALDO_DO_MIGRATION_BASE_REF=HEAD^1 npx -y pnpm@10.34.4 verify:guards   # guard-pgtap may be NOT RUN (downloads PG15)
npx -y pnpm@10.34.4 verify                                           # UNAVAILABLE in the cloud container: verify:supabase needs Docker
node packages/dashboard-app/scripts/preview.mjs --case=fresh --port=4190 &   # synthetic, local only
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node <scratch script using /opt/node-tools/node_modules/playwright>   # container paths
git status --short   # clean apart from the PR's files
```

### Rollback

Revert the S3 merge commit and redeploy. The change is SPA-only, so this is one Worker deploy that ships the previous assets.
- Settings the flow wrote (time zone, quiet hours, Google grants) are ordinary owner settings and stay valid.
- The localStorage key becomes inert, and `links.ts` goes with the revert.
- If S2 or S5a are already merged, revert them first or together:
  - S2's redirect would hit "Page not found" (`App.tsx:78`).
  - S5a imports `links.ts`.
- No migration, DO state or contract to unwind.

### Risks and open questions

1. **S1 not live, so Connect fails for console-only owners.** Default: ship S3 with the honest failure, and gate the Google part of the staging trace on S1.
2. **The demo freeze holds S3 until after the showcase.** Default: land it after the demo. Ask Ansh on #1103 only if the owner wants the flow in the showcase.
3. **Visitors not on the Google test-user list are blocked** (`google.ts:5`). Default: S0 adds them; S3 shows help copy and "Continue without it".
4. **Readback failures.** A non-401 readback failure still lists the account as `access_granted` (`owner-do.ts:2448` vs `:2457`). The welcome tab then says "Access saved" while the callback page says Google could not be connected. Default: accept it. "Access saved" claims only saved access, as the console's "read unverified" does, and Connections shows a reconnect if reads fail later. A 401 failure is handled as "broken".
5. **Watch upkeep does not run for web-only owners until they are bound** [inference]. Default: All set promises nothing about watching. S4's first chat changes that, and S4 rewrites the note.
6. **Dashboard tests are unenforced in CI.** Default: paste the local run in the PR. Adding them to `verify.yml` is a CI change that needs owner OK, so propose it separately.
7. **The saved zone can be the legacy ID** (`Asia/Calcutta`). Settings › Your day then shows that ID. Default: accept it. The server accepts it, and the welcome shows the zone's name.
8. **Mottle headlines appear only in the welcome.** Default: accept it; a later font pass aligns the console h1s.
9. **Shared demo devices.** The flags are owner-free and reset on entering `#/welcome`. Default: accept.
10. **The callback tab and the welcome tab stay open together.** The card resolves which tab finishes. Default: accept; the welcome tab also shows "Access saved" on return.

### Effort

**M, about 8 hours**, in the SPA lane only (`packages/dashboard-app`):
- model, reader and links, 1 h
- `Welcome.tsx`, 3.5 h
- CSS, 1 h
- tests, 2 h
- preview fresh case and screenshots, 0.5 h

Add 0.5 h for the staging trace after a deploy. No `owner-do.ts`, runtime, contracts, migrations, env vars or dependencies.

## S4 Console chat end to end, and Say hello

> **Status:** reviewed; the review found a sign-out blocker (sign-out waits behind a running turn) and three major issues, and the revision is in progress. It also splits S4 into S4a (console chat) and S4b (Say hello). Do not start S4 until this line is gone.

Citations are at the tree the implementing session will start from: `claude/focused-allen-85v68f` HEAD `a643bcab`, which carries `beta-mvp` `04bb8c89` (it moved past `e5c022ef` during planning: #1241, #1247, #1254, #1257 and others landed). Every `[verified]` line was read there. Re-check the line numbers against whatever tip you rebase onto.

### Outcome

A visitor who signed up on the web can talk to Waldo in the console. A chat button in the top bar opens `#/chat`. There, the person types, presses Enter and sees honest progress ("Waldo has your message.", then "Waldo is working on it."), then Waldo's reply. This is the same main chat the iPhone app shows, so the conversation carries over when they install it.

In the welcome flow, the **Say hello** step asks four skippable questions: their week, what slips, who matters, and how much Waldo should do on his own. Each question also has "Or say it your way". The answers are joined into an editable first message in the person's own words. Sending it opens the chat, where Waldo answers and, through the model's own judgement, gets to know them. Whatever he saves comes from `remember`, grounded in words the owner sent.

JTBD: "Let me tell Waldo who I am and start using him right now, from the browser I signed up in."

### Depends on / blocks

- **Demo freeze (hard gate on landing).** Ansh approved a freeze on #1103 at 19:27Z on 14 Oct. Only #1258, agent headroom, #1259, #1261 and #1227/#1240 merge before the showcase, and `owner-do.ts` belongs to the Mac lane. **Default: build and review S4 now, merge after the demo.** It lands before the demo only if Ansh adds it to the freeze list on #1103, and the Mac lane then sequences the `owner-do.ts` hunks.
- **#1260 (A2 PR 1, draft, frozen until after the demo).** Branch `claude/a2-owner-runtime`, now at head `e4a476ca`, not the `588ad87a` named on the PR, because it has since merged `beta-mvp` `04e02124`. It moves surface behaviour out of `owner-do.ts` into `surfaces/{telegram,app-runtime,imessage,whatsapp}.ts` and `surfaces/registry.ts`, and lowers the `owner-do.ts` surface-compare baseline from 58 to 26. S4's surface mechanism is built to work on both trees (see Design → "Surface capability").
  - **Recommended order: #1260 first, then S4 rebases.** On the A2 tree, two S4 lines move from `owner-do.ts` into `surfaces/app-runtime.ts`.
  - **If Ansh pulls S4 into the demo,** S4 lands first. #1260's next `beta-mvp` merge then carries the same two reads into `app-runtime.ts`. That is the A2 author's job, and this section spells it out.
- **S1** (persist origin on the console path). This is not a code dependency. Without it, though, the console connect guidance ("open Settings, then Connections") leads a console-only owner to "Google connect could not start". Land S1 first.
- **S3** (`#/welcome`). Whichever of S3 and S4 lands second wires the `SayHello` component into step 4. S4 does not wait for S3: `SayHello` also renders in the empty chat (two consumers).
- **#1227 / #1240** (Mac first conversation, both on the freeze list). They make Waldo lead the getting-to-know-you conversation. S4 neither depends on them nor edits their files. See Design → "Waldo's reply is model-led".
- **S2**: signup lands on `/console#/welcome`. This is soft: chat works from any landing.
- **Blocks S5.** S5's tour "chat entry" step, the "what Waldo saved" link from the chat and the "First chat" Setup row all need `#/chat` to exist.
- **Owner actions (S0).**
  - Staging Langfuse text capture is on, so visitors' hello text is captured.
  - Every visitor who sends a message gets scheduled work, which adds spend (see Risks).
  - Google test users.
- **Review.** `security-reviewer` is mandatory: auth flow, a new authenticated endpoint, and sign-out revocation (`AGENTS.md`, Security Review Triggers). Ask for the `owner-do.ts` slot on #1103 before opening the PR, on branch `onboarding/s4-console-chat`.

### Current state

What exists to reuse:

- **App chain, end to end.** [verified]
  - `appRoute` (`owner-do.ts:881-945`) checks the physical id, then `do_name`, then `appSessionAuthority` (`:889`). It binds `owner_principal_ref` (`:890-892`) and stores `origin` from a Worker-set header (`:893`), then dispatches: send (`:894` → `appSend` `:1069-1078`), receipt (`:900-905`), cancel (`:906-913`), history (`:938-943` → `appChatPage` `:948`).
  - `AppInbox.admit` is the single durable writer. It is idempotent on client id plus digest, and it commits the row and the wake before the 202 (`app-inbox.ts:45-68`).
  - `drainApp` re-reads authority before each claim (`owner-do.ts:1100`), runs `turn(…,'app',true,scope)` (`:1108`) and re-reads authority after the turn (`:1109`). The turn re-reads it again at `:1974-1980`, and `appAdmission` (`:842`) re-asks on every context step.
- **Cookie sessions already pass app authority.** [verified]
  - The owner cookie is minted through the same `console_session_open` row as the app bearer, signed under a `cookie.` context (`console-auth.ts:83-91,180`).
  - `waldo.app_session_authority` joins `waldo.console_sessions` by hash, active owner and an age under 12 hours, whichever artifact minted the row (`20261010010000_app_session_authority.sql:10-16`).
  - So `appSessionAuthority(name, cookieSessionHash)` succeeds today.
- **Console routing.** [verified]
  - `handleConsole` verifies the signed owner cookie, touching the directory (`console-signin.ts:340`, via `readOwnerCookie`).
  - It then forwards **the client's own headers** with only `x-waldo-do-name` replaced (`:350-351`).
  - Only the paths in its four duplicated lists answer 401 JSON, at `:342,347,355,360`. Any other path gets a 303 to sign-in. The SPA fetches with `redirect: 'error'` (`controls-model.ts:138,176`).
- **Inside the DO.** [verified]
  - `console()` checks the DO-local browser session at `owner-do.ts:1378-1379`; its `session.csrf` is what the SPA's actions send.
  - S1 (scratch copy) inserts its origin write directly after `:1379`.
- **CSRF pattern.** [verified] Controls reads return `csrf` in the record. Actions send it back as a form field and are compared with `!==` (`console.ts:126`). The workspace read returns `{version:1, csrf, …}` in a GET body too (`Workspace.tsx:5`).
- **Rate limiting.** [verified] `handleApp` spends `app-chat-send:<doName>` on sends and `app-read:<doName>` on reads and stops (`app-api.ts:155-158`). The binding allows 120 per 60 s per key (`wrangler.jsonc:42-44,104-106`). The DO can reach it as `this.env.RESPONSIBILITY_RATE_LIMITER` (used at `owner-do.ts:1401`).
- **History shape.** [verified] `appTranscriptPage` (`app-api.ts:213`) pages newest first, at most 50 per page, with cursor `before:<id>`. Each message is `{id, role, text, parts, channel, parent_id, created_at?}`. Approval parts sit on the newest reply to a run. A reader must ignore any part it cannot read and show `text` (`app-api.ts:205-207`).

What is broken or missing:

1. **No browser chat.** [verified] `resolveRoute` has no chat route (`App.tsx:26-37`). Nothing in `packages/dashboard-app/src` posts to a chat path.
2. **Stated invariant.** [verified] `console-auth.ts:46-47` says "a console cookie is never accepted as an app bearer", and `app-api.ts:50` says "it is never a console cookie". The owner approved replacing both (14 Oct).
3. **Single-browser sign-out is incomplete.** [verified]
   - It only deletes the DO-local session (`owner-do.ts:1514` dashboard path, `:1608` legacy path).
   - The directory row stays live for up to 12 hours, and queued or running app-chain work from that session is not fenced.
   - App sign-out, by contrast, fences, revokes and fences again (`app-api.ts:91-103,176-183`; `app-inbox.ts:85-97`).
4. **Wrong-surface guidance.** [verified] Both answers below are wrong in a browser.
   - On the `app` channel, `offerConnect` returns `APP_CONNECT_GUIDANCE`: "go back to Home, open the menu at the top left…" (`owner-do.ts:2236-2237`; `surfaces/app.ts:12`).
   - `send_console_link` answers `app_unsupported` (`owner-do.ts:2224-2232`).
5. **Guard ceiling.** [verified] `owner-do.ts` sits at its baseline of 58 surface compares; the guard run gives "ok (101 surface compares in 13 files)". The guard counts any `channel ===` / `surface ===`, any quoted surface name next to `===`/`!==`, and any `case '<surface>':`. `'console'` counts because it is in `surfaceNameV1Schema` (`scripts/guards/guard-surface-neutral-core.mjs`; `contracts/src/app/surfaces.ts:7`). S4 adds **zero** compares.
6. **Web-only owners get no scheduled work.** [verified] The alarm picks `app` only when `appOwnerLookup` admits, and that needs `app_subject` (`owner-do.ts:724-727,1723`). The first app-chain send binds it (`bindAppSubject` `:1079-1081`). On the `app` channel, jobs arm only once `timezone_confirmed` is true (`:2622`); until then they are held (`:1832`).

### Design

**Route placement.** The chat endpoints live inside `OwnerDO.console()`, right after the DO session check. Most of the logic sits in a new deep module, `channels/console-chat.ts`, behind a small host interface, following the same pattern as `appThreadsRequest` and `threadsHost` (`owner-do.ts:974`). `owner-do.ts` gains one dispatch line and one host method (~15 lines). Base `/console/dashboard/api/v1/chat`:

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/chat` | `?cursor=before:<id>&limit=1..50` | 200 `{version:1, csrf, messages: AppMessageV1[], next_cursor}` |
| POST | `/chat/messages` | `application/json` `{client_message_id, text}` (app schema) + header `x-waldo-csrf` | 202 `{accepted:true, message_id, state}` |
| GET | `/chat/messages/{client_message_id}` | none | 200 receipt (app receipt shape) / 404 |
| POST | `/chat/messages/{client_message_id}/cancel` | header `x-waldo-csrf` | 200 receipt / 404 |

**Session identity: derived, never forwarded.** The session hash comes from the signed `waldo_owner` cookie, re-verified **inside the DO** with the router secret. This check is a pure HMAC with no network call. The DO also checks that the cookie's `doName` equals its own `do_name`, and the directory is then asked through `appSessionAuthority` on every request.
- The DO never reads `x-waldo-app-session-hash`. `handleConsole` forwards client headers verbatim, so a header is attacker-controlled on this path.
- Rejected alternative: have the Worker set the header. It works, but it leaves a header-trusting route reachable from the ticket fallback (`index.ts:208-215`), which also forwards client headers.

**CSRF.** Every POST needs the DO session's `csrf` in `x-waldo-csrf`, and a send must be `content-type: application/json`.
- This sits on top of `SameSite=Strict` cookies. A custom header also forces a CORS preflight, which a cross-origin page cannot pass, because nothing answers CORS.
- A header is used rather than a body field because the app send schema is `strictObject`.

**Rate limit.** The same buckets and keys as the app: `app-chat-send:<doName>` for send, `app-read:<doName>` for history, receipt and cancel. One main chat gets one budget, whichever surface uses it. The route fails closed (503) when the binding is absent. The 2 s receipt poll costs 30 reads a minute per open tab, under 120.

**Same main chat.** Admission is `AppInbox.admit(name, cookieHash, clientId, text, ownerChainRef('app', principal), …, 'console')`. Messages ride `drainApp` and `turn('app')` unchanged, so there is no new writer, no new SQL and no new transcript.
- The user and assistant rows carry `surface: 'app'`, and the iPhone app shows them in Main.
- The inbox row text is cleared at settle (`app-inbox.ts:34`), exactly as for app messages. No new conversation-body storage is created, so the CLAUDE.md contract and ADR trigger does not fire.

**Intended effect: scheduled work turns on.** The first console send binds `app_subject`. From then on the alarm treats the owner as app-bound, and Briefs, Check-ins, Closes and nightly passes are written into this same main chat. They arm only after the zone is confirmed (S3's Meet step). That is what makes the console chat the web-only owner's home, and the history poll shows them. Implications: spend per visitor, and a Brief arriving in a chat the person may never reopen. Both are listed under Risks.

**Sign-out completes.** Single-browser sign-out (both paths) runs these steps in order:
1. Fence this session's app-chain rows: `AppInbox.revokeSession(hash)`, and abort the running turn if it belongs to this session.
2. Revoke the directory row with `auth.revokeSession`.
3. Fence again, for work admitted in between.
4. Delete the DO session.

If the revoke fails, the browser stays signed in with an `unconfirmed` receipt, the same posture as `signOutEverywhere` (`owner-do.ts:1332-1339`). No push revoke is needed [inference]: a console session never registers push, and no push registration path exists in `packages/runtime/src`.

**Surface capability, with no new compare.** The inbox row records what admitted it: `via?: 'console'`. A field-free table in `surfaces/app.ts` maps `via` to what the turn tells the model:

| via | connect guidance | console link |
|---|---|---|
| absent (app) | `APP_CONNECT_GUIDANCE` (unchanged) | `app_unsupported` |
| `console` | `CONSOLE_CONNECT_GUIDANCE` (new) | `in_console` (new, additive reason) |

The table is read per turn from `this.activeApp`.
- **Today:** `owner-do.ts:2227` and `:2237` read `appChatPresence(this.activeApp)`. The value changes, the compare count does not. The console-link entry is a getter, because `consoleLinkSender` reads `route.unsupported` at call time (`console-link.ts:40-41`) while the route object is built once per runtime.
- **On #1260:** the same helper is read in `surfaces/app-runtime.ts`, inside the adapter. There, `connectGuidance` becomes a getter over `host.activeApp()`, and `consoleLink` returns the same getter route. #1260's `SurfaceAdapter.connectGuidance?: string` and `consoleLink(...)` types accept both. `surfaces/app.ts` stays import-free, which #1260's commit `e4a476ca` requires to avoid the approvals import cycle.
- Rejected: a `'console'` `ChannelKind`, which would duplicate the inbox, chain and runtime and is option (c) in the research. Also rejected: a surface compare in `owner-do.ts`, which fails the guard.

**Approvals in the chat: a fallback card, no buttons.** The console may approve only calendar changes (`consoleMayApprove`, `console.ts:275`). Approving sends from the web is a policy change outside this slice. Approval parts render as a card with the review text and "Open Waiting →". This leaves one known gap: the model is still told `approval: native_buttons` for app turns (`telegram-turn.ts:16`). See Risks.

**Message text: plain, no markdown.** Rendered as plain text with `white-space: pre-wrap`, through React text nodes only: no new dependency, no `dangerouslySetInnerHTML`, no auto-linking. The prompt already bans markdown headings and tables (`messaging-behavior.ts:7`).

**Say hello: a client template, not a judgement rule.** The template only joins the person's own selections, lightly normalised (lower-case first letter), plus their typed words, under fixed first-person prefixes. The person sees and edits the result before sending. There is no classification, no claims write and no setup route, per the owner's decision.
- `SayHello` is one component with two consumers: S3's step 4, and the empty chat ("Not sure where to start?"). S4 therefore does not need S3 to land first.
- After a send from the welcome flow, it records S3's step as done and goes to `#/chat?from=welcome`. The chat then shows "Finish setting up", so All set (waitlist link, honest next steps) is one tap away. This follows the brief's "routes to #/chat" without losing S3's All set.

**Pending messages live in a small outbox store.** `chat-model.ts` keeps them in a module-level store (`useSyncExternalStore`). A message sent in `#/welcome` therefore keeps its pending state across the hash change into `#/chat`; hash routing does not reload the page. On a reload the store is empty and history shows the row once the turn writes it.

**Waldo's reply is model-led.** [verified on `origin/mac/first-conversation` `092a60ba`, draft, still conflicting with `04bb8c89` in `owner-do.ts`, `owner-turn.ts`, the prompt snapshot and `context-composer.test.ts`]
- #1227 adds `firstConversationLine` (`messaging-behavior.ts`). It renders only while the owner has zero owner-grounded profile claims and `remember` is offered that turn. It tells the model to answer first, then decide whether and what to ask, and to save with `remember` in the owner's own words.
- Its `newOwnerFacts` supplier is wired for the app, iMessage and Telegram contexts. A console message rides the app context, so it is covered.
- Its `surfaces` fact labels an app-bound owner "the app". For a console-first owner that reads slightly wrong. This is a coordination note for the Mac lane; S4 does not touch that file.
- **Without #1227,** Waldo still answers through the normal prompt, and `MEMORY_MANNERS` already lets him `remember` facts the owner volunteers (`messaging-behavior.ts`, "Remembering and reaching out").
- **Acceptance never depends on scripted questions,** and the composed message must stay plain owner text: no quotes or `>` prefixes, so `remember` grounding (`tools/live/memory.ts:52-55`) treats it as owner-authored.

### Changes, file by file

**1. `packages/runtime/src/channels/dashboard-overview.ts`.** Add next to `DASHBOARD_OVERVIEW_PATH` (`:5`). It lives here, not in `console-chat.ts`, because `console-signin.ts` already imports this module, and importing `console-chat.ts` would close the cycle `console-signin → console-chat → app-api → console-signin`.
```ts
export const CONSOLE_CHAT_PATH = '/console/dashboard/api/v1/chat';
```

**2. `packages/runtime/src/channels/console-chat.ts` (new).**
```ts
import { APP_SEND_MAX_WIRE_BYTES } from '../../../contracts/src/app/core';
import { parseAppSend, readBoundedBody, type AppMessage } from './app-api';
import { AppSessionAuthorityError } from '../identity/app-session-authority';
import { ownerCookieSession } from '../identity/console-auth';
import { CONSOLE_CHAT_PATH, DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';

const SEND_PATH = `${CONSOLE_CHAT_PATH}/messages`;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
type Receipt = Readonly<{ accepted: true; message_id: string; state: string; closed_reason?: string; effects_unconfirmed?: boolean }>;
type Admission = Readonly<{ kind: 'admitted' | 'duplicate'; record: Readonly<{ id: string; state: string }> } | { kind: 'conflict' } | { kind: 'capacity' }>;

// The console's side of the owner's main chat: the browser's signed owner session admitted onto the app's one inbox
// and transcript. /app/v1 stays bearer-only; this route is csrf-checked and names its session only from the cookie.
export type ConsoleChatHost = Readonly<{
  csrf: string;
  doName: string | undefined;
  // The router secret, only where the owner directory is configured.
  secret: string | undefined;
  limiter: RateLimit | undefined;
  // The directory's answer for this session, asked on every request; throws when it no longer admits it.
  authority(sessionHash: string): Promise<Readonly<{ ownerId: string }>>;
  // The owner's main chain for the principal the directory named; null when this object serves another principal.
  mainChat(ownerId: string): string | null;
  admit(sessionHash: string, chat: string, clientId: string, text: string): Promise<Admission>;
  receipt(chat: string, clientId: string): Receipt | null;
  cancel(chat: string, clientId: string): Receipt | null;
  history(sessionHash: string, cursor: string | null, limit: number): Promise<Readonly<{ messages: readonly AppMessage[]; next_cursor: string | null }>>;
}>;

const reply = (body: object, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });
const fail = (status: 401 | 403 | 404 | 405 | 413 | 429 | 503) => reply({ error: 'unavailable' }, status, status === 429 ? { 'retry-after': '60' } : {});

export const consoleChatRequest = async (request: Request, host: ConsoleChatHost): Promise<Response> => {
  const path = new URL(request.url).pathname, sub = path.startsWith(`${SEND_PATH}/`) ? path.slice(SEND_PATH.length + 1) : null;
  const route = path === CONSOLE_CHAT_PATH ? 'history' : path === SEND_PATH ? 'send' : sub?.endsWith('/cancel') ? 'cancel' : sub !== null && !sub.includes('/') ? 'receipt' : null;
  if (!route) return fail(404);
  if (request.method !== (route === 'send' || route === 'cancel' ? 'POST' : 'GET')) return fail(405);
  const clientId = route === 'cancel' ? sub!.slice(0, -'/cancel'.length) : sub;
  if (clientId !== null && !CLIENT_ID.test(clientId)) return fail(404);
  if (!host.secret || !host.doName) return fail(404);
  // A forwarded client header never names the session: handleConsole passes client headers through as they came.
  const session = await ownerCookieSession(request, host.secret);
  if (!session || session.doName !== host.doName) return fail(401);
  if (request.method === 'POST' && (request.headers.get('x-waldo-csrf') !== host.csrf
    || (route === 'send' && !(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')))) return fail(403);
  if (!host.limiter) return fail(503);
  try { if (!(await host.limiter.limit({ key: `${route === 'send' ? 'app-chat-send' : 'app-read'}:${host.doName}` })).success) return fail(429); } catch { return fail(503); }
  let ownerId: string;
  try { ({ ownerId } = await host.authority(session.sessionHash)); }
  catch (error) { return fail(error instanceof AppSessionAuthorityError && error.kind !== 'revoked' ? 503 : 401); }
  const chat = host.mainChat(ownerId);
  if (!chat) return fail(403);
  if (route === 'history') {
    const url = new URL(request.url), cursor = url.searchParams.get('cursor');
    if ((cursor?.length ?? 0) > 300) return fail(404);
    try { return reply({ version: 1, csrf: host.csrf, ...await host.history(session.sessionHash, cursor, Number(url.searchParams.get('limit') ?? 20)) }); }
    catch { return fail(503); }
  }
  if (route !== 'send') { const receipt = (route === 'receipt' ? host.receipt : host.cancel)(chat, clientId!); return receipt ? reply(receipt) : fail(404); }
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > APP_SEND_MAX_WIRE_BYTES)) return fail(413);
  const body = await readBoundedBody(request, APP_SEND_MAX_WIRE_BYTES);
  if (!body) return fail(413);
  let raw: string; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return fail(403); }
  const send = parseAppSend(raw);
  if (!send) return fail(403);
  const result = await host.admit(session.sessionHash, chat, send.clientMessageId, send.text);
  if (result.kind === 'conflict') return reply({ error: 'client_message_id_reused' }, 409);
  if (result.kind === 'capacity') return reply({ error: 'inbox_full' }, 503);
  return reply({ accepted: true, message_id: result.record.id, state: result.record.state }, 202);
};
```
Rules for this module:
- It writes no logs. Failures in the history read are logged by the host with existing hop codes only.
- It never logs or echoes message text, cookies or hashes.

**3. `packages/runtime/src/identity/console-auth.ts`.**
- Lift the signature check out of `readSigned` (`:93-109`) into a module-level `verifySigned(raw, sign)` that returns `{doName, sessionId} | null` with no network call. `readSigned` keeps calling it, then does its `console_session_touch`.
- Lift the cookie parse at `:181-184` into `ownerCookieValue(request)`.
- Add:
```ts
// The directory session a signed console owner cookie names, from its signature alone. Whether that session is still
// live is the directory's answer (app_session_authority), which a caller acting on it must ask.
export const ownerCookieSession = async (request: Request, secret: string): Promise<Readonly<{ doName: string; sessionHash: string }> | null> => {
  const signed = await verifySigned(ownerCookieValue(request), (doName, sessionId) => routerSignature(secret, 0, `cookie.${doName}.${sessionId}`));
  return signed ? { doName: signed.doName, sessionHash: await linkCodeHash(signed.sessionId) } : null;
};
```
`cookieSig` (`:83`) must produce exactly the same signature, so keep one definition for both.

Replace the comment at `:46-47` with:
```ts
  // The mobile app's bearer: the same kind of server-side session, signed under its own context, so it is never accepted
  // as a console cookie and /app/v1 never accepts a console cookie. The console reaches the same main chat through its own
  // csrf-checked route (channels/console-chat.ts), which names the session from the signed cookie.
```

**4. `packages/runtime/src/channels/app-api.ts`.**
- `:36`: `const readBoundedBody` becomes `export const readBoundedBody`.
- `:50`: the comment becomes "The app credential is its own signed artifact backed by a server-side session row. /app/v1 never accepts a console cookie; the console uses its own csrf-checked route to the same main chat."

**5. `packages/runtime/src/channels/app-inbox.ts`.**
- `AppInboxRecord` (`:19-32`) gains:
```ts
  // The first-party session that admitted the message, when it was not the iPhone app. Read per turn for what the
  // model is told about where the owner is reading; absent on app rows and rows from older builds.
  via?: 'console';
```
- `admit` (`:45`) gains a trailing `via?: 'console'` parameter. The record literal at `:62` adds `...(via === undefined ? {} : { via })`.
- `scope()` does not compare `via`, so the turn identity is unchanged.

**6. `packages/runtime/src/channels/surfaces/app.ts`.** Add after `:12`. No imports: the file must stay a leaf, because `approvals.ts` imports it.
```ts
export const CONSOLE_CONNECT_GUIDANCE = 'No connect button was sent: the web console chat has none. Tell the owner to open Settings with the gear at the top right of the console, choose Connections and connect Google there - never quote or retype any link yourself.';
// What a turn on the app chain tells the model about where the owner is reading: the inbox row says when the console
// admitted it. Scheduled work and the iPhone app read the app's own guidance.
const READING = {
  app: { connectGuidance: APP_CONNECT_GUIDANCE, consoleLink: 'app_unsupported' },
  console: { connectGuidance: CONSOLE_CONNECT_GUIDANCE, consoleLink: 'in_console' },
} as const;
export const appChatPresence = (record: Readonly<{ via?: 'console' }> | null | undefined) => READING[record?.via ?? 'app'];
```

**7. `packages/contracts/src/tools/schemas/console-link.ts`.**
- Add `'in_console'` to `CONSOLE_LINK_UNSENT_REASONS` (`:10-25`), with the comment `// The owner is writing from their console in the browser right now; there is nothing to send.` This is an additive enum value: nothing in the runtime parses it strictly before this PR.
- `console-link.test.ts:22`: add `'in_console'` to the accepted reasons.

**8. `packages/runtime/src/channels/console-link.ts:22`.** The union becomes `'app_unsupported' | 'surface_unsupported' | 'in_console'`.

**`packages/runtime/src/tools/live/console-link.ts:23`.** Insert after the `app_unsupported` clause: `in_console, they are writing from their console in the browser right now, so tell them the page they have open is it;`.

**9. `packages/runtime/src/channels/console-signin.ts`.**
- Import `CONSOLE_CHAT_PATH` from `./dashboard-overview` (already imported at `:12`).
- Replace the four duplicated path lists (`:342,347,355,360`) with one helper. This fixes the whole class: chat, and any later JSON route, gets 401 JSON instead of a 303.
```ts
// The dashboard's JSON reads and writes: without a valid session they answer 401 JSON, never the sign-in redirect a page gets.
const dashboardJson = (url: URL, request: Request): boolean =>
  [DASHBOARD_OVERVIEW_PATH, MEMORY_GRAPH_PATH, CONTROLS_PATH, CONTROL_ACTION_PATH, MEMORY_CONTROL_PATH, OWNER_CONTROLS_PATH, OWNER_CONTROLS_ACTION_PATH].includes(url.pathname)
  || url.pathname === CONSOLE_CHAT_PATH || url.pathname.startsWith(`${CONSOLE_CHAT_PATH}/`)
  || (url.pathname.startsWith('/console/workspace') && request.headers.get('accept') === 'application/json');
```
S2 edits sign-in and verify in this file (`:196-304`). This edit sits in `:340-363`, so rebase if S2 lands first.

**10. `packages/runtime/src/channels/owner-do.ts`** (Mac lane slot; about 35 lines; **no new surface compare**).

- **Dispatch.** In `console()`, after the session check at `:1379` and after S1's origin write if it has landed:
```ts
    if (url.pathname === CONSOLE_CHAT_PATH || url.pathname.startsWith(`${CONSOLE_CHAT_PATH}/`)) return this.consoleChat(request, session.csrf);
```
- **Host method.** Next to `threadsHost` (`:974`):
```ts
  // The console's main chat: the browser's signed owner session on the app's one inbox, drain and transcript.
  private consoleChat(request: Request, csrf: string): Promise<Response> {
    const kv = this.ctx.storage.kv, name = kv.get<string>('do_name') ?? '';
    return consoleChatRequest(request, { csrf, doName: name || undefined, secret: consoleAuth(this.env) ? this.env.WALDO_ROUTER_HMAC_SECRET : undefined, limiter: this.env.RESPONSIBILITY_RATE_LIMITER,
      authority: hash => this.appAuthority(name, hash),
      mainChat: ownerId => { const principal = ownerPrincipalRef(ownerId), known = kv.get<string>('owner_principal_ref'); if (known !== undefined && known !== principal) return null; if (known === undefined) kv.put('owner_principal_ref', principal); return ownerChainRef('app', principal); },
      admit: async (hash, chat, clientId, text) => { this.bindAppSubject(name); const result = await this.appInbox.admit(name, hash, clientId, text, chat, undefined, undefined, 'console'); if (result.kind === 'admitted') this.ctx.waitUntil(this.serial(() => this.drainApp()).catch(() => { console.error('app inbox drain deferred'); })); return result; },
      receipt: (chat, clientId) => { this.recoverApp(); return this.appInbox.receipt(name, clientId, chat); },
      cancel: (chat, clientId) => { this.recoverApp(); const row = this.appInbox.cancel(name, clientId, chat); if (!row) return null; if (this.activeApp?.id === row.id) this.activeAbort?.abort(); return this.appInbox.receipt(name, clientId, chat); },
      history: (hash, cursor, limit) => { const at = { step: 'context' }; return this.appChatPage(name, hash, undefined, cursor, limit, at).catch(error => { logAppReadFailure('app_history_read', at.step, error); throw error; }); },
    });
  }
```
- **Fence helper and browser sign-out.** Add a shared fence. `appSessionFence` (`:864-865`) then calls `this.fenceAppSession(hash)` and returns `{fenced}`.
```ts
  private fenceAppSession(hash: string): number { const fenced = this.appInbox.revokeSession(hash); if (this.activeApp?.sessionHash === hash) this.activeAbort?.abort(); return fenced; }
  // One browser's sign-out ends its directory session too: its queued and running chat work stops first, then the row goes,
  // then work admitted in between stops. A ticket-only browser has no directory session. False keeps this browser signed in.
  private async endBrowserSession(request: Request): Promise<boolean> {
    const auth = consoleAuth(this.env), secret = this.env.WALDO_ROUTER_HMAC_SECRET, name = this.ctx.storage.kv.get<string>('do_name');
    const owner = auth && secret ? await ownerCookieSession(request, secret) : null;
    if (!auth || !name || !owner || owner.doName !== name) return true;
    this.fenceAppSession(owner.sessionHash);
    try { await auth.revokeSession(name, owner.sessionHash); } catch { consoleLog(consoleTrace(), 'console_signout', false, 'directory_unconfirmed'); return false; }
    this.fenceAppSession(owner.sessionHash);
    return true;
  }
```
- **The two sign-out sites.**
  - `:1514`: `else await access.signOut(session.token);` becomes
    `else { if (!await this.endBrowserSession(request)) return {state:'unconfirmed' as const,message:'Signing out did not finish. This browser is still signed in; try again.'}; await access.signOut(session.token); }`
  - `:1608`: the same, returning `new Response('Signing out did not finish. This browser is still signed in; go back and try again.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })`.
- **Surface capability (today's tree).**
  - Add `const reading = () => appChatPresence(this.activeApp);` next to `const storage` (`:2222`).
  - `:2227`: `app: { unsupported: 'app_unsupported' },` becomes `app: { get unsupported() { return reading().consoleLink; } },` with the comment "// Read per turn: the console admits messages onto this same app runtime."
  - `:2237`: `if (channel === 'app') return APP_CONNECT_GUIDANCE;` becomes `if (channel === 'app') return reading().connectGuidance;`.
  - The compare count stays at 58. Run the guard to prove it.
- **Imports.**
  - `consoleChatRequest` from `./console-chat`.
  - `CONSOLE_CHAT_PATH` from `./dashboard-overview` (already imported for other names).
  - `ownerCookieSession` added to the existing `console-auth` import at `:70`.
  - `appChatPresence` added next to `APP_CONNECT_GUIDANCE`. `APP_CONNECT_GUIDANCE` stays imported if no other use remains; delete it otherwise.

**On #1260's tree** (rebase plan): the two `setup()` hunks move into `surfaces/app-runtime.ts` `surfaceAdapter`:
```ts
    consoleLink: () => ({ get unsupported() { return appChatPresence(host.activeApp()).consoleLink; } }),
    get connectGuidance() { return appChatPresence(host.activeApp()).connectGuidance; },
```
The `console()`, sign-out, fence and host hunks are untouched by #1260 [verified: its `owner-do.ts` keeps `console()` at `:1361` and the sign-out lines at `:1514` and `:1608`].

**11. `packages/dashboard-app/src/chat-model.ts` (new).** Wire types and readers, written by hand like `controls-model.ts`; the SPA does not import contracts.
```ts
import { SignInRequired } from './model';
export const CHAT_URL = '/console/dashboard/api/v1/chat';
export const MESSAGE_MAX = 4000;
export const RECEIPT_POLL_MS = 2000;
export type ApprovalNote = { id: string; kind: string; question: string | null; review: string };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; parentId: string | null; createdAt: number | null; approvals: ApprovalNote[] };
export type ChatPage = { csrf: string; messages: ChatMessage[]; nextCursor: string | null }; // newest first, as served
export type ReceiptState = 'admitted' | 'running' | 'completed' | 'interrupted' | 'revoked';
export type Receipt = { messageId: string; state: ReceiptState; closedReason: 'interrupted' | 'session_revoked' | 'cancelled' | null; unconfirmed: boolean };
export type ChatProblem = 'lost' | 'limited' | 'full' | 'reused' | 'rejected';
export class ChatError extends Error { constructor(readonly problem: ChatProblem) { super(problem); } }
export const newClientId = () => `web-${crypto.randomUUID()}`;           // 40 chars, matches ^[A-Za-z0-9_-]{8,64}$
export function readChatPage(value: unknown): ChatPage { /* version 1; csrf string; messages[] each id/role/text/parent_id/created_at?;
  approvals = parts of type 'approval' with string approval_id/kind/review (question optional); every other part ignored; next_cursor string|null */ }
export async function fetchChat(q: { cursor?: string | null; limit?: number } = {}, signal?: AbortSignal): Promise<ChatPage>
export async function sendChat(csrf: string, clientId: string, text: string): Promise<{ messageId: string; state: ReceiptState }>
  // fetch(`${CHAT_URL}/messages`, { method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error',
  //   headers:{ accept:'application/json', 'content-type':'application/json', 'x-waldo-csrf': csrf }, body: JSON.stringify({ client_message_id: clientId, text }) })
  // 401 → SignInRequired; 409 → ChatError('reused'); 429 → 'limited'; 503 with {error:'inbox_full'} → 'full'; 403 → 'rejected'; throw/other → 'lost'
export async function fetchReceipt(clientId: string, signal?: AbortSignal): Promise<Receipt | null>     // 404 → null
export async function stopChat(csrf: string, clientId: string): Promise<Receipt>
export type Pending = { clientId: string; text: string; messageId: string | null; status: 'sending' | 'failed' | ReceiptState; closedReason: Receipt['closedReason']; unconfirmed: boolean; problem: ChatProblem | null };
export function createOutbox(io = { sendChat, fetchReceipt, stopChat }) { /* subscribe/snapshot for useSyncExternalStore;
  send(csrf, text) → appends {status:'sending'} then admits; retry(csrf, clientId) re-POSTs the SAME id and text;
  resend(csrf, clientId) → new id (after 'reused'); poll() reads receipts of admitted/running; stop(csrf, clientId);
  settle(shownIds) drops 'completed' entries whose messageId history now shows; active() */ }
export const outbox = createOutbox();
```

**12. `packages/dashboard-app/src/Chat.tsx` (new).**
- `export function ChatPanel({ timezone }: { timezone: string })` and `export function Composer(props)`.
- **ChatPanel state:**
  - the newest page plus the older pages loaded through `nextCursor`, deduplicated by `id` and shown oldest first;
  - the `csrf` from the latest read;
  - `signedOut`, `paused` and `error` flags.
- **Polling** (visibility-aware, like `App.tsx:165-190`):
  - while `outbox.active()`, `outbox.poll()` runs every `RECEIPT_POLL_MS`;
  - when an entry turns terminal, read the newest page and call `outbox.settle`;
  - otherwise re-read the newest page on `nextLiveDelay(failures)` from `live.ts`;
  - a 401 stops polling.
- **Scrolling:** scroll to the end on new rows only if the reader is within 120 px of the bottom.
- **Composer** (used by ChatPanel and SayHello):
  - a `textarea` with `maxLength={MESSAGE_MAX}` and `field-sizing: content`;
  - Enter sends (no Shift, not `nativeEvent.isComposing`, not `matchMedia('(pointer: coarse)')`); Shift+Enter adds a newline;
  - the send button is disabled while the text is empty after trimming, or while sending.

**13. `packages/dashboard-app/src/SayHello.tsx` (new).**
- `export function SayHello({ variant, onSent, onSkip, onCompose })`. `variant: 'welcome' | 'chat'`.
- `'welcome'` sends through `outbox.send` after reading `csrf` with `fetchChat({ limit: 1 })` on mount. `'chat'` hands the text to the chat composer with `onCompose(text)`.
- The four fieldsets use a local `ChoiceRow` (native radio or checkbox inside a `<label>`). Each fieldset has an "Or say it your way" input, `maxLength` 500.
- Then a multiline "Anything else I should know?" field, `maxLength` 500, and the editable composed message.
- Exported pure helper:
```ts
export type HelloAnswers = { week: string[]; weekOwn: string; slips: string[]; slipsOwn: string; people: string[]; peopleOwn: string; autonomy: string[]; autonomyOwn: string; more: string };
const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
const joined = (picked: string[], own: string) => [picked.map(lower).join(', '), own.trim()].filter(Boolean).join('; ');
const stop = (text: string) => /[.?!]$/.test(text) ? text : `${text}.`;
export function composeHello(a: HelloAnswers): string {
  const lines = [['A usual week', joined(a.week, a.weekOwn)], ['What tends to slip', joined(a.slips, a.slipsOwn)],
    ['Who matters most day to day', joined(a.people, a.peopleOwn)], ["How much I'd like you to do on your own", joined(a.autonomy, a.autonomyOwn)]]
    .filter(([, value]) => value).map(([prefix, value]) => stop(`${prefix}: ${value}`));
  const more = a.more.trim();
  return lines.length || more ? ['Hello Waldo. Here is a bit about me.', ...lines, ...(more ? [stop(`Also: ${more}`)] : [])].join('\n') : 'Hello Waldo.';
}
```
The text tracks the answers until the person edits it. After an edit, answers no longer overwrite it, and "Rebuild from my answers" appears. Sending posts exactly the textarea value.

**14. `packages/dashboard-app/src/App.tsx`.**
- `Route` (`:21`) gains `'chat'`.
- `resolveRoute` (`:26-37`): add `if (value === 'chat') return 'chat';` before the final line. Because it splits on `?` (`:31`), `#/chat?from=welcome` also resolves.
- `Dashboard` (`:75`): before `:85`, add `if (route === 'chat') return <ChatPanel timezone={data.timezone}/>;`.
- Top bar (`:212`): wrap the settings link in `<div className="topbar-actions">`, preceded by `<a className="settings-link" href="#/chat" aria-label="Chat with Waldo" title="Chat with Waldo" aria-current={route === 'chat' ? 'page' : undefined}><Icon name="chat"/></a>`. The `chat` glyph already exists (`icons.tsx`).
- The primary nav stays at four, so the `App.test.tsx:7` pin is untouched.
- Keyboard (`:191-204`): add `c: 'chat'` to the G-then map.

**15. S3's welcome step list** (whichever lands second): step 4 renders `<SayHello variant="welcome" onSkip={next} onSent={() => { /* S3's step store */ save('done'); location.hash = '#/chat?from=welcome'; }}/>`.

**16. `packages/dashboard-app/src/style.css`.** These rules use existing tokens only. They add no shadows or gradients, and state lines use `--t2` because `--t3` fails contrast until S5.
```css
textarea { font:inherit; font-size:14.5px; color:var(--ink); padding:10px 14px; border:0; border-radius:18px; background:var(--fill); box-shadow:inset 0 0 0 .5px var(--hair-strong); resize:none; max-width:100%; min-width:0; }
textarea:focus { box-shadow:inset 0 0 0 1px var(--ink); }
.topbar-actions { justify-self:end; display:flex; gap:4px; }
.chat-log { display:flex; flex-direction:column; gap:8px; padding:8px 0 16px; }
.bubble { max-width:min(36rem,85%); padding:10px 14px; border-radius:18px; white-space:pre-wrap; overflow-wrap:anywhere; }
.bubble.waldo { align-self:flex-start; background:var(--tile); color:var(--ink); box-shadow:0 0 0 .5px var(--hair); border-bottom-left-radius:6px; }
.bubble.you { align-self:flex-end; background:var(--ink); color:var(--on-ink); border-bottom-right-radius:6px; }
.chat-state { align-self:flex-end; display:flex; gap:8px; align-items:center; font-size:12.5px; color:var(--t2); }
.chat-approval { align-self:flex-start; max-width:min(36rem,85%); background:var(--tile); border-radius:var(--r-inner); box-shadow:0 0 0 .5px var(--hair-strong); padding:12px 14px; }
.chat-composer { position:sticky; bottom:0; display:flex; gap:8px; align-items:flex-end; padding:12px 0 16px; background:var(--canvas); }
.chat-composer textarea { flex:1; field-sizing:content; min-height:44px; max-height:9.5em; }
.choice-row { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; padding:12px 14px; border-radius:var(--r-inner); background:var(--tile); box-shadow:0 0 0 .5px var(--hair); cursor:pointer; }
.choice-row:has(input:checked) { box-shadow:0 0 0 1px var(--ink); }
.choice-row input { accent-color:var(--accent); }
@media(max-width:640px) { .chat-composer { bottom:calc(64px + env(safe-area-inset-bottom)); } .bubble,.chat-approval { max-width:92%; } }
```
Also delete `justify-self:end` from `.settings-link` (`:98`); the wrapper now places it. Assets stay at one JS and one CSS file, with no new import and no `import()` (`verify-assets.mjs`).

**17. `packages/dashboard-app/scripts/preview.mjs`.**
- Add `'chat'` to `cases`.
- Add synthetic `/console/dashboard/api/v1/chat` routes: GET returns four messages, one of them with an approval part. POST returns 202. The receipt returns `running` twice, then `completed`.
- Mark the file "synthetic preview only", as it already is.

**18. `packages/dashboard-app/README.md:27`.** Drop "web chat" from the "need explicit contracts" list. Add one line: "`#/chat` is the owner's main chat over `/console/dashboard/api/v1/chat` (cookie + csrf), the same transcript as the iPhone app."

### UI and copy

All copy below is verbatim. It is in sentence case, uses British spelling, has no exclamation marks, and calls Waldo "he".

**Top bar (all routes).**
- A chat icon sits left of the settings gear. Its accessible name and tooltip are "Chat with Waldo".
- It carries `aria-current="page"` on `#/chat`.
- On phones it sits in the top bar; the four-item tab bar is unchanged.

**`#/chat`, conversation.**
- **Layout:**
  - `.page-heading` with h1 "Chat." and the body "The same conversation as the Waldo iPhone app. Anything that counts still waits for your approval.";
  - then `.chat-log` (`role="log"`, `aria-live="polite"`, `aria-label="Conversation with Waldo"`);
  - then the sticky composer.
- When the hash carries `from=welcome`, a `.quiet-link` "Finish setting up →" (to `#/welcome`) sits under the heading.
- **Each message** is an `<article>` with a visually hidden "Waldo said" or "You said" and a `<time>` from `clockLabel(new Date(created_at), timezone)`. It is omitted when there is no `created_at`; no time is invented.
- **Older messages:** a quiet button "Show earlier messages". While it works, the text reads "Opening earlier messages…".

**Approval card** (after the reply that carries it):
- label "Needs your decision" (`.access-label.needs`);
- the part's `question`, or the first 280 characters of `review` plus "…";
- the line "Read it in full in Waiting. Calendar changes can be approved there. Sends can't be approved from the web yet.";
- a link "Open Waiting →" to `#/waiting`.

**Composer.**
- Visually hidden label: "Message to Waldo".
- Placeholder: "Tell Waldo, ask, or correct…".
- Button: "Send".
- Desktop hint (`.meta`, `aria-describedby`): "Enter sends. Shift and Enter starts a new line."
- Over 3,600 characters: "{n} characters left".
- At 4,000: "That's the most one message can hold."

**Pending lines** (`.chat-state` under the person's bubble, `role="status"`):

| State | Line | Action |
|---|---|---|
| sending | "Sending…" | none |
| admitted | "Waldo has your message." | quiet "Stop" |
| running | "Waldo is working on it." | quiet "Stop" |
| failed, lost | "This didn't reach Waldo." | "Try again" (same id) |
| failed, limited | "That's a lot at once. Try again in a minute." | "Try again" |
| failed, full | "Waldo has a lot queued. Try again in a minute." | "Try again" |
| failed, reused | "This clashed with an earlier message." | "Send as new" |
| cancelled | "Stopped. Waldo didn't finish this one." | none |
| cancelled, effects unconfirmed | "Stopped. Something may already have happened; check before asking again." | none |
| interrupted | "This didn't finish. Waldo's note is below." | none |
| session_revoked / revoked | "This browser was signed out before Waldo answered." | none |
| receipt read failed | "Couldn't check just now. Trying again." | none |

**Other chat states.**
- **Empty:** a `.tile` with h2 "Nothing said yet." and "Tell Waldo what you're carrying this week, or ask him anything." Below it sits `SayHello variant="chat"`, introduced by h2 "Not sure where to start?" and "Answer a few questions and they become your first message. Edit it before you send.", with the button "Use as my message".
- **Loading:** a skeleton with a visually hidden "Opening your conversation…". Never "Loading…".
- **Read failed:** h2 "The conversation didn't open.", body "Nothing you sent is lost by this; the read didn't come back.", button "Try again".
- **Signed out:** h2 "Sign in to keep talking to Waldo.", `.button-link` "Sign in" to `/console/signin`.
- **Live paused:** meta "Live updates paused, retrying".

**Say hello (welcome step 4 of 5, inside S3's frame and ProgressSteps).**
- **Heading** (S3's headline style): "Tell me a little about you."
- **Body:** "Pick what fits, or say it your way. Skip anything. It all goes into your first message to me, and you can change every word before it goes."
- **Fieldset 1** (single). Legend: "What does a usual week look like?". Hint: "Pick one, or say it your way.". Options:
  - "Mostly meetings and people"
  - "Mostly focused work on my own"
  - "A mix that changes week to week"
  - "Studying"
  - "Looking after home and family"
  - "Or say it your way", placeholder "For example: I run a small design studio".
- **Fieldset 2** (multi). Legend: "What tends to slip?". Hint: "Pick any that apply.". Options:
  - "Replies I owe people"
  - "Follow-ups after meetings"
  - "Deadlines"
  - "Bills, forms and admin"
  - "Time for exercise and rest"
  - "Or say it your way", placeholder "Anything else that slips".
- **Fieldset 3** (multi). Legend: "Who matters most day to day?". Hint: "Names help. Share only what you're happy for me to remember.". Options:
  - "My team"
  - "A cofounder or manager"
  - "Clients"
  - "Family"
  - "Friends"
  - "Or say it your way", placeholder "Names, and who they are to you".
- **Fieldset 4** (single, nothing preselected). Legend: "How much should I do on my own?". Hint: "I'll remember this as your preference. It never lets me do more than you approve.". Options:
  - "Just tell me things": "I explain; you decide and act."
  - "Suggest, and let me approve": "I prepare the change and wait for you."
  - "Handle the routine things": "I take small things off your plate and ask before anything that counts."
  - "Or say it your way", placeholder "In your own words".
- **Free text.** Label: "Anything else I should know?". Placeholder: "As much or as little as you like".
- **Message.** Label: "Your first message". Helper: "This is what Waldo will read. Edit anything." After a manual edit, the quiet button "Rebuild from my answers" appears.
- **Buttons:** primary "Send to Waldo" (disabled until the message is non-empty; the reason reads "Write something to send."), secondary "Skip for now".
- **Errors** (`role="alert"`):
  - "That didn't reach Waldo. Try again." The text is kept, and the retry reuses the client id while the text is unchanged.
  - Signed out: "You're signed out. Sign in, then come back to send this." with a "Sign in" link.
  - CSRF read failed: "Waldo's chat didn't open. Try again in a moment." with "Try again".
- **Already chatted** (the history read returned messages): "You've already said hello. Anything you send here joins the same conversation."
- **Phone:** the rows stack full width, buttons are at least 44 px and full-width blocks, and the composed message grows to 9.5 lines, then scrolls.

**Accessibility.**
- Real `fieldset` and `legend`, native inputs, and focus visible on the row.
- `aria-describedby` for hints.
- The composed message does not live-announce on each change.
- Reduced motion: the existing global rule (`style.css:433`) applies.

### Security, privacy and authority

- **Authentication.** Two credentials are both required:
  - the Worker-verified owner cookie, which `handleConsole` resolves with a directory touch;
  - the DO-local browser session.

  In the DO, the session hash comes from the signed cookie, re-verified there. The directory decides liveness on every request (`app_session_authority`: active owner, row under 12 hours) and again at claim, turn and every effect, through existing `drainApp`/`turn` re-reads. Headers never name the session.
- **Isolation.** The cookie's `doName` must equal the DO's `do_name`. The principal must match `owner_principal_ref`. Receipts and cancels are keyed by owner and main chain. No cross-owner read exists.
- **CSRF.**
  - `x-waldo-csrf` must equal the DO session csrf on POST, and a send needs a JSON content type.
  - Cookies are `SameSite=Strict`, and no CORS is answered.
  - The csrf compare uses `!==`, matching `parseConsoleAction`.
- **Rate limits.** `app-chat-send:<doName>` and `app-read:<doName>`, shared with the app. The route fails closed without the binding. 429 carries `retry-after: 60`.
- **Input bounds.**
  - 32,768 wire bytes (`readBoundedBody`, which times out after 5 s).
  - Strict UTF-8.
  - `appSendRequestV1Schema`: text trimmed, 1 to 4,000 characters.
  - Client id `^[A-Za-z0-9_-]{8,64}$`; cursor at most 300 characters; limit clamped to 1-50 by `appTranscriptPage`.
- **Errors.** Generic `{error:'unavailable'}` everywhere except two actionable codes: `client_message_id_reused` and `inbox_full`. Nothing echoes text, hashes or internals.
- **Logging.** No new log line carries text, cookies, hashes, ids or emails. History failures use the existing `app_history_read` step codes. Sign-out failure logs `console_signout`/`directory_unconfirmed` via `consoleLog`.
- **Storage.**
  - Nothing new. The inbox row (text cleared at settle) and transcript rows are existing aggregates, written by their existing single writers.
  - `via` is an enum.
  - The Say hello answers exist only in the browser until the person sends them, as their own message.
  - Nothing is written to `goals`, `memory_blocks`, `core_file_revisions` or `owner_settings`.
- **Memory.** Answers reach memory only if the model calls `remember`, which is grounded in the owner's sent text. The autonomy answer is a stated preference, never a grant. No control, grant or budget changes.
- **Health.** Onboarding copy carries no health number and no `weight`/HR token near a numeric literal in source (`guard-health-leak`). Free text is the owner's own chat. `remember` has no numeric-health floor today [verified in research, `tools/live/memory.ts`]; that is pre-existing and flagged under Risks.
- **Egress.** Visitor text reaches the model provider and, on staging, Langfuse with text capture on. That is an owner decision (S0).
- **Credentials.** None in prompts or fixtures. Tests use synthetic secrets.
- **Security review: YES (mandatory).** The reviewer must check:
  1. no path reads a session from a header;
  2. cookie signature verification is constant-time and rejects the app bearer artifact;
  3. CSRF and content type on both POSTs;
  4. sign-out revokes the directory row and fences before and after;
  5. 401 versus 503 mapping (a directory outage never reads as signed out, and the reverse);
  6. rate-limit keys equal the app's;
  7. no `dangerouslySetInnerHTML` and no auto-linking in the SPA;
  8. the `/app/v1` cookie rejection is unchanged;
  9. the guard count is unchanged;
  10. no new env var, dependency or migration.

### Tests

Runtime tests run in the workers pool, `packages/runtime/vitest.config.ts`, included by `test/**/*.test.ts`.

**`packages/runtime/test/console-chat.test.ts`** (new).
- **Fixture:** clone `console-signout-everywhere.test.ts`. It has the directory RPC mock with `console_session_open/touch/list/revoke`, `app_session_authority` and `owner_runtime_authority`, plus `vi.mock('openai')` returning "Hello from your console." as in `app-basic-serving.test.ts`.
- **Requests** go through `handleConsole(request, routed)` with `cookie: waldo_console=<grant>; waldo_owner=<auth.ownerCookie(name)>`. `csrf` comes from `consoleAccess(state.storage).session(grant)`.
- **Cases:**
  1. **Golden.**
     - GET `/chat` → 200 `{version:1, csrf, messages:[], next_cursor:null}`.
     - POST a send → 202 `admitted`. Poll the receipt until `completed`.
     - GET `/chat` → the user row has `id === message_id` and the text; the assistant reply has `parent_id === message_id`.
     - The KV row `app:inbox-record:<id>` has `via:'console'` and a `sessionHash` equal to the hash `console_session_open` received.
     - `app_subject` is bound.
     - The same message appears through `handleApp` `/app/v1/chat/main` with a bearer minted by `/auth/verify` (same main chat).
  2. **CSRF.** Missing header → 403. Wrong value → 403. `content-type: text/plain` → 403. No inbox row in any case.
  3. **Signed out.** No cookies → 401 JSON from the Worker, not a 303. A bad owner-cookie signature → 401. A directory row gone (`app_session_authority` → null) → 401 and no row. Directory 503 → 503, not 401.
  4. **Sign-out fence.**
     - Hold the model call (the `proof.hold` pattern), then POST `session.signout`. Do it once through `/console/dashboard/api/v1/actions` (view `connections`, revision from the controls read) and once through legacy `/console/action`.
     - Assert:
       - `console_session_revoke` was called with the cookie hash;
       - the row is `revoked` with `closed_reason:'session_revoked'`, or `interrupted` if it was already running;
       - the next chat GET → 401;
       - an app bearer for a different session still reads 200.
     - Then make `console_session_revoke` throw: the receipt is `unconfirmed` with 503, and the DO session is still valid.
  5. **Hostile header.** A valid send also carrying `x-waldo-app-session-hash: <the app bearer's live hash>` and `x-waldo-do-name: other` → the row's `sessionHash` equals the cookie's hash.
  6. **Cross-owner.** An owner cookie signed for `other-owner` sent straight to this DO → 401 and no row. In a second DO, the receipt for owner A's client id → 404.
  7. **Idempotent.** The same id and text twice → the same `message_id`, one model call. The same id with new text → 409 `client_message_id_reused`.
  8. **Rate limit.**
     - A limiter failing `app-chat-send:<name>` → 429 with `retry-after: 60`, and the keys seen are exactly `app-chat-send:<name>` and `app-read:<name>`.
     - A missing binding → 503.
  9. **Bounds and methods.**
     - 4,001 characters → 403.
     - A 40 KB body → 413.
     - GET on `/chat/messages` → 405, DELETE → 405, `/chat/other` → 404, an invalid client id → 404.
  10. **Stop.** Cancel while held → receipt `interrupted`/`cancelled`.
  11. **/app/v1 still rejects cookies.** `/app/v1/chat/main` with only the console cookies → 401.

**`packages/runtime/test/console-chat-surface.test.ts`** (new; clone `console-link-app.test.ts`).
- Admit a row with `via:'console'` through the console route and run the turn with the scripted gateway calling `send_console_link`. The prompt contains `"sent":false,"reason":"in_console"`, and no `console:link` is minted.
- Script `connect_service {service:'google',feature:'calendar'}` with the Google connections read answering `[]`. The next model request contains `CONSOLE_CONNECT_GUIDANCE` and not "menu at the top left".
- `console-link-app.test.ts` stays unchanged and must still pass (`app_unsupported` for app rows).

**`packages/runtime/test/app-inbox.test.ts`** (extend). `admit(…, 'console')` persists `via`. Calling without it leaves `via` absent. Claim, settle and `revokeSession` keep it.

**`packages/runtime/test/console-auth.test.ts`** (extend, near `:93`).
- `ownerCookieSession` returns `{doName, sessionHash: sha256(sessionId)}` with **zero** fetch calls.
- It returns null for: a tampered `doName`, the app bearer presented as a cookie, another secret, an empty cookie and a malformed percent-encoding.
- `readOwnerCookie` behaviour is unchanged.

**`packages/runtime/test/console-owner-routing.test.ts`** (extend). A signed-out GET to `/console/dashboard/api/v1/chat` and to `/chat/messages/abc12345` → 401 with `DASHBOARD_OVERVIEW_HEADERS`. The existing download-resume and artifact 303 tests still pass.

**`packages/contracts/src/tools/schemas/console-link.test.ts`** (extend). `in_console` parses, and `in-console` and `'console'` do not.

**Dashboard tests (happy-dom, like `App.live.test.tsx`).** These are **not in CI**: run them and paste the result.
- **`src/chat-model.test.ts`**:
  - `readChatPage` rejects version 2 and missing csrf; keeps approval parts and ignores the rest; maps `created_at` absent to null;
  - `sendChat` sends the `x-waldo-csrf` and JSON headers with `redirect:'error'`;
  - the error mapping covers 401, 403, 409, 429, 503 `inbox_full` and a thrown fetch;
  - the outbox: `retry` reuses the client id, and `resend` mints a new one.
- **`src/Chat.test.tsx`**:
  - empty-state copy;
  - Enter sends while Shift+Enter does not;
  - pending lines progress through "Waldo has your message." and "Waldo is working on it.", then the reply appears;
  - a lost send shows "This didn't reach Waldo." and two POST bodies share `client_message_id`;
  - an interrupted state with `effects_unconfirmed` shows its line;
  - an approval card links `#/waiting`;
  - `<img src=x onerror=alert(1)>` renders as text;
  - with `visibilityState` `'hidden'` no receipt fetch fires;
  - a 401 shows "Sign in to keep talking to Waldo.".
- **`src/SayHello.test.tsx`**:
  - `composeHello` exact strings for: all skipped (`'Hello Waldo.'`), one of each, multiple selections, own words with and without a full stop, and "Also:";
  - after an edit, a choice no longer overwrites;
  - "Send to Waldo" posts the edited text exactly once and calls `onSent`;
  - a failure keeps the text and shows the alert;
  - the source holds no banned word ("dashboard", "Get started", "Learn more", "Oops", "Loading…", "!").
- **`src/App.test.tsx`** (extend): `resolveRoute('chat')` and `resolveRoute('chat?from=welcome')` give `'chat'`; the nav pin at `:7` passes unchanged; the top bar has `href="#/chat"` with `aria-label="Chat with Waldo"`.

### Acceptance trace

| # | Steps | Must observe | Label |
|---|---|---|---|
| 1 | Admin issues an invite (S0). The visitor opens it on a phone, signs up and lands on `/console#/welcome` (S2, S3). | Welcome flow, step 1. | STAGING |
| 2 | Confirm the zone and quiet hours. Connect Google or skip (S3, S1). | Steps advance. | STAGING |
| 3 | Say hello: pick "Mostly meetings and people", "Replies I owe people" and "Suggest, and let me approve", type one name, edit one word, then press "Send to Waldo". | The composed text updates live until the edit, and the sent text equals the edited text. | STAGING |
| 4 | Watch `#/chat?from=welcome`. | Own bubble, then "Waldo has your message.", then "Waldo is working on it.", then Waldo's reply, usually within 60 s. The reply answers the message; with #1227 deployed it may ask about them. Questions are not asserted. "Finish setting up →" is visible. | STAGING |
| 5 | Send "What did I tell you about my week?". | The reply uses the earlier message. | STAGING |
| 6 | Open Memory › Profile. | Facts appear only if Waldo called `remember`. Report it; do not require it. | STAGING |
| 7 | Ask "connect my calendar" before connecting. | Waldo points to Settings › Connections, never "menu at the top left" and never a link. | STAGING |
| 8 | Ask "send me my console link". | Waldo says this page is the console. | STAGING |
| 9 | Optional, if a TestFlight build exists: sign into the iPhone app with the same email. | Main shows the console conversation. | STAGING |
| 10 | Settings › Sessions → Sign out. | Signed-out state. Reopening `#/chat` from history asks to sign in. | STAGING |
| 11 | CSRF 403, forged header, cross-owner, rate limit, fence ordering. | `console-chat.test.ts` passes. | CI (runtime shard) |
| 12 | Staging Langfuse shows the turn trace (owner's call). | Trace present. | STAGING (S0) |

No LIVE (production) claim: production is out of scope.

**Screenshots** (local preview, synthetic only):
```bash
cd /home/user/waldo-backend
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app build
node packages/dashboard-app/scripts/preview.mjs --case=chat --port=4189 &
node packages/dashboard-app/scripts/preview.mjs --case=empty --port=4180 &
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node <scratchpad>/shoot-console.cjs <outDir>
```
Add these rows to the script's `shots` list:
- `['chat', 4189, '#/chat', 2500]`
- `['chat-empty', 4180, '#/chat', 1500]`
- `['chat-from-welcome', 4189, '#/chat?from=welcome', 2500]`

Capture each at desktop 1440x900 and phone 390x844. After S3 lands, also capture `#/welcome` at step 4 with selections made.

### Verification commands

Run in order, at the exact head SHA. Record PASS, FAIL, NOT RUN or UNAVAILABLE for each.
```bash
cd /home/user/waldo-backend
git diff --check
npx -y pnpm@10.34.4 install --frozen-lockfile
npx -y pnpm@10.34.4 -r typecheck
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime exec vitest run test/console-chat.test.ts test/console-chat-surface.test.ts test/console-link-app.test.ts test/console-link.test.ts test/console-link-telegram.test.ts test/app-inbox.test.ts test/app-basic-serving.test.ts test/console-auth.test.ts test/console-owner-routing.test.ts test/console-signin.test.ts test/console-signout-everywhere.test.ts test/dashboard-controls-owner.test.ts test/dashboard-control-actions.test.ts
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app test            # not in CI: paste "N files / M tests passed" (baseline at a643bcab: 31 / 216)
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app build && npx -y pnpm@10.34.4 --filter @waldo/dashboard-app verify:assets
node scripts/guards/guard-surface-neutral-core.mjs                  # must still print 101 compares in 13 files (owner-do.ts 58)
WALDO_DO_MIGRATION_BASE_REF=HEAD^1 npx -y pnpm@10.34.4 verify:guards   # guard-pgtap downloads PG15: NOT RUN if offline
npx -y pnpm@10.34.4 verify:workers                                  # full runtime suite, long; CI runs it in shards anyway
npx -y pnpm@10.34.4 verify                                          # UNAVAILABLE here: verify:supabase and session revocation need Docker
```

### Rollback

Revert the PR. Nothing else needs undoing:
- no migration, no DO schema, no env var, no dependency;
- `via` on existing inbox rows is ignored by older code, since rows are JSON in KV;
- `in_console` is never emitted after the revert;
- the sign-out path returns to DO-only.

Two effects do not roll back:
- messages already sent stay in the owner's main chat, which is correct;
- `app_subject` stays bound, so scheduled work keeps running for owners who chatted. To stop it for demo accounts, delete those accounts in Settings › Account or through the admin (S0).

The SPA reverts with the next deploy's bundle.

### Risks and open questions

1. **The freeze excludes S4.** *Default:* merge after the demo. The showcase then uses #1227 on the app or iMessage paths. Ansh decides on #1103 whether S4 joins.
2. **#1260 ordering.** *Default:* #1260 first, post-demo. S4 rebases and moves two lines into `surfaces/app-runtime.ts` (shown above), and the `console-chat-surface.test.ts` assertions stay valid. If S4 goes first, the #1260 author carries the same two getters into `app-runtime.ts` and adds a console case to `surface-adapters.test.ts`.
3. **The model is told "Surface: app … native_buttons" on console turns** (`telegram-turn.ts:16`; on #1260, `appSurface.presentation`). It may say "tap Approve" while the console card links to Waiting. *Default:* accept for v1. Follow-up: make presentation per-turn via `appChatPresence`, which #1260's adapter makes a one-line change.
4. **Sends cannot be approved from the web.** *Default:* honest card copy. Changing `consoleMayApprove` is a policy decision for the owner, not this slice.
5. **Scheduled work for every visitor after their first message** (Brief, Check-in, Close and nightly, once the zone is confirmed). This adds staging spend and messages into chats nobody reads. *Default:* accept, intended. S0 lists account cleanup after the showcase.
6. **Staging Langfuse captures visitor hello text** environment-wide. *Default:* owner decision in S0, made before visitors type.
7. **`remember` has no numeric-health floor.** A visitor's own words could put numbers into claims. *Default:* out of scope; flag it to the memory owners. S4's template adds no numbers.
8. **#1227's `surfaces` fact says "the app" for console-first owners.** *Default:* a note to the Mac lane; it is cosmetic for the model.
9. **The rate limiter is per Cloudflare location and shared with the iPhone app.** *Default:* accept. 120 per minute leaves room for two open tabs plus the app.

### Effort

L, about 12 hours. Done serially by one engineer it splits:
- runtime 5-6 h:
  - `console-chat.ts`, `console-auth.ts`, `app-api.ts`, `app-inbox.ts`, `surfaces/app.ts`, `console-link.ts` ×2, `console-signin.ts`, `dashboard-overview.ts` and the contracts enum;
  - `owner-do.ts`, about 35 lines;
  - runtime tests;
- SPA 5-6 h:
  - `chat-model.ts`, `Chat.tsx`, `SayHello.tsx`, `App.tsx`, `style.css`, `preview.mjs`, README;
  - dashboard tests;
- security review and fixes, about 1 h.

| Lane | Files |
|---|---|
| SPA | `packages/dashboard-app` |
| Runtime, not `owner-do.ts` | see the runtime list above |
| `owner-do.ts` | Mac-lane slot on #1103 |
| Contracts | console-link enum (additive) |
| Migrations | none |

## S5 Tour, what Waldo saved, Setup checklist and copy fixes

**Base.** Citations are at the working tree `a643bcab`, which is `beta-mvp` `04bb8c89` plus the plan docs. It includes #1257 (one-tap Connect iMessage). Nothing was run against staging.

### Outcome

**After the first chat.** Waldo's first reply in `#/chat` is followed by a card, "What he’s kept about you". It links to Memory › Profile, where the person checks what he kept from their own words. The card appears only when Profile actually has saved lines.

**The tour.** "Show me around" opens a five-stop guided tour on the real Today page: your day, what needs you, Memory, chat and Settings. It works from the keyboard, closes on Escape and returns focus.

**Setup.** Settings › Setup shows where the person actually is: time zone, quiet hours, Google, iMessage (#1257/S6), whether they have said hello, and the iPhone app waitlist. The React console stops offering Telegram to people who do not already use it.

**Copy and contrast.** The console stops calling itself a "dashboard". Grey text passes 4.5:1, and the focus ring passes 3:1 everywhere.

JTBD: "Show me what Waldo kept from what I told him, and how to find my way around, without reading a manual."

### Depends on / blocks

**Two PRs on `beta-mvp`. Merge order is S3 → S5a → S6; S5b follows S4 and S5a.**

- **S5a `onboarding/s5a-setup-and-copy`: Setup progress plus the copy, contrast and focus fixes.**
  - These are three small presentational changes to the SPA, with no new write path. They are bundled so they get one review and one set of before/after screenshots.
  - It contains no tour link and no tour code.
  - The "Say hello" row and its `first_chat_recorded` field land together, and only if S4 has merged when S5a branches. Otherwise S5a leaves both out, so no field lands without a reader.
- **S5b `onboarding/s5b-tour-and-readback`: the tour and the readback.** It is based on `beta-mvp` after S4 and S5a have merged.

**Dependencies:**
- **S3:**
  - S3 creates `packages/dashboard-app/src/links.ts` with `IPHONE_WAITLIST_URL`, and S5a imports it.
  - S5b adds "Show me around" to S3's All set step (`Welcome.tsx`, `DoneStep`) and widens S3's `finish` to take a destination.
- **S4:**
  - S5a's "Say hello" row links `#/chat`.
  - S5b mounts the readback inside S4's `ChatPanel` (`Chat.tsx`). It tags S4's top-bar chat link (`<a className="settings-link" href="#/chat" aria-label="Chat with Waldo">`) as the tour's chat anchor.
- **S6 (merges after S5a and extends it):**
  - S5a carries #1257's iMessage item unchanged, as `iMessageSetupRow` in an explicit row shape (Changes, `Panels.tsx`). S6 replaces that one function: it gates the row on its readiness read and points it at `#/connections`.
  - S5a implements the shared Connections "Chat" group rule: each row renders only when it applies, and the group and its label are hidden when no row renders. S6 adds its iMessage row to the same `chatRows` list.
- **#1227** (first conversation): not a hard dependency. Whether Waldo saves anything, and so whether the readback appears, is up to the model.
- **Freeze:** Ansh approved a demo freeze on #1103 at 19:27Z. S5 lands after the showcase unless Ansh adds it. If he adds one part, S5a is the smaller one.

**Blocks:** nothing. **Owner actions:** none.

### Current state

All [verified] at `a643bcab` unless marked otherwise.

**Setup today**
- `SetupControls` renders Link Telegram, Connect Google, Connect iMessage (#1257) and Set quiet hours. Each row has a "Setting recorded"/"To do" chip and a link reading `Manage {title.toLowerCase()}`, which produces "Manage link telegram" (`dashboard-app/src/Panels.tsx:145-153`).
- The projection is `telegram_linked`, `google_access_granted`, `quiet_hours_set`, plus `imessage_linked` when the view has an iMessage block (`runtime/src/channels/dashboard-controls.ts:79-84`). The SPA validates these at `controls-model.ts:31,113-118`.
- Only the dashboard reads the `setup` view. App controls serve only day, connections and activity (`app-controls.ts:46`).
- The day projection already carries `timezone_confirmed` (`dashboard-controls.ts:36`), read from identity KV (`owner-do.ts:3407`).

**A "has chatted" signal already exists**
- `ConsoleView.lastRequest` (`console.ts:193`) comes from the one-row table `owner_request_last` (`harness.ts:72-79,145-151`), which is in the owner's own DO SQLite. The view already builds it (`owner-do.ts:3424`).
- An owner turn writes it on every surface, including the app chain that S4 reuses (`owner-turn.ts:786`).
- The trace prune never clears it. Only account erase (`deleteAll`, `owner-do.ts:926,1474`) does.
- iMessage link codes are redeemed in the bridge, so linking does not count as a chat.
- Existing tests pin this behaviour:
  - `harness.test.ts:53` (survives the prune);
  - `owner-request-hop.test.ts:11,26` (one marker per turn; it becomes the console's last request);
  - `forget-store-table.test.ts:31` (no owner text in it).
- Reading it needs no `owner-do.ts` change.

**Profile and history**
- Profile route: `#/memory/profile` (`destinations.ts:37,47`; `App.tsx:29,34`).
- Profile lists every claim that is not `inferred` (`memory/claims.ts:1001-1004`). `remember` writes owner-grounded, stated rows (`tools/live/memory.ts:56-63`; `claims.ts:414`).
- The served history is newest first (`app-api.ts:221`). `next_cursor` is null only at the start of the conversation (`:233`).
- A turn's reply has `parentId` = the owner's message (`conversation/joined-path.ts:84`). Two other kinds of assistant row also exist:
  - "did not finish" notices (`owner-do.ts:790-792`);
  - scheduled messages, whose parent is the leaf at write time (`owner-do.ts:771-774`).

**Tour prerequisites**
- Every route except `#/admin` renders only after the overview read. Today mounts as a new subtree under `key={route.split('/')[0]}` (`App.tsx:214-216`). Anchors on Today therefore exist only after the commit that shows Today.
- `resolveRoute('today?…')` resolves to `today` (`App.tsx:30-36`; `App.test.tsx:48-49`).
- G-key shortcuts listen on `window` and skip only form fields (`App.tsx:192-204`).
- The gear is `App.tsx:212`. S4's chat link reuses its `settings-link` class (S4, Changes 14).
- On phones the nav is a fixed bottom tab bar (`style.css:398-401`).
- No dialog, coach mark or `localStorage` code exists in `src/`. `Shell.review.test.tsx:27` asserts no `<dialog>` on a default render.
- happy-dom 20.14.5's `showModal()` only sets `open`, and its `getBoundingClientRect` returns zeros. Placement must therefore be a pure function.

**Telegram**
- React Connections always shows a Telegram row with "Link a Telegram account" (`Controls.tsx:90-93`).
- The classic console offers it too (`console.ts:222-223,238` and checklist `:332`). It is linked from the React footer (`App.tsx:217`) and from Settings (`Settings.tsx:23`).

**"Dashboard" in user-visible copy**
- `App.tsx:67` aria-label "Dashboard pages".
- `App.tsx:126` "Couldn’t load your dashboard."
- `App.tsx:161` and `model.ts:46` "The dashboard could not load right now."
- `model.ts:26,49` "…unsupported data shape."
- `model.ts:41` "Sign in to see your dashboard."
- `App.tsx:210` aria-label "Waldo dashboard home".
- `Panels.tsx:137` "this dashboard cannot invent a target".
- Runtime:
  - `console.ts:144` (the receipt the SPA shows for an incomplete forget);
  - `dashboard-static.ts:28,36,39,47` (503 bodies).

**Contrast** (WCAG luminance script)

| Use | Value | Ratio | Result |
|---|---|---|---|
| `--t3` #8a8985 on canvas / white | | 3.16 / 3.50 | fails |
| #6f6e69 on canvas / white | | 4.60 / 5.11 | passes |
| `--t2` #6b6b68 on the nav pill (`--fill` over canvas, `style.css:92-93`) | | 4.46 | fails |
| `--t2` #6b6b68 on the Settings track (`--fill-2` over canvas, `:166-168`) | | 4.20 | fails |
| #5e5e5b (design system `text-secondary`) on the same two surfaces | | 5.41 / 5.12 | passes |
| `.rail-axis` (`:194`) | new `--t3` at `opacity:.8` | 3.41 | fails |
| Night `--t3` #85847f on the night tile #272725 (`:594`) | | 3.99 | fails |
| Orange #fb943f as a focus ring on white / canvas | | 2.23 / 2.01 | fails 3:1 |
| Ink ring on white / canvas | | 17.4 / 15.7 | passes |
| Orange against the 40% scrim | | 1.28 | fails |
| Ink against the 40% scrim | | 6.1 | passes |

**Undefined classes**
- `.eyebrow` is used at `Constellation.tsx:116,123,124`, `MemoryActions.tsx:34`, `OwnerControls.tsx:109` and `Workspace.tsx:108`.
- `.controls-section-heading` is used at `OwnerControls.tsx:109` and `Workspace.tsx:108`.
- Neither is defined. The design-system README says "There are no eyebrows."

**Tests:** dashboard 31 files and 216 tests pass locally. CI does not run them (`package.json:12,21`; `verify.yml:114-115`). `test/dashboard-controls.test.ts` has 13 tests, which pass in the workers pool in this container.

### Design

**1. The tour covers Today only.**
- It is opened by `#/today?tour=1` and never navigates.
- That one link is the seam: All set, the chat readback and Setup all use it. App consumes the parameter once with `history.replaceState`, so a reload or Back does not reopen the tour.
- **The step list is computed in `useLayoutEffect`, after the commit that mounts Today.** In a render-phase initializer the Today anchors do not exist yet on any entry path.

**2. A native `<dialog>` with `showModal()`.**
- In browsers this gives the top layer, an inert page and contained Tab. Escape, focus and storage are handled explicitly, and the tests exercise those.
- A spotlight sits over the anchor. Its `0 0 0 100vmax` shadow is the scrim (`rgba(18,18,18,.4)`), with a **2px ink ring**: orange would be 1.28:1 against the scrim.
- Focus stays on Next/Done on open and after each step. The counter, heading and body sit in one `aria-live="polite"` region, so Enter, Enter, Enter walks the tour and each step is announced.

**3. On phones the card is a sheet on the half away from its anchor.** The Memory anchor sits in the bottom tab bar, so a plain bottom sheet would cover it.

**4. One local "seen" flag (try/catch).** It only hides the readback's "Show me around". "Show the tour again" in Setup always works. The tour never opens by itself, because a modal would take focus from the chat mid-reply.

**5. The readback.**
- It appears after the reply to the owner's first message: the oldest assistant row whose `parentId` is the oldest user row, and only once the start of the conversation is loaded.
- It renders only if `controls?view=profile` returns saved lines. It shows no claim text: Profile does that, so the card can never show a wrong or sensitive line.
- Its wording ("what he’s kept about you") stays true even for an owner whose Profile predates the console.
- Lines that are confirmed but not owner-grounded are not labelled for now. On a visitor's first day, Profile lines come from `remember` or their own confirmations; nightly-confirmed lines come later. Labelling them needs an additive provenance field; file it under `post-mvp-cleanup`.

**6. Setup comes from additive projection fields.**
- `timezone_confirmed` is added.
- `first_chat_recorded = view.lastRequest !== null` lands with S4.
- `telegram_linked` stays (removing it would be drift) and becomes unread.
- An absent optional field renders "Not in this read", never "To do".
- Telegram leaves Setup.
- Connections "Chat" group rule, shared with S6: each row renders only when it applies, and the group and its label are hidden when no row renders. The whole group is not wrapped in `telegram.linked`. The Telegram row applies only when Telegram is already linked, so relink and Unlink stay for owners who use it.

**7. Classic console Telegram is a known limitation.** The classic page keeps its Telegram offer because it is the only relink path for existing Telegram owners. New visitors reach it only through the footer and Settings links. Hiding it would strand owners who unlink; retiring it is a follow-up for the Telegram sunset. The React unlink confirmation now says where relinking happens.

**8. Focus is one ink ring.**
- `:focus-visible { outline:2px solid var(--ink); outline-offset:2px }`.
- This is the design system's B10:309 rule ("one focus style everywhere… ink on light, white on dark"). Night `--ink` is light, so the dark scene follows automatically.
- Plain orange (2.23:1) fails B16's 3:1. A two-tone ring would need `box-shadow`, which loses to six existing component shadows, so it would not be one style.
- The three `--action` SVG and map focus strokes move to `--ink`. The scene's orange-on-dark (`memory-map.css:100`, 7.7:1) stays.

**9. Copy.** `--t3` → #6f6e69, `--t2` → #5e5e5b, night `--t3` → #9a9994. Remove the `.rail-axis` opacity. `.eyebrow` becomes `.label`, and `.controls-section-heading` becomes the existing `.section-head` (`style.css:110`).

### Changes, file by file

Paths are relative to `/home/user/waldo-backend`.

#### S5a

**`packages/runtime/src/channels/dashboard-controls.ts:79-84`**: additive fields on the setup projection.
```ts
setup: (view: ConsoleView) => ({
  telegram_linked: view.telegram.linked,
  google_access_granted: view.google.accounts.some((account) => !account.error),
  quiet_hours_set: view.proactivity.quiet_start !== null,
  ...(view.imessage ? { imessage_linked: view.imessage.linked } : {}),
  timezone_confirmed: view.timezoneConfirmed,
  // Only with S4: owner_request_last holds the newest owner turn from any surface and is never pruned with the trace log.
  first_chat_recorded: view.lastRequest !== null,
}),
```

**`packages/runtime/src/channels/console.ts:144`**: end the `node.forget.incomplete` notice with "…no retry target is available here."

**`packages/runtime/src/channels/dashboard-static.ts`**: add `const UNAVAILABLE = 'Waldo is unavailable right now. Try again in a moment.';` and use it as all four 503 bodies (`:28,36,39,47`).

**`packages/dashboard-app/src/controls-model.ts:31,113-118`**: one loop over the optional booleans, replacing #1257's single-field line.
```ts
export type SetupRecord = Base<'setup', { telegram_linked: boolean; google_access_granted: boolean; quiet_hours_set: boolean;
  imessage_linked?: boolean; timezone_confirmed?: boolean; first_chat_recorded?: boolean }>;
const OPTIONAL_SETUP = ['imessage_linked', 'timezone_confirmed', 'first_chat_recorded'] as const;
// setup branch of readControls:
if (![data.telegram_linked, data.google_access_granted, data.quiet_hours_set].every(v => typeof v === 'boolean')
  || OPTIONAL_SETUP.some(key => data[key] !== undefined && typeof data[key] !== 'boolean')) throw shapeError();
return { ...base, view: 'setup', data: { telegram_linked: data.telegram_linked, google_access_granted: data.google_access_granted, quiet_hours_set: data.quiet_hours_set,
  ...Object.fromEntries(OPTIONAL_SETUP.filter(key => data[key] !== undefined).map(key => [key, data[key]])) } } as Records[V];
```

**`packages/dashboard-app/src/Panels.tsx:145-153`**: replace `SetupControls` with an explicit row shape. S6 builds on this.
- `SetupRow` is the row type.
- `setupRows(data, imessage)` returns the ordered rows: time zone, quiet hours, Google, **iMessage (when not null)**, then Say hello (only with S4).
- `iMessageSetupRow(data)` is #1257's item, unchanged in behaviour: always shown, `/console/imessage`, done when `imessage_linked`. S6 replaces this one function, and the call site in `SetupControls` if it needs its readiness hook.
- `SetupRowView` renders one row.
```tsx
import { IPHONE_WAITLIST_URL } from './links';
export type SetupRow = Readonly<{ key: 'timezone' | 'quiet' | 'google' | 'imessage' | 'hello'; title: string; body: string;
  state: 'done' | 'todo' | 'unknown'; done: string; href: string; link: string }>;
// Absent means this read cannot say (an older projection), which is not the same as "to do".
const known = (value: boolean | undefined): SetupRow['state'] => value === undefined ? 'unknown' : value ? 'done' : 'todo';
export const iMessageSetupRow = (d: SetupRecord['data']): SetupRow | null => ({ key: 'imessage', title: 'Connect iMessage',
  body: 'Text Waldo from your own iPhone. Get a one-time code, then tap Open Messages and send it; only your number reaches your Waldo.',
  state: d.imessage_linked === true ? 'done' : 'todo', done: 'Linked', href: '/console/imessage', link: 'Open iMessage' });
export function setupRows(d: SetupRecord['data'], imessage: SetupRow | null): SetupRow[] {
  const chatted = d.first_chat_recorded === true;
  return [
    { key: 'timezone', title: 'Confirm your time zone', body: 'Cards, reminders and quiet hours follow it.', state: known(d.timezone_confirmed), done: 'Confirmed', href: '#/settings/day', link: 'Open Your day' },
    { key: 'quiet', title: 'Set quiet hours', body: 'Choose when he holds cards and updates. Reminders you set still fire.', state: known(d.quiet_hours_set), done: 'Set', href: '#/settings/day', link: 'Open Your day' },
    { key: 'google', title: 'Connect Google', body: 'Saved grants are access permission. Check an actual Calendar or Gmail request in chat to verify a live read.', state: known(d.google_access_granted), done: 'Connected', href: '#/connections', link: 'Open Connections' },
    ...(imessage ? [imessage] : []),
    // Only when S4 has merged (otherwise this row and first_chat_recorded are both left out):
    { key: 'hello', title: 'Say hello', body: chatted ? 'Check what he kept in Memory › Profile.' : 'Tell him about your week in chat. He can keep what matters.', state: known(d.first_chat_recorded), done: 'Done', href: chatted ? '#/memory/profile' : '#/chat', link: chatted ? 'Open Profile' : 'Open chat' },
  ];
}
const SetupRowView = ({ row }: { row: SetupRow }) => <article className="control-row"><div><h3>{row.title}</h3><p>{row.body}</p>
  <span className={`access-label${row.state === 'done' ? ' done' : ''}`}>{row.state === 'done' ? row.done : row.state === 'todo' ? 'To do' : 'Not in this read'}</span></div>
  <a href={row.href}>{row.link}</a></article>;
export function SetupControls({ record }: { record: SetupRecord }) {
  return <section className="panel"><h2>Setup</h2>
    {setupRows(record.data, iMessageSetupRow(record.data)).map(row => <SetupRowView key={row.key} row={row}/>)}
    <article className="control-row"><div><h3>Get the iPhone app</h3><p>Your body data comes through the iPhone app.</p></div>
      <a href={IPHONE_WAITLIST_URL} target="_blank" rel="noopener noreferrer">Join the waitlist<span className="visually-hidden"> (opens in a new tab)</span></a></article>
  </section>;
}
```
- `Panels.tsx:137`: change the ending to "…Ask Waldo in chat to inspect the incomplete removal; this page can’t choose one for you."

**`packages/dashboard-app/src/Controls.tsx:90-93`**: the "Chat" group follows the shared rule. Each row applies or not, and the group and its label render only when at least one row applies. S6 appends its iMessage entry to `chatRows`.
```tsx
// Chat rows render only when they apply. Telegram is kept for owners who already use it and never offered to new people here.
const chatRows: { key: string; node: ReactNode }[] = [
  ...(telegram.linked ? [{ key: 'telegram', node: <li className="branch"><details name="connections" className="disclosure">{/* existing Telegram summary and body, :91-93 */}</details></li> }] : []),
];
// …in the tree, replacing :90-93:
{chatRows.length > 0 && <><p className="tree-group label">Chat</p><ul>{chatRows.map(row => <Fragment key={row.key}>{row.node}</Fragment>)}</ul></>}
```
- Import `Fragment` and `type ReactNode` from `react`.
- Inside the Telegram row, the `broken` class, the "Unlinked" label and the `telegram.linked &&` half of the Unlink condition become dead once the row requires `linked`. Drop them. Keep "Link a Telegram account" (relink), and keep Unlink behind `telegram.unlinkAvailable`.
- Unlink confirmation: `'Unlink Telegram? Waldo stops messaging it. To link it again, use the classic console.'`

**`packages/dashboard-app/src/App.tsx`**:
- `:67` `aria-label="Main pages"`.
- `:126` `'Couldn’t load this page.'`
- `:161` `'Nothing was changed. Try again in a moment.'`
- `:210` `aria-label="Waldo home"`.

**`packages/dashboard-app/src/model.ts`**:
- `:26,49` `'This page got a reply it can’t read. Refresh to try again.'`
- `:41` `'Your session has ended. Sign in again to carry on.'`
- `:46` `'Nothing was changed. Try again in a moment.'`

**`packages/dashboard-app/src/style.css`**:
- `:17` `--t2:#5e5e5b;`
- `:18` `--t3:#6f6e69;`
- `:46` `:focus-visible { outline:2px solid var(--ink); outline-offset:2px; }`
- Below `:101`, add `main:focus-visible { outline:none; }`: `#main` is a skip target, and the existing `main{outline:none}` loses to `:focus-visible`.
- `:194` drop `opacity:.8` from `.rail-axis`.
- `:347,382` and `memory-map.css:13` change `var(--action)` to `var(--ink)`.
- `:594` night `--t3:#9a9994`.
- In the 640px block (`:398`), add `.control-row { grid-template-columns:1fr; gap:8px; }`. Setup links currently sit in a squeezed second column at 390px, because there is no phone override of `:271`.

**Class swaps:**
- `className="eyebrow"` → `"label"` at `Constellation.tsx:116,123,124`, `MemoryActions.tsx:34`, `OwnerControls.tsx:109` and `Workspace.tsx:108`.
- `controls-section-heading` → `section-head` at `OwnerControls.tsx:109` and `Workspace.tsx:108`.

**`packages/dashboard-app/scripts/preview.mjs`**: in the setup fixture, add `timezone_confirmed: true` (plus `first_chat_recorded: false` with S4). For `--case=empty`, make every setup boolean `false`.

**`packages/dashboard-app/README.md:7`**: list Setup and Sessions as Settings tabs, which they are (`Settings.tsx:8`).

#### S5b

**`packages/dashboard-app/src/Tour.tsx`** (new):
```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
export const TOUR_HASH = '#/today?tour=1';
const SEEN_KEY = 'waldo.console.tour';
// A per-browser convenience: blocked storage only means the tour keeps being offered.
export const tourSeen = (): boolean => { try { return window.localStorage.getItem(SEEN_KEY) === 'seen'; } catch { return false; } };
const markTourSeen = () => { try { window.localStorage.setItem(SEEN_KEY, 'seen'); } catch { /* see tourSeen */ } };

export type TourStep = Readonly<{ id: 'day' | 'decisions' | 'memory' | 'chat' | 'settings'; anchor: string; title: string; body: string }>;
export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'day', anchor: '[data-tour="day"]', title: 'Your day', body: 'What’s next today and what’s gone out, as recorded. Change the times in Settings › Your day.' },
  { id: 'decisions', anchor: '[data-tour="decisions"]', title: 'What needs you', body: 'When he needs your yes, it shows here first. Waiting keeps the full list, so you can read each one before you decide.' },
  { id: 'memory', anchor: '.primary-nav a[href="#/memory"]', title: 'What he knows', body: 'Memory › Profile is what he’s kept about you. If something’s wrong, tell him in chat. To remove something, open it in Spots and choose Forget this Spot.' },
  { id: 'chat', anchor: '[data-tour="chat"]', title: 'Talk to him', body: 'The same chat as the iPhone app. Ask him something, tell him something, or correct him.' },
  { id: 'settings', anchor: '[data-tour="settings"]', title: 'Settings', body: 'Google, quiet hours, your time zone and Setup are here. You can show this tour again from Setup.' },
];

type Box = Readonly<{ top: number; left: number; width: number; height: number; radius: number }>;
export type Placement = Readonly<{ side: 'below' | 'above' | 'sheet-top' | 'sheet-bottom'; top?: number; left?: number }>;
const GUTTER = 16, GAP = 12, CARD_WIDTH = 340;
/** Beside the anchor on wide screens; on phones a sheet on the half away from it (Memory sits in the bottom tab bar). */
export function placeCard(anchor: Box, view: Readonly<{ width: number; height: number }>, cardHeight: number, phone: boolean): Placement {
  if (phone) return { side: anchor.top + anchor.height / 2 > view.height / 2 ? 'sheet-top' : 'sheet-bottom' };
  const width = Math.min(CARD_WIDTH, view.width - 2 * GUTTER);
  const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, GUTTER), view.width - width - GUTTER);
  const below = anchor.top + anchor.height + GAP;
  return below + cardHeight <= view.height - GUTTER ? { side: 'below', top: below, left } : { side: 'above', top: Math.max(GUTTER, anchor.top - GAP - cardHeight), left };
}
const measure = (selector: string): Box | null => {
  const el = document.querySelector<HTMLElement>(selector); if (!el) return null;
  const r = el.getBoundingClientRect(), radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12;
  return { top: r.top, left: r.left, width: r.width, height: r.height, radius: Math.min(radius, r.height / 2) };
};

export function Tour({ onClose, steps = TOUR_STEPS }: { onClose: () => void; steps?: readonly TourStep[] }) {
  const dialog = useRef<HTMLDialogElement>(null), card = useRef<HTMLDivElement>(null), primary = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(document.activeElement), closed = useRef(false);
  const [shown, setShown] = useState<readonly TourStep[] | null>(null);
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const close = () => {
    if (closed.current) return; closed.current = true;
    markTourSeen();
    if (dialog.current?.open) dialog.current.close();
    const back = opener.current;
    (back instanceof HTMLElement && back.isConnected && back !== document.body ? back : document.getElementById('main'))?.focus();
    onClose();
  };
  // After commit: Today's anchors mount in the same commit as the tour. A step whose anchor is absent is left out, not faked.
  useLayoutEffect(() => { setShown(steps.filter(step => document.querySelector(step.anchor))); }, []);
  useEffect(() => { if (shown === null) return; if (!shown.length) { close(); return; } const d = dialog.current; if (d && !d.open) d.showModal(); }, [shown]);
  const step = shown?.[at];
  useLayoutEffect(() => {
    if (!step) return;
    const el = document.querySelector<HTMLElement>(step.anchor), r = el?.getBoundingClientRect();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (el && r && (r.top < 64 || r.bottom > window.innerHeight - 80)) el.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const next = measure(step.anchor); setBox(next);
      if (next) setPlace(placeCard(next, { width: window.innerWidth, height: window.innerHeight }, card.current?.offsetHeight ?? 200, window.matchMedia?.('(max-width: 640px)').matches ?? false));
    }); };
    update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [step?.id]);
  useEffect(() => { primary.current?.focus(); }, [at, shown]);
  if (!shown || !step) return null;
  const last = at === shown.length - 1;
  return <dialog ref={dialog} className="coach" aria-labelledby="coach-title" aria-describedby="coach-body"
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    {box ? <div className="coach-spot" aria-hidden="true" style={{ top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12, borderRadius: box.radius + 6 }}/>
      : <div className="coach-scrim" aria-hidden="true"/>}
    <div ref={card} className="coach-card" data-side={place?.side ?? 'below'} style={place?.top === undefined ? undefined : { top: place.top, left: place.left }}>
      <div aria-live="polite"><p className="label">{at + 1} of {shown.length}</p><h2 id="coach-title">{step.title}</h2><p id="coach-body">{step.body}</p></div>
      <div className="control-actions">
        <button type="button" className="quiet" onClick={close}>Close</button>
        {at > 0 && <button type="button" onClick={() => setAt(n => n - 1)}>Back</button>}
        <button ref={primary} type="button" className="primary" onClick={() => last ? close() : setAt(n => n + 1)}>{last ? 'Done' : 'Next'}</button>
      </div>
    </div>
  </dialog>;
}
```

**`packages/dashboard-app/src/Readback.tsx`** (new):
```tsx
import { useEffect, useState } from 'react';
import type { ChatMessage } from './chat-model';
import { fetchControls } from './controls-model';
import { TOUR_HASH, tourSeen } from './Tour';

/** The reply to the owner's first message, once the conversation's start is loaded. `shown` is oldest first, as ChatPanel displays it.
 *  Scheduled rows and notices that are not a reply to that message are skipped. */
export function firstReplyId(shown: readonly Pick<ChatMessage, 'id' | 'role' | 'parentId'>[], reachedStart: boolean): string | null {
  if (!reachedStart) return null;
  const first = shown.find(message => message.role === 'user');
  return first ? shown.find(message => message.role === 'assistant' && message.parentId === first.id)?.id ?? null : null;
}
/** Shown once Profile holds something. It names no saved text; Profile does. */
export function SavedReadback({ replies }: { replies: number }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (saved) return;
    const abort = new AbortController();
    fetchControls('profile', abort.signal)
      .then(record => { if (!abort.signal.aborted) setSaved(record.data.removal.state === 'none_recorded' && record.data.sections.some(s => s.lines.some(line => line.trim()))); })
      // No card is better than a wrong one; ChatPanel already reports sign-out and network failure.
      .catch(() => undefined);
    return () => abort.abort();
  }, [replies, saved]);
  if (!saved) return null;
  return <aside className="tile readback" aria-labelledby="readback-title">
    <h2 id="readback-title">What he’s kept about you</h2>
    <p>Memory › Profile shows it. If something’s wrong, tell him here.</p>
    <div className="control-actions"><a className="quiet-link" href="#/memory/profile">Open Profile</a>{!tourSeen() && <a className="quiet-link" href={TOUR_HASH}>Show me around</a>}</div>
  </aside>;
}
```

**`packages/dashboard-app/src/Chat.tsx`** (S4's `ChatPanel`):
- Keep `reachedStart`, which is true when the oldest loaded page's `nextCursor === null`.
- Compute `const firstReply = firstReplyId(shownOldestFirst, reachedStart)`.
- Directly after the row whose `id === firstReply`, render `<SavedReadback replies={shownOldestFirst.filter(m => m.role === 'assistant').length}/>`.

**`packages/dashboard-app/src/App.tsx`**:
```tsx
import { Tour } from './Tour';
const tourAsked = () => { const [path = '', query = ''] = window.location.hash.replace(/^#\/?/, '').split('?'); return resolveRoute(path) === 'today' && new URLSearchParams(query).get('tour') === '1'; };
// App():
const [touring, setTouring] = useState(tourAsked);
// existing onHash (:149): setRoute(currentRoute()); setTouring(tourAsked()); window.scrollTo?.(0, 0);
// The request is used once: a reload or Back to Today does not reopen it.
useEffect(() => { if (touring) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/today`); }, [touring]);
// after </footer>:
{touring && route === 'today' && state.kind === 'ready' && <Tour onClose={() => setTouring(false)}/>}
```
- `:100` add `data-tour="day"` to the rail tile.
- `:101` add `data-tour="decisions"` to the focus tile.
- `:212` add `data-tour="settings"` to the gear.
- Add `data-tour="chat"` to S4's top-bar chat link.
- `:196` add `,dialog` to the `closest(...)` selector, so G-shortcuts cannot navigate from under an open tour.

**S3's `Welcome.tsx`**:
- `finish` becomes `(to = '#/today') => { writeLocal({ done: true }); onLeave(); window.location.hash = to; }`.
- `DoneStep` types `onFinish: (to?: string) => void` and adds a quiet button "Show me around" that calls `onFinish(TOUR_HASH)`. This sets S3's `done` flag, so S3's "Pick up where you left off" card does not appear under the tour.

**`packages/dashboard-app/src/Panels.tsx`**: append `<p className="caption"><a href={TOUR_HASH}>Show the tour again</a></p>` inside the Setup panel.

**`packages/dashboard-app/src/style.css`** (append):
```css
/* Tour: the spotlight's wide shadow is the scrim; its ring is ink because orange vanishes against it. */
.coach { position:fixed; inset:0; width:100%; height:100%; max-width:none; max-height:none; margin:0; padding:0; border:0; background:transparent; overflow:visible; }
.coach::backdrop { background:transparent; }
.coach-spot { position:fixed; pointer-events:none; box-shadow:0 0 0 2px var(--ink),0 0 0 100vmax rgba(18,18,18,.4); transition:top .24s cubic-bezier(0,0,.2,1),left .24s cubic-bezier(0,0,.2,1),width .24s cubic-bezier(0,0,.2,1),height .24s cubic-bezier(0,0,.2,1); }
.coach-scrim { position:fixed; inset:0; background:rgba(18,18,18,.4); }
.coach-card { position:fixed; width:340px; max-width:calc(100vw - 32px); padding:18px 20px; background:var(--tile); border-radius:var(--r-card); box-shadow:0 12px 32px rgba(26,26,26,.12),0 2px 6px rgba(26,26,26,.06); animation:rise .4s var(--ease) backwards; }
.coach-card h2 { font-size:17px; margin:4px 0 6px; }
.coach-card .control-actions { justify-content:flex-end; }
.readback { margin:8px 0 16px; }
@media(max-width:640px) {
  .coach-card { left:16px; right:16px; width:auto; max-width:none; }
  .coach-card[data-side="sheet-bottom"] { top:auto; bottom:calc(16px + env(safe-area-inset-bottom)); }
  .coach-card[data-side="sheet-top"] { top:calc(16px + env(safe-area-inset-top)); bottom:auto; }
  .coach-card .control-actions { flex-direction:row; }
  .coach-card button { min-height:44px; }
}
```
The existing reduced-motion rule (`:433-435`) removes the rise and the transition.

**`packages/dashboard-app/README.md`**: add one sentence on the tour (`#/today?tour=1`) and the readback.

### UI and copy

All copy uses sentence case, British spelling and "he", with no exclamation marks. The copy test enforces this.

**Tour.**
- **Desktop:** a 340px white card with radius 20 and the overlay shadow. It sits 12px below its anchor, or above it when there is no room, and is clamped 16px from the edges. The anchor gets a 2px ink ring and the rest of the page is dimmed to 40%.
- **Card contents:** a `.label` counter ("1 of 5"), an h2, the body, then right-aligned quiet "Close", grey "Back" (from step 2) and ink "Next", which becomes "Done" on the last step.
- **Phone (≤640px):** a full-width sheet, 16px from the edge, on the half away from the anchor. The buttons are 44px.

| # | Anchor | Heading | Body |
|---|---|---|---|
| 1 | Day rail tile | Your day | What’s next today and what’s gone out, as recorded. Change the times in Settings › Your day. |
| 2 | Waiting focus tile | What needs you | When he needs your yes, it shows here first. Waiting keeps the full list, so you can read each one before you decide. |
| 3 | Memory nav link | What he knows | Memory › Profile is what he’s kept about you. If something’s wrong, tell him in chat. To remove something, open it in Spots and choose Forget this Spot. |
| 4 | Chat link (S4) | Talk to him | The same chat as the iPhone app. Ask him something, tell him something, or correct him. |
| 5 | Settings gear | Settings | Google, quiet hours, your time zone and Setup are here. You can show this tour again from Setup. |

- **Accessibility:**
  - The dialog is named by its heading and described by its body.
  - Focus sits on Next/Done.
  - The counter, heading and body are announced on each step.
  - Tab stays inside the dialog.
  - Escape or Close ends the tour, marks it seen and returns focus to the opener, or to `#main` when the opener has gone.
  - With reduced motion, the scroll is instant.

**Readback (in `#/chat`, under the first reply).**
- A `.tile` with the h2 "What he’s kept about you" and the body "Memory › Profile shows it. If something’s wrong, tell him here."
- Quiet links: "Open Profile" (`#/memory/profile`) and "Show me around" (`#/today?tour=1`, hidden once the tour has been seen).
- When nothing is saved, the read fails or removal is incomplete, it renders nothing. Send stays the only ink pill on the screen.

**Settings › Setup** (h2 "Setup"; each row is a `.control-row` with an `.access-label` chip, green `.done` when done)

| Row | Body | Done chip | Link |
|---|---|---|---|
| Confirm your time zone | Cards, reminders and quiet hours follow it. | Confirmed | Open Your day → `#/settings/day` |
| Set quiet hours | Choose when he holds cards and updates. Reminders you set still fire. | Set | Open Your day |
| Connect Google | Saved grants are access permission. Check an actual Calendar or Gmail request in chat to verify a live read. | Connected | Open Connections |
| Connect iMessage (#1257 item; S6 later replaces `iMessageSetupRow`) | Text Waldo from your own iPhone. Get a one-time code, then tap Open Messages and send it; only your number reaches your Waldo. | Linked | Open iMessage → `/console/imessage` |
| Say hello (with S4) | Before: "Tell him about your week in chat. He can keep what matters." After: "Check what he kept in Memory › Profile." | Done | "Open chat" → `#/chat`, then "Open Profile" → `#/memory/profile` |
| Get the iPhone app | Your body data comes through the iPhone app. | (none) | "Join the waitlist", new tab, with the hidden text "(opens in a new tab)" |

- The chip reads "To do" when not done, and "Not in this read" when the field is absent.
- In S5b, a caption at the bottom reads "Show the tour again".
- On phones the link stacks under the row's text.

**Settings › Connections.**
- An owner without Telegram sees no Telegram row. When no chat row applies, they also see no "Chat" group label.
- A linked owner's unlink confirmation reads "Unlink Telegram? Waldo stops messaging it. To link it again, use the classic console."

**Errors** (existing layout)
- **Signed out:** "Sign in to your Waldo." / "Your session has ended. Sign in again to carry on."
- **Failed read:** "Couldn’t load this page." / "Nothing was changed. Try again in a moment." / Try again.
- **Malformed reply:** "This page got a reply it can’t read. Refresh to try again."
- **Accessible names:** "Main pages" and "Waldo home".

### Security, privacy and authority

**Security review: not triggered.** There is no auth change, no DO memory write and no new edge function (AGENTS.md triggers). One independent review on the exact head is enough.

- **No new endpoint, writer, cookie, CSRF path or rate-limit bucket.** The readback reuses the existing owner-session profile read (same-origin, `no-store`, `redirect:'error'`; `controls-model.ts:138`).
- **The projection gains two booleans about the owner's own state,** behind the existing session check. `ConsoleView` is unchanged.
- **Stored:** `localStorage['waldo.console.tour'] = 'seen'`, per browser. It holds no id, email or content. Every access is wrapped in try/catch.
- **`?tour=1`:** any link can set it, but it only opens a read-only overlay and grants nothing.
- **Waitlist link:** `rel="noopener noreferrer"`.
- **Health:** S5 renders no claim text or numbers, and the readback deliberately does not echo saved lines. Nothing new is logged.
- **Never** put a visitor's email, an invite link or Profile text into a screenshot caption, fixture or PR body.

### Tests

Dashboard tests run in happy-dom (`// @vitest-environment happy-dom`). CI does not run them: run them locally and paste the counts.

**Golden test (S5b, `Tour.test.tsx`)**
- **Setup:** mount `App` at `#/settings/setup` with fetch stubbed (empty-owner overview as in `App.test.tsx:5`; S4's chat link present). Resolve the overview, then set the hash to `#/today?tour=1`.
- **Assert:**
  - a `dialog[open]` headed "Your day", with the counter "1 of 5";
  - `location.hash === '#/today'`;
  - Next four times reaches "Settings", whose spotlight anchor is the gear (`href="#/settings"`, not `#/chat`);
  - "Done" closes the tour, `localStorage['waldo.console.tour']==='seen'`, and `#main` has focus.

**`Tour.test.tsx`, other cases**
1. **First-load path:** the overview is pending, then resolves, with the hash already `#/today?tour=1` → "1 of 5" and "Your day". This guards the after-commit anchor scan.
2. **Order and Back:** steps follow `TOUR_STEPS`, and Back is absent on step 1.
3. **Escape:** a keydown Escape calls `onClose` once, and a following `cancel` event does not call it again.
4. **Focus return:** focus `<button id="opener">`, mount, press Escape → the opener has focus. If the opener is removed first → `#main`.
5. **Null:** with no anchors there is no dialog and `onClose` is called. Without a `[data-tour="chat"]` anchor, the counter reads "of 4".
6. **Storage revoked:** `getItem` and `setItem` throw → the tour opens and closes, and `tourSeen()` is `false`.
7. **Hostile:**
   - `#/memory?tour=1`, `#/admin?tour=1`, `#/today?tour=%3Cscript%3E` and `#/today?tour=true` open nothing;
   - `#/today?tour=1&owner=other` opens and leaves `#/today`;
   - G then M inside the dialog leaves the hash unchanged.
8. **`placeCard`:**
   - room below → `below`; no room → `above`;
   - left is clamped to 16 on both edges;
   - on a phone, an anchor in the bottom half → `sheet-top`; in the top half → `sheet-bottom`.

**`Readback.test.tsx` (S5b)**
- `firstReplyId`:
  - `reachedStart:false` → `null`;
  - no user row → `null`;
  - a scheduled assistant row before the first user row is skipped, and the reply whose `parentId` is that user id is chosen;
  - with no matching reply → `null`.
- `SavedReadback`:
  - sections with lines → links to `#/memory/profile` and `#/today?tour=1`;
  - `tourSeen` → no "Show me around";
  - `sections: []` → nothing;
  - `removal.state:'incomplete'` → nothing;
  - **401** → nothing;
  - **network rejection** → nothing;
  - a change to `replies` re-reads after an empty first read.
- **Hostile:** a Profile line `'Pill at 9 owner-line-marker'` never appears in `container.textContent`.

**`Chat.test.tsx` (S4's file, S5b case):** with two pages loaded, the oldest having `nextCursor:null`, the readback mounts right after the reply to the first user message.

**`Welcome.test.tsx` (S3's file, S5b case):** "Show me around" sets the hash to `#/today?tour=1`, and `JSON.parse(localStorage['waldo.welcome.v1']).done === true`.

**S5a tests**

`Panels.test.tsx` (extends `:96-107`):
- **New shape, all false:**
  - "To do" on each stateful row;
  - hrefs `#/settings/day` and `#/connections` (and `#/chat` with S4);
  - a waitlist link with `target="_blank"` and `rel="noopener noreferrer"`;
  - **no "Telegram"**.
- **All true:** "Confirmed", "Set", "Connected" and "Done", with "Open Profile".
- **Old shape (three booleans only):** the time zone row reads "Not in this read".
- `setupRows(data, null)` has no iMessage row. With `iMessageSetupRow(data)`, the row sits fourth, after Google and before Say hello.
- Keep #1257's case (`:102-107`) passing unchanged.
- `:99`: change `href="#/day"` to `href="#/settings/day"`.

`controls-model.test.ts` (`:37-38`):
- accepts the old and new shapes;
- rejects `first_chat_recorded:'yes'` and `timezone_confirmed:1`;
- drops an unknown `html` field.

`Controls.test.tsx` (`:45`):
- unlinked → no "Telegram" and no "Chat" group label;
- linked → the "Chat" label, relink and Unlink, as now;
- linked with `unlinkAvailable:false` → no Unlink (`:55-57`, unchanged).

`copy.test.tsx` (new):
- **Renders:**
  - Today, empty and recorded;
  - `DashboardNavigation`;
  - `DashboardFeedback`, using `new SignInRequired().message` and both `fetchOverview` failure messages;
  - `SetupControls`, `ConnectionsControls` and `ProfileControls` with removal incomplete;
  - in S5b, extend it with the Tour steps and `SavedReadback`.
- **Collects** `textContent` plus the values of `aria-label`, `title` and `alt`.
- **Asserts none match:**
  - `/\bdashboard\b/i`, `/\bget started\b/i`, `/\blearn more\b/i`, `/\boops\b/i`;
  - `/Loading(…|\.\.\.)/`, `/\bjourney\b/i`, `/\bseamless\b/i`, `/\bsmart\b/i`;
  - `/\bAI-powered\b/i`, `/\bwellness\b/i`, `/\boptimi[sz]e/i`, `/\bMeet Waldo\b/`;
  - `/Something went wrong/i`, `/!/`.

`tokens.test.ts` (new, node environment). Parse `style.css` `:root {…}` and `:root[data-scene="night"] {…}`, then assert:
- **≥4.5:**
  - `--ink`, `--t2` and `--t3` on `--canvas` and `--tile`, light and night;
  - `--t2` on `--fill` and `--fill-2`, composited over canvas and over tile.
- **≥3:**
  - `--ink` on canvas and tile, light and night;
  - `--ink` over the scrim.
- **CSS checks:**
  - the `:focus-visible` outline is `var(--ink)`;
  - `.rail-axis` has no `opacity`.

Updates to existing tests:
- `Shell.review.test.tsx:24` → `nav[aria-label="Main pages"]`.
- `App.test.tsx:87,90` → the new message strings.
- `model.test.ts:33` → `toThrow('Try again in a moment')`.
- `model.test.ts:34-35` → `toThrow('can’t read')`.

**Runtime tests**

`test/dashboard-controls.test.ts:112-120`:
- update the three `toEqual`s with `timezone_confirmed: true` (and `first_chat_recorded: false` with S4);
- `timezoneConfirmed:false` → `false`;
- no `imessage` → no `imessage_linked` key;
- the JSON never carries the `lastRequest` trace id.

`test/owner-request-hop.test.ts:26` (with S4): after recording, `projectControls({ ...SAMPLE_CONSOLE_VIEW, lastRequest: book.lastRequest('UTC') }, 'setup').data.first_chat_recorded === true`. This ties the harness semantics to the projection.

`test/dashboard-static.test.ts:19`:
- the 503 body equals the new sentence;
- `Object.values(NOTICES)` has no `/\bdashboard\b/i`.

### Acceptance trace

- **CI:** `pnpm -r typecheck`, the dashboard build with `verify:assets` (`verify.yml:114-115`), and the runtime workers tests.
- **LOCAL** (not in CI): the dashboard vitest run, with the file and test counts.
- **SOURCE** (synthetic preview screenshots):
```sh
cd /home/user/waldo-backend/packages/dashboard-app && npx -y pnpm@10.34.4 build
node scripts/preview.mjs --case=empty --port=4178 &
# Playwright as for current-*.png: require('/opt/node-tools/node_modules/playwright'), PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
```
  - Desktop 1440x900 and phone 390x844.
  - Capture `#/settings/setup` (`s5a-setup`), `#/connections` (`s5a-connections`) and `#/today` (`s5a-today`). Compare against `screens/current-*-settings-setup.png` and `current-*-today.png`.
  - With S5b, capture `#/today?tour=1` and press Next between `s5b-tour-1` and `s5b-tour-5`.
  - **Check:** grey text is darker, a focused button shows the ink ring, the phone sheet sits at the top for the Memory step, and there is no Telegram row.

**STAGING** (after an owner-authorised deploy, with S3 and S4 live):
1. A fresh invited visitor finishes `#/welcome` and sends a first message in `#/chat`.
2. After the reply, "What he’s kept about you" appears if Waldo saved anything. If it does not appear, an empty Profile is a pass for S5 and a model observation for #1227.
3. "Open Profile" shows card stacks.
4. "Show me around" opens the tour on Today with five steps. Tab, Enter and Escape behave as specified, and the Settings step rings the gear.
5. Settings › Setup reads time zone "Confirmed", quiet hours "Set", Google "Connected" (only with S1 and a Google test user), Say hello "Done", and has no Telegram row. The waitlist link opens heywaldo.in/waitlist in a new tab.
6. Connections shows no Telegram row for this visitor. An existing Telegram owner still sees it.
7. DevTools: `.meta` computes to `rgb(111, 110, 105)`.

### Verification commands

Run from `/home/user/waldo-backend` at the exact head SHA. Record PASS, FAIL or UNAVAILABLE per step.
```sh
git diff --check
npx -y pnpm@10.34.4 install --frozen-lockfile
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app test           # LOCAL; baseline 31 files / 216 tests
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app typecheck
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app build
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app verify:assets  # one JS + one CSS
(cd packages/runtime && npx vitest run test/dashboard-controls.test.ts test/dashboard-static.test.ts test/owner-request-hop.test.ts)
npx -y pnpm@10.34.4 -r typecheck
WALDO_DO_MIGRATION_BASE_REF=HEAD^1 npx -y pnpm@10.34.4 verify:guards
npx -y pnpm@10.34.4 verify:workers
npx -y pnpm@10.34.4 verify    # verify:supabase and the session-revocation integration need Docker: UNAVAILABLE here
```

### Rollback

Revert S5b, then S5a.
- **The projection change is additive.** Older SPAs ignore the new keys, and the new SPA shows "Not in this read" when a key is absent.
- **Nothing persistent changes:** no migration, no DO state, no `owner-do.ts` change.
- **The leftover `localStorage` key is inert.**
- **Partial reverts are single lines:** the focus ring and each token, with `tokens.test.ts` naming any pair that then fails, and the Telegram gate.

### Risks and open questions

- **The brief asked for an orange focus ring.**
  - **Default:** the ink ring, because orange is 2.23:1 and B10 asks for one style.
  - **If design insists on orange:** it must be two-tone, with the per-component shadow exceptions listed in the PR.
- **`--t2` → #5e5e5b darkens secondary text across the console.** **Default:** ship it. It is the design system's `text-secondary`, and the nav and Settings tracks fail without it. Attach before and after screenshots.
- **The classic console still offers Telegram** (Design 7). **Default:** accept it as a known limitation. File a follow-up to retire it with the Telegram sunset.
- **`first_chat_recorded` also turns true from any owner turn:**
  - a turn that later failed;
  - a turn on Telegram or iMessage;
  - a staging `/probe-turn` run against that owner's object (`owner-do.ts:1061`).
  **Default:** accept. The row means "a message from you reached him". The pinning tests above catch a harness change.
- **Profile can later show nightly-confirmed lines that are not owner-grounded.** **Default:** no label; file under `post-mvp-cleanup`.
- **`.cal-cell.empty b` keeps `opacity:.6`** (below 4.5:1) for inactive calendar days. **Default:** leave it as an inactive-component exception and name it in the PR.

### Effort

**M, about 7 hours.**

| PR | Estimate | Scope |
|---|---|---|
| S5a | S, about 3h | Projection, Setup, Connections, copy and tokens, with tests |
| S5b | M, about 4h | Tour, readback, App and S3/S4 hooks, tests and screenshots |

**Lanes:** the SPA (`packages/dashboard-app`), plus non-`owner-do.ts` runtime: `dashboard-controls.ts`, `dashboard-static.ts` and one string in `console.ts`. No `owner-do.ts`, no migrations and no `packages/contracts`.

## S6 iMessage linking in the React console (staging, post-demo)

> **Status:** reviewed; the revision against S5a's final Setup and Connections shapes is in progress. Do not start S6 until this line is gone.

> **Base note.** The brief pinned e5c022ef. While this section was being written, beta-mvp moved to **04bb8c89**, which includes #1257 (`ashish/connect-imessage-one-tap`) and #1241. #1257 already ships one-tap linking on the classic page and the app. This section is rescoped to the **remaining gap** and anchored at 04bb8c89. I diffed every cited file between e5c022ef and 04bb8c89: `bridge-do.ts`, `directory.ts`, `dashboard-owner-controls.ts`, `dashboard-control-actions.ts`, `console-auth.ts`, `Controls.tsx`, `OwnerControls.tsx`, `style.css` and the iMessage fixture are unchanged; `owner-do.ts`, `imessage/console.ts`, `app-api.ts`, `Panels.tsx`, `App.tsx`, `console-signin.ts` and the migration lists moved, and are cited at their 04bb8c89 lines.
>
> **Freeze.** Ansh approved a demo freeze on #1103 at 19:27Z on 14 Oct. S6 lands **after the 15 Oct showcase** unless Ansh adds it.

### Outcome

On staging, an owner opens **Connections** in the React console (or reaches the **Connect** step of `#/welcome`) and sees an **iMessage** row in Waldo's design. The row offers "Get my code", then shows `waldo CODE`, Waldo's address and an **Open Messages** button that prefills the text. The row moves to **Linked** on its own once the text arrives, shows the masked handle and offers **Unlink iMessage**. The row exists only when the connector is on **and** the shared Waldo number can answer right now. Otherwise nothing is shown, so a visitor never gets a code that nobody will redeem. The job to be done: "let me text my Waldo from my iPhone without leaving the console or reading an unstyled operator page".

### Depends on / blocks

- **Builds on #1257 (merged):** `imessage/send-url.ts` (`iMessageSendUrl`), the app contract `appIMessageLinkCodeV1Schema` and the issuer path. S6 reuses all three and adds no second flow.
- **S0 (operator actions):**
  - apply the new migration on staging (`deploy-staging.yml`, operation `migration-apply`);
  - deploy the Worker;
  - confirm on `/console/imessage` as the operator that the shared number shows "active · online · text verified";
  - have a real iPhone ready for the trace.
- **S3 (soft):** S6 exports `<IMessageLink placement="welcome"/>` for S3's Connect step. If S3 has merged, S6 mounts it. If not, S6 ships the Connections row and S3 mounts the card using the snippet below.
- **S5 (coordinate):** S5 reworks the Setup rows and the Connections copy. S6 touches the Setup "Connect iMessage" row from #1257 and one line in the Chat group of `Controls.tsx`. Whichever lands second rebases. If S5 removes the iMessage Setup row, S6 drops that hunk.
- **Lanes:**
  - Ashish owns `channels/imessage/**` and must review.
  - The Mac lane sequences `owner-do.ts`; S6 changes 2 existing lines there and adds none.
  - The migration lane takes one additive function.
- **Blocks:** nothing.

### Current state

What exists and can be reused (all [verified] at 04bb8c89 unless marked otherwise):

- **Issuer:** `consoleAuth.issueProviderLinkCode(doName, 'imessage')` (`identity/console-auth.ts:150-154`).
  - The code is 10 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (`:55-56`).
  - The SQL replaces any unused code for the provider and expires it after 10 minutes (`supabase/migrations/20261014120000_waldo_imessage_shared_bridge.sql:41-42`).
  - Redemption upper-cases the code (`identity/owner-directory.ts:30-31`).
- **Masked hint and unlink:**
  - `iMessageHandleHint` (`console-auth.ts:174-177`) returns the last 4 characters, or 2 for handles shorter than 8 (`20261014120000:282-295`).
  - `unlinkIMessage` is at `console-auth.ts:173`.
- **One-tap link (#1257):**
  - `iMessageSendUrl(address, code)` builds `sms:<address>&body=waldo%20CODE` (`channels/imessage/send-url.ts:5`). It is dependency-free so `app-api.ts` loads in plain Node (commit 42f036ce).
  - The classic page renders it (`imessage/console.ts:51-59`, used at `:85-87`).
  - The app route `POST /app/v1/channels/imessage/link-code` returns `appIMessageLinkCodeV1Schema` = `{code,text,address,send_url,expires_in_seconds:600}` (`app-api.ts:165-175`; `contracts/src/app/core.ts:91-94`).
- **Bridge behaviour:**
  - "waldo CODE" is always a link action, never a model turn (`bridge-do.ts:384-386`; `LINK_TEXT` `:69`).
  - Redemption is throttled to 5 per sender per hour (`:409`).
  - Fixed replies are in `LINK_REPLIES` (`:70-75`).
  - The bridge's own system-reply readiness gate is `systemReplyReady` (`:425-431`): host online, fresh capabilities ready, text send, verified and exact-target, and no quarantine.
  - `status()` (`:253-261`) omits `exactTarget`.
- **JSON owner-controls route:** `dashboard-owner-controls.ts` serves `/console/dashboard/api/v1/owner[/actions]` (`:7-8`).
  - It has a field allowlist (`:52-53`), a view/action pairing allowlist (`:55`), a csrf check through `parseConsoleAction` (`console.ts:124-129`), `request_id` idempotency (`:57-71`), a revision check (`:75`) and a pending receipt written before the effect (`:77-78`).
  - It keeps raw codes out of the durable journal (`:49-50`, `:88`).
  - owner-do wires it inside `this.serial` after the session re-check. The rate limit is 90 reads and 20 actions per minute per owner (`owner-do.ts:1464-1474`). The deps object is at `:1474`.
  - The Worker forwards these paths only for a verified owner cookie, with JSON 401s (`console-signin.ts:342-360`).
- **Config:**
  - Production has `IMESSAGE_CONNECTOR_ENABLED "0"` and `IMESSAGE_WALDO_ADDRESS ""` (`packages/runtime/wrangler.jsonc:20`).
  - Staging has `"1"` and `woof@heywaldo.in` (`:87`).
  - The composition gate is `iMessageComposition` (`bridge-do.ts:31-39`).

What is missing or broken:

1. **No readiness signal for normal owners.** A normal owner cannot learn whether the shared number is online:
   - `imessage_list` returns only bridges the caller owns (`20261014120000:252-260`), and the shared bridge is owned by the operator (`:53`);
   - every other read needs the bridge ids;
   - no runtime code stores a pointer to the shared bridge (grep for `bridgeDoName` and `shared` under `channels/`).
2. **No React UI for linking.**
   - The React Connections Chat group has only Telegram (`dashboard-app/src/Controls.tsx:90-93`).
   - The connections action allowlist has no `imessage.*` (`dashboard-control-actions.ts:19`).
3. **#1257 entry points lead to the classic page and are never gated.**
   - The Setup row "Connect iMessage" links `/console/imessage` (`Panels.tsx:149`), and the footer links it too (`App.tsx:217`).
   - On production that page answers 404 "iMessage is not enabled." (`imessage/console.ts:61-62`), so both are dead ends there.
   - On staging they show whether or not the bridge is online.
4. **Out of scope, noted.**
   - The app route is gated on the address only, not on composition or readiness (`app-api.ts:167-168`).
   - owner-do reads `presence_hint` on every console view build, even with the connector off (`owner-do.ts:3410-3415`).
5. **Scheduled delivery.** Scheduled work (Brief, reminders) runs only for app-bound or Telegram-linked owners (`owner-do.ts:678-695`). iMessage gets replies only, and the copy must say so.

### Design

**Approach.** Add a third view, `imessage_link`, to the existing JSON owner-controls module. It has a read with readiness, and two actions (`imessage.link`, `imessage.unlink`) that call the same issuer and unlink as the classic page and app. The view's runtime state comes from a port in `imessage/console.ts`, which owner-do injects into the owner-controls deps. The port does four things:

1. Gates on `iMessageComposition` and a configured address. This makes no remote calls on production.
2. Reads the masked hint.
3. Asks a new signed SQL function for the environment's one active shared bridge (ids only).
4. Asks that bridge DO a new boolean `linkReady()`. That method is `systemReplyReady(...) !== 'unavailable'`, the exact gate the bridge uses to answer "waldo CODE".

The action response carries the same `appIMessageLinkCodeV1Schema` payload as the app route, built by one shared helper in `send-url.ts`. The SPA adds one self-contained component, `IMessageLink`, with two placements, plus a tiny read hook. The hook gates the #1257 Setup row and re-points it to `#/connections`.

Why this shape:

- **Codes never reach the durable receipt book.** Owner-controls already guarantees it (`dashboard-owner-controls.ts:49-50`). The connections action path stores receipt messages durably (`dashboard-control-actions.ts:64-71`), and its `telegram.link` receipt already carries the raw code (`owner-do.ts:1504-1506`).
- **Smaller owner-do footprint.** Owner-controls needs one deps property in owner-do. The connections path needs `runtime.setup()`/`runtime.view()` and a `ConsoleView` change (`owner-do.ts:1481-1490`).
- **Plain-Node constraint.** `dashboard-owner-controls.ts` is in `app-api.ts`'s import graph (`console-signin.ts:1`, imported by `app-api.ts:12`). It may only `import type` from `imessage/console.ts`, which pulls in `cloudflare:workers`. That is why the port is injected.
- **Surface guard.** `'imessage'` is a declared surface (`contracts/src/app/surfaces.ts:5`). `guard-surface-neutral-core` counts any `=== 'imessage'` compare in a new file, so the view is named `imessage_link`. Action strings like `'imessage.link'` do not match the guard pattern.

Alternatives rejected:

- **Connections allowlist + `ConsoleView` block** (the brief's first idea): the code would persist in the receipt book, and the change touches owner-do view building.
- **Readiness from `status()`:** it misses `exactTarget`. `linkReady()` is the authoritative gate.
- **Gate on composition plus address only (#1257's app route):** it offers codes while the Mac is offline. The owner rule is never a dead end.
- **A shared-bridge pointer written by the bridge DO on heartbeat:** a second writer and new state.
- **Bridge ids as code constants:** they change on every re-pair.
- **No deep link:** #1257 shipped `iMessageSendUrl` as the team's single owner for it. S6 reuses it and always shows the code and copy buttons as fallback. On-device behaviour is a STAGING/LIVE check in the trace.

### Changes, file by file

**1. `supabase/migrations/<UTC timestamp>_waldo_imessage_shared_readiness.sql` (new).** Default name `20261015120000_waldo_imessage_shared_readiness.sql`. The timestamp must sort after every file in `supabase/migrations` at merge: staging applies only a canonical prefix (`scripts/staging-migration-preflight.mjs:17`), and #1241 already added `20261014130000`.

```sql
-- Owner console readiness for the shared Waldo number: the environment's one active shared bridge, ids only,
-- so the console can ask that bridge whether it can answer "waldo CODE" now. No credential, operator, sender or
-- handle leaves; only the router-signed runtime can call it.
create function waldo.imessage_shared_bridge(p_environment text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  perform waldo.imessage_signed('shared', p_locator, jsonb_build_array(p_environment), p_at, p_sig);
  select b.bridge_id, b.account_id into r from waldo.imessage_bridges b join waldo.owners o on o.id = b.owner_id
    where b.environment = p_environment and b.kind = 'shared' and b.state = 'active' and o.state = 'active';
  if r.bridge_id is null then return null; end if;
  return jsonb_build_object('bridge_id', r.bridge_id, 'account_id', r.account_id);
end $$;
revoke all on function waldo.imessage_shared_bridge(text, text, bigint, text) from public, anon, authenticated;
grant execute on function waldo.imessage_shared_bridge(text, text, bigint, text) to anon;
```

There is at most one active shared bridge per environment (`20261014120000:56`). The grant pattern matches the siblings (`:297-308`).

**2. Migration lists.**
- `scripts/verify-supabase-migrations.mjs:65`: add the filename after `'20261014130000_waldo_device_pairing_owner.sql',`.
- `supabase/fixtures/assert-canonical-migration-history.sql:65`: add a comma after `'20261014130000'` and the new version on the next line. `guard-migration-fixture-sync` checks both.

**3. `supabase/tests/waldo_imessage_shared_bridge.sql`.** Insert before `select * from finish();` (`:175`). The shared bridge `bid('5')` is still active at that point.

```sql
create function pg_temp.shared(env text default 'test') returns jsonb language sql as $$
  select waldo.imessage_shared_bridge(env, jsonb_build_array(env)::text, pg_temp.at(), pg_temp.isig('shared', jsonb_build_array(env)::text)) $$;
select throws_ok($$ select waldo.imessage_shared_bridge('test', '["test"]', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'forged shared-bridge lookup refused');
select throws_ok($$ select waldo.imessage_shared_bridge('test', '["other"]', pg_temp.at(), pg_temp.isig('shared', '["other"]')) $$, '42501', 'imessage locator mismatch', 'a locator for another environment is refused');
select is(pg_temp.shared(), jsonb_build_object('bridge_id', pg_temp.bid('5'), 'account_id', pg_temp.aid('5')), 'the active shared bridge, ids only');
select is(pg_temp.shared('other'), null, 'another environment has no shared bridge');
select is(waldo.imessage_revoke('sh-op', pg_temp.bid('5'), jsonb_build_array('sh-op', pg_temp.bid('5'))::text, pg_temp.at(),
  pg_temp.isig('revoke', jsonb_build_array('sh-op', pg_temp.bid('5'))::text)), true, 'the operator revokes the shared bridge');
select is(pg_temp.shared(), null, 'a revoked shared bridge is not offered');
```

**4. `packages/runtime/src/channels/imessage/directory.ts`.** Add after `list` (`:98-102`):

```ts
    /** The environment's one active shared bridge, ids only (the console asks it whether it can link), or null. */
    async sharedBridge(environment: string): Promise<{ bridgeId: string; accountId: string } | null> {
      const r = await call('imessage_shared_bridge', 'shared', { p_environment: environment });
      if (r === null) return null;
      const row = typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : {};
      if (!/^imb_[0-9a-f]{32}$/.test(String(row.bridge_id)) || !/^ima_[0-9a-f]{32}$/.test(String(row.account_id))) throw new IMessageDirectoryUnavailable();
      return { bridgeId: String(row.bridge_id), accountId: String(row.account_id) };
    },
```

**5. `packages/runtime/src/channels/imessage/bridge-do.ts`.** Add after `status()` (`:253-261`):

```ts
  /** Whether this bridge can answer a "waldo CODE" text now: the same gate as its system replies. A boolean only. */
  async linkReady(): Promise<boolean> {
    const c = this.composition();
    if (!c) return false;
    const store = this.store(c.policy), bridgeId = store.meta('bridge_id'), accountId = store.meta('account_id');
    return !!bridgeId && !!accountId && store.revokedRevision() === null && this.systemReplyReady(store, bridgeId, accountId) !== 'unavailable';
  }
```

`'retry'` (lane busy) counts as ready.

**6. `packages/runtime/src/channels/imessage/send-url.ts`.** Add one shared payload builder. The app route and the console are its two callers.

```ts
/** The answer to "connect iMessage": the code, the exact text, where to send it, the one-tap link and the code's
 * lifetime (waldo.issue_provider_link_code expires it after 10 minutes). */
export const iMessageLinkCode = (address: string, code: string) =>
  ({ code, text: `waldo ${code}`, address, send_url: iMessageSendUrl(address, code), expires_in_seconds: 600 as const });
```

**7. `packages/runtime/src/channels/app-api.ts`.**
- `:2`: import `iMessageLinkCode` alongside `iMessageSendUrl`, or instead of it if `iMessageSendUrl` becomes unused there.
- `:172`: replace the inline literal with `return ok(appIMessageLinkCodeV1Schema.parse(iMessageLinkCode(address, code)));`.

There is no behaviour change; the existing `app-api.test.ts` iMessage cases must stay green.

**8. `packages/runtime/src/channels/imessage/console.ts`.** Append:

```ts
/** What the owner console shows for "text Waldo": readiness, the address and the masked hint. Never a bridge id, the operator or a full handle. */
export type IMessageLinkState = Readonly<{ offer: boolean; address: string | null; linkedHint: string | null }>;
export type IMessageLinkPort = Readonly<{ state(owner: string): Promise<IMessageLinkState>; issue(owner: string): Promise<string | null>; unlink(owner: string): Promise<boolean> }>;
const LINK_OFF: IMessageLinkState = { offer: false, address: null, linkedHint: null };

// Readiness is the shared bridge's own reply gate. Any doubt reads as not ready: a code nobody can answer is a dead end.
const sharedBridgeReady = async (env: IMessageEnv, environment: string): Promise<boolean> => {
  try {
    const shared = await iMessageDirectory(env).sharedBridge(environment);
    if (!shared) return false;
    const ns = env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO>;
    return await ns.get(ns.idFromName(iMessageBridgeName(environment, shared.bridgeId, shared.accountId))).linkReady();
  } catch { return false; }
};

export const iMessageLinkPort = (env: IMessageEnv): IMessageLinkPort => ({
  async state(owner) {
    const c = iMessageComposition(env), address = env.IMESSAGE_WALDO_ADDRESS ?? '', hint = consoleAuth(env)?.iMessageHandleHint;
    if (!c || !address || !owner || !hint) return LINK_OFF; // connector off (production): no directory or bridge calls at all
    const [linkedHint, offer] = await Promise.all([hint(owner), sharedBridgeReady(env, c.environment)]);
    return { offer, address, linkedHint };
  },
  issue: async (owner) => (await consoleAuth(env)?.issueProviderLinkCode?.(owner, 'imessage')) ?? null,
  unlink: async (owner) => (await consoleAuth(env)?.unlinkIMessage?.(owner)) === true,
});
```

A failure in `hint` propagates, so the read is a 503 and the SPA hides the row. A "not linked" state is never assumed.

**9. `packages/runtime/src/channels/dashboard-owner-controls.ts`.**

```ts
import type { IMessageLinkPort } from './imessage/console'; // type only: app-api.ts loads this file in plain Node via console-signin.ts
import { iMessageLinkCode } from './imessage/send-url';
import { appIMessageLinkCodeV1Schema } from '../../../contracts/src/app/core';
export type OwnerControlsView = 'invites' | 'account' | 'imessage_link';
// OwnerControlsDeps gains:  imessage: IMessageLinkPort | null;
const iMessageUnknown: Receipt = { state: 'unconfirmed', message: 'The outcome is unconfirmed. Refresh to see whether your number is linked. A new code replaces any earlier one.' };
const iMessageIssued: Receipt = { state: 'recorded', message: 'Link code issued. It works once, for 10 minutes. This receipt does not keep it.' };

async function projection(view: OwnerControlsView, deps: OwnerControlsDeps) {
  if (!deps.owner) return null;
  if (view === 'imessage_link') {
    if (!deps.imessage) return null;
    const link = await deps.imessage.state(deps.owner);
    return { version: 1 as const, view, state: 'available' as const, csrf: deps.csrf,
      data: { offer: link.offer, address: link.offer ? link.address : null, linked_hint: link.linkedHint } };
  }
  if (!deps.auth) return null;
  /* existing invites/account body unchanged */
}
```

- `ownerControlsView` (`:37-41`): accept `'imessage_link'`.
- `ownerControlsAction`:
  - `:55`: `const iMessage = view === 'imessage_link' && (action?.action === 'imessage.link' || action?.action === 'imessage.unlink');` and add `|| iMessage` to the pairing allowlist.
  - `:59`: `if (!deps.owner || (iMessage ? !deps.imessage : !deps.auth)) return unavailable();`
  - After the quota check at `:76`: `if (iMessage && 'offer' in current.data && !(action.action === 'imessage.link' ? current.data.offer : current.data.linked_hint !== null)) return reply({ error: 'no_longer_eligible' }, 409);`
  - `:77`: the pending receipt is `iMessage ? iMessageUnknown : unknown`.
  - Before the `invite.member` branch (`:80`), add:

```ts
  if (iMessage) {
    let code: string | null = null, done: boolean;
    try { done = action.action === 'imessage.link' ? (code = await deps.imessage!.issue(deps.owner)) !== null : await deps.imessage!.unlink(deps.owner); }
    catch { return reply({ receipt: iMessageUnknown, duplicate: false }, 503); }
    receipt = action.action === 'imessage.link'
      ? (done ? iMessageIssued : { state: 'rejected', message: 'A link code could not be issued. Nothing changed.' })
      : (done ? { state: 'recorded', message: 'Unlinked. Texts from that number no longer reach your Waldo.' } : { state: 'rejected', message: 'Nothing was linked, so nothing changed.' });
    status = done ? 200 : 409;
    book[key] = { fingerprint, expires: deps.expires, status, receipt };
    try { await deps.store.put('console:owner-control-receipts', book); } catch { return reply({ receipt: iMessageUnknown, duplicate: false }, 503); }
    const address = 'address' in current.data ? current.data.address : null;
    return reply({ receipt, duplicate: false, ...(code && address ? { link: appIMessageLinkCodeV1Schema.parse(iMessageLinkCode(address, code)) } : {}) }, status);
  }
```

**10. `packages/runtime/src/channels/owner-do.ts` (2 lines changed, 0 added; the Mac lane sequences it).**
- `:7`: add `iMessageLinkPort` to the existing `./imessage/console` import.
- `:1474`: append `,imessage:iMessageLinkPort(this.imessageHost.env)` to the `deps` object. `imessageHost` is at `:617`.

No surface compares are added, so the `guard-surface-neutral-core` baseline of 58 stays.

**11. `packages/runtime/test/helpers/imessage-fixture-directory.ts`.**
- Add the handler: `imessage_shared_bridge: (a) => { const b = [...bridges.values()].find((x) => x.kind === 'shared' && x.state === 'active' && x.environment === a.p_environment && owner(x.owner)?.state === 'active'); return b ? { bridge_id: b.bridge_id, account_id: b.account_id } : null; },`
- Add `imessage_shared_bridge: 'shared'` to the op map at `:142-144`.

**12. `packages/dashboard-app/src/IMessage.tsx` (new).** The sketch below is complete except for the JSX, which follows "UI and copy".

```tsx
import { useEffect, useRef, useState, type Ref } from 'react';
import { SignInRequired } from './model';
import { Icon } from './icons';
import { shouldPoll } from './live';
const PATH = '/console/dashboard/api/v1/owner';
export const LINK_POLL_MS = 4_000;
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
export type IMessageLinkRead = { csrf: string; revision: string; offer: boolean; address: string | null; linkedHint: string | null };
export type IMessageCode = { code: string; text: string; address: string; sendUrl: string; expiresAt: number };
type Action = 'imessage.link' | 'imessage.unlink';
type Receipt = { state: 'recorded' | 'incomplete' | 'rejected' | 'unconfirmed'; message: string };
export type IMessageResult = { duplicate: boolean; receipt: Receipt; code: IMessageCode | null };
export class IMessageChangeError extends Error {}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
export const COPY = { /* every string from "UI and copy", in one place for tests */ } as const;

export function readIMessageLink(raw: unknown): IMessageLinkRead {
  const fail = () => new Error('imessage_link_unreadable');
  if (!object(raw) || raw.version !== 1 || raw.view !== 'imessage_link' || raw.state !== 'available' || !text(raw.csrf) || !raw.csrf || !text(raw.revision) || !/^[0-9a-f]{64}$/.test(raw.revision) || !object(raw.data)) throw fail();
  const d = raw.data;
  if (typeof d.offer !== 'boolean' || !(d.address === null || text(d.address) && d.address.length >= 3) || (d.offer && d.address === null)
    || !(d.linked_hint === null || text(d.linked_hint) && d.linked_hint.length >= 2 && d.linked_hint.length <= 4)) throw fail();
  return { csrf: raw.csrf, revision: raw.revision, offer: d.offer, address: d.address as string | null, linkedHint: d.linked_hint as string | null };
}
export async function fetchIMessageLink(signal?: AbortSignal): Promise<IMessageLinkRead> {
  const response = await fetch(`${PATH}?view=imessage_link`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal, headers: { accept: 'application/json' } });
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error('imessage_link_unavailable');
  return readIMessageLink(await response.json());
}
export const iMessageVisible = (read: IMessageLinkRead | null) => !!read && (read.offer || read.linkedHint !== null);
export function readIMessageResult(raw: Record<string, unknown>, action: Action, now: number): IMessageResult {
  const r = raw.receipt;
  if (typeof raw.duplicate !== 'boolean' || !object(r) || !['recorded', 'incomplete', 'rejected', 'unconfirmed'].includes(String(r.state)) || !text(r.message)) throw new IMessageChangeError(COPY.unconfirmed);
  let code: IMessageCode | null = null;
  if (raw.link !== undefined) {
    const l = raw.link;
    if (action !== 'imessage.link' || raw.duplicate || r.state !== 'recorded' || !object(l) || !text(l.code) || !CODE.test(l.code) || l.text !== `waldo ${l.code}`
      || !text(l.address) || l.address.length < 3 || !text(l.send_url) || !l.send_url.startsWith('sms:') || l.send_url.length > 512 || l.expires_in_seconds !== 600) throw new IMessageChangeError(COPY.unconfirmed);
    code = { code: l.code, text: l.text, address: l.address, sendUrl: l.send_url, expiresAt: now + 600_000 };
  }
  return { duplicate: raw.duplicate, receipt: { state: r.state as Receipt['state'], message: r.message }, code };
}
export async function submitIMessage(read: IMessageLinkRead, action: Action, requestId: string, now = Date.now()): Promise<IMessageResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries({ csrf: read.csrf, view: 'imessage_link', revision: read.revision, request_id: requestId, action })) form.set(k, v);
  let response: Response;
  try { response = await fetch(`${PATH}/actions`, { method: 'POST', body: form, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } }); }
  catch { throw new IMessageChangeError(COPY.unconfirmed); }
  if (response.status === 401) throw new SignInRequired();
  if (response.status === 429) throw new IMessageChangeError(COPY.rateLimited);
  if (response.status === 400 || response.status === 403) throw new IMessageChangeError(COPY.refused);
  let raw: unknown; try { raw = await response.json(); } catch { throw new IMessageChangeError(COPY.unconfirmed); }
  if (!object(raw) || !object(raw.receipt)) throw new IMessageChangeError(response.status === 409 ? COPY.changed : COPY.unconfirmed);
  const result = readIMessageResult(raw, action, now);
  const coherent = response.ok && result.receipt.state === 'recorded' || response.status === 409 && result.receipt.state === 'rejected' || response.status === 503 && result.receipt.state === 'unconfirmed';
  if (!coherent) throw new IMessageChangeError(COPY.unconfirmed);
  return result;
}
export function useIMessageLinkRead(): IMessageLinkRead | null { /* one fetchIMessageLink in an effect with AbortController; null on any failure */ }
export function IMessageBody(props: { placement: 'connections' | 'welcome'; read: IMessageLinkRead | null; code: IMessageCode | null; expired: boolean; busy: boolean;
  notice: { tone: 'status' | 'alert'; text: string } | null; signedOut: boolean; openRef?: Ref<HTMLAnchorElement>;
  onIssue(): void; onUnlink(): void; onCopy(value: string, what: 'text' | 'address'): void }) { /* pure states, see UI and copy */ }
export function IMessageLink({ placement }: { placement: 'connections' | 'welcome' }) {
  // State: read, code, expired, busy, signedOut, notice, reload; refs inFlight and openRef.
  // Effect 1 [reload]: fetchIMessageLink -> setRead; on SignInRequired setSignedOut(true); other errors -> setRead(null).
  // Effect 2 [code]: while code is set, a setTimeout chain every LINK_POLL_MS: at Date.now() >= code.expiresAt -> setCode(null), setExpired(true), stop;
  //   skip the fetch while !shouldPoll(document.visibilityState); a read with linkedHint !== null -> setRead, setCode(null), notice COPY.linked(hint), stop;
  //   SignInRequired -> setSignedOut(true), setCode(null), stop; other errors -> keep polling. The cleanup clears the timer.
  // Effect 3 [code]: when a code appears, openRef.current?.focus().
  // act(action): guarded by inFlight; unlink first window.confirm(COPY.confirmUnlink(hint)); submitIMessage(read, action, crypto.randomUUID());
  //   link -> setCode(result.code) or a notice (rejected -> COPY.issueRejected, else COPY.unconfirmed);
  //   unlink -> notice COPY.unlinked | COPY.unlinkRejected | COPY.unlinkUnconfirmed; errors -> SignInRequired or notice(error.message); finally setReload(n+1).
  // copy(value, what): navigator.clipboard.writeText -> notice COPY.copiedText / COPY.copiedAddress; a throw -> notice COPY.copyFailed.
  // Visible only when iMessageVisible(read) || code || expired || notice; otherwise return null (hidden entirely).
}
```

**13. `packages/dashboard-app/src/Controls.tsx:91`.** In the Chat `<ul>`, insert `<IMessageLink placement="connections"/>` as the first child, before the Telegram `<li>`. Import it from `./IMessage`.

**14. `packages/dashboard-app/src/Panels.tsx:145-151`.**
- Call `const link = useIMessageLinkRead();` at the top of `SetupControls`.
- Replace the #1257 item with `...(iMessageVisible(link) ? [{ title: 'Connect iMessage', recorded: record.data.imessage_linked === true, href: '#/connections', description: COPY.setup }] : [])`. `recorded` keeps the existing `imessage_linked` field, so no orphan is created.
- Update `Panels.test.tsx:102-107`. Under SSR the item is now absent because the read has not run. The visible case moves to `IMessage.test.tsx`.

**15. `packages/dashboard-app/src/App.tsx:217`.** Remove `<a href="/console/imessage">iMessage</a> · ` from the footer. Connections now carries the flow. Operators still reach the classic page through the classic console nav (`runtime/src/channels/console.ts:548`). Default: remove. If Ashish wants it kept in review, keep it and note the production 404.

**16. `packages/dashboard-app/src/style.css` (append; CSS is not scanned by `guard-health-leak`, but TSX is, so put no font weights inline in TSX).**

```css
.imessage-head { display:flex; align-items:center; gap:10px; margin:0 0 8px; }
.imessage-head h2 { margin:0; }
.imessage-code { display:block; width:fit-content; max-width:100%; margin:4px 0 12px; padding:12px 16px; border-radius:var(--r-inner); background:var(--fill); color:var(--ink); font-size:26px; font-weight:600; letter-spacing:.06em; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; user-select:all; -webkit-user-select:all; }
.imessage-lists { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 20px; margin:6px 0 10px; }
.imessage-lists h3 { font-size:13px; font-weight:600; margin:0 0 4px; }
.imessage-lists ul { margin:0; padding-left:18px; color:var(--t2); font-size:14px; }
@media(max-width:640px) { .imessage-code { font-size:22px; } .imessage-lists { grid-template-columns:1fr; } }
```

**17. Welcome mount.** If S3 has merged, add `<IMessageLink placement="welcome"/>` in S3's Connect step, directly below the Google card. The file is S3's: find the `#/welcome` renderer and its Connect step. The card renders nothing when hidden, so the step needs no conditional.

**18. `packages/dashboard-app/scripts/preview.mjs`.**
- Add cases `imessage`, `imessage-linked` and `imessage-off`.
- `GET /console/dashboard/api/v1/owner?view=imessage_link` returns synthetic reads:
  - `imessage`: offer true, address `waldo@example.test`. After 2 GETs that follow a POST, return `linked_hint: '7731'`.
  - `imessage-linked`: offer true, hint `7731`.
  - `imessage-off`: offer false, address and hint null.
- `POST .../owner/actions` returns `{receipt:{state:'recorded',message:'…'},duplicate:false,link:{code:'K7QM2XRT9P',text:'waldo K7QM2XRT9P',address:'waldo@example.test',send_url:'sms:waldo@example.test&body=waldo%20K7QM2XRT9P',expires_in_seconds:600}}`.

### UI and copy

All copy lives in `COPY` in `IMessage.tsx`. Waldo is "he"; interface chrome says "Waldo". There are no exclamation marks or banned words, and spelling is British.

**Connections row (placement `connections`).**
- **Layout.** A `<li className="branch">` inside the Chat group, first, before Telegram. When the owner is not linked it gets `branch broken`, the dashed "Needs you" line, matching Telegram. It holds a `details.disclosure` (name `connections`). The summary has `<span className="marks"><Icon name="chat"/></span>`, value **iMessage**, and an `access-label` that reads **Linked** or **Not linked** (plain, not red).
- **Body states:**
  - **Ready** (offer, not linked, no code):
    - `<p>` "Link your number once, then text Waldo like anyone else."
    - `.imessage-lists` with two columns:
      - h3 "Waldo can": "Answer the texts you send him from your linked number or Apple ID address."
      - h3 "Waldo can't": "Read photos, files, group chats or SMS. Only direct iMessage text reaches him." and "Send your Brief or reminders by text."
    - `<p>` "Waldo keeps the number or address you link on your account, so only you reach your Waldo. Your texts pass through the Mac that runs Waldo’s number."
    - Primary button "Get my code". While the request is in flight it reads "Getting your code…" and is disabled with `aria-busy`.
  - **Code:**
    - h3 "Send this from your iPhone".
    - `<p className="imessage-code" aria-label="waldo K 7 Q M …">` showing `waldo K7QM2XRT9P`.
    - Actions: `<a className="button-link">` "Open Messages" (`href` = `send_url`) and a button "Copy the text".
    - `<p>` "On your iPhone, tap Open Messages, then Send. On a computer, text it from your iPhone to **woof@heywaldo.in**." followed by a quiet button "Copy address".
    - `<p>` "The code works once, for 10 minutes. Send it from the number or Apple ID you want to link."
    - `<p role="status" aria-live="polite">` "Waiting for your text…"
    - Quiet button "Get a new code", then `.meta` "A new code replaces this one." Both appear only while `offer` is true.
    - If a poll shows offer false while the code is shown: `<p>` "Waldo’s iMessage number isn’t answering right now. If nothing links before the code runs out, try again later."
  - **Linked:**
    - On the poll that sees the link: status "Linked. Texts from the number or address ending in 7731 now reach your Waldo."
    - Steady state: `<p>` "Linked to the number or address ending in **7731**. Texts from it reach only your Waldo."
    - If not `offer`: `<p>` "Waldo’s iMessage number is offline right now. Your link stays in place."
    - `.meta` "Not yours? Unlink it."
    - Button "Unlink iMessage". Confirm text: "Unlink iMessage? Texts from the number or address ending in 7731 stop reaching Waldo. You can link again with a new code."
  - **Expired:** `<p>` "That code has expired. Get a new one when you’re ready to send it." and primary "Get a new code".
- **Notices** (`role="status"` for success, `role="alert"` for problems):
  - Copied: "Copied the text." / "Copied the address."
  - Copy failed: "Couldn’t copy. Select it and copy it yourself."
  - Issue rejected: "Waldo couldn’t make a code just now. Nothing changed. Try again in a moment."
  - Unconfirmed: "Waldo couldn’t confirm that. If no code appears, get a new one; it replaces any earlier code."
  - Changed (409 without receipt): "Something changed while you were here, so nothing was done. Waldo checked again."
  - Refused (400/403): "That change wasn’t accepted. Reload the page and try again."
  - Rate limited: "Too many changes in a minute. Wait a moment, then try again."
  - Unlinked: "Unlinked. Texts from that number no longer reach your Waldo."
  - Unlink rejected: "Nothing was linked, so nothing changed."
  - Unlink unconfirmed: "Waldo couldn’t confirm the unlink. Check again in a moment."
  - Signed out (only while the row is visible): "Your session ended. Sign in again to link iMessage." with link "Sign in" (`/console/signin`).
- **Hidden:** while loading, on read failure, when the connector is off, or when the bridge is not ready and the owner is not linked. No skeleton is shown, so nothing flashes on production.

**Welcome card (placement `welcome`).**
- `<section className="tile" aria-labelledby="imessage-title">` with `.imessage-head`: `<span className="kind"><Icon name="chat"/></span>` and h2 "Text Waldo from your iPhone".
- The body states match the row, with one difference in the linked state: no Unlink button. Instead `.meta` reads "Not yours? Unlink it in [Connections](#/connections)."
- The step's own "Continue" or skip control is S3's. The card adds no skip.

**Setup row (#1257 item, re-pointed).** Title "Connect iMessage". Description: "Text Waldo from your own iPhone. Get a one-time code in Connections and send it from Messages. Only your number reaches your Waldo." It links to `#/connections` and appears only when `iMessageVisible`.

**Accessibility.**
- The code's `aria-label` spells the characters out.
- Focus moves to "Open Messages" when a code appears.
- Polling announces only state changes, through the `role="status"` line.
- Every button names its effect.
- The unlink confirmation names the consequence.
- Essential copy stays in `<p>` (`--t2`), not `.meta` (`--t3`, below 4.5:1 [inference]; S5 owns that fix).

**Phone vs desktop.** At 640px or less the code is 22px, the lists stack, and `.control-actions` wraps so buttons sit full width. On a phone "Open Messages" is the main path. On desktop the person reads the code and texts it from their iPhone. "Open Messages" stays visible because a Mac signed in to Messages may handle `sms:` [inference].

### Security, privacy and authority

- **Authentication.** Reads and actions go through the existing verified-owner-cookie forward (`console-signin.ts:342-360`) and the DO session re-check inside `this.serial` (`owner-do.ts:1464-1474`). The owner is the DO's own `do_name`. A forged `owner` field is refused by the field allowlist (`dashboard-owner-controls.ts:52-53`).
- **CSRF and freshness.** Form csrf must equal the session csrf (`console.ts:124-129`). The view and action must pair (`:55` plus the new rule). The read revision must match (`:75`). `request_id` makes requests idempotent (`:57-71`). Eligibility is rechecked from a fresh projection before any effect.
- **Rate limits.**
  - Existing per-owner buckets: 90 reads and 20 actions per minute (`owner-do.ts:1469-1472`), and 100 receipts per session (`:71`).
  - Redemption: 5 per sender per hour (`bridge-do.ts:409`).
  - Codes are single-use, last 10 minutes, and replace the owner's previous code (`20261014120000:41-42`).
  - No new limiter is added: each issue only replaces the caller's own code.
- **What is stored.**
  - S6 stores no code. The durable receipt is fixed text, and a test asserts the receipt book never contains the code.
  - The code appears only in the one action response and in the DOM. It never goes into a URL, `localStorage` or logs.
  - The link text is never a model turn (`bridge-do.ts:384-386`), so it never reaches Langfuse.
  - The browser receives only `offer`, the public address and a 2-4 character hint. Bridge ids, the operator and full handles stay server-side.
- **New SQL function.** It is router-signed, `stable` and returns ids only, with the same grant pattern as its siblings. The ids are not credentials: host requests need the wrapped key.
- **Health.** None is involved. `guard-health-leak` does not apply beyond keeping font weights in CSS.
- **Inherited risk (MEDIUM, by design).** The code is a 10-minute bearer secret. Whoever texts it first links their handle to that owner's Waldo. Mitigations in S6:
  - the linked state names the hint, with "Not yours? Unlink it.";
  - S0 should tell showcase hosts not to project a visitor's code on a shared screen.
- **Outside the diff (LOW, noted only).** The Telegram link code persists in the controls receipt book for the session (`owner-do.ts:1504-1506` into `dashboard-control-actions.ts:71`).
- **Security review: yes.** Presence linking is an identity binding, and S6 adds a new signed SQL function and new authenticated actions (AGENTS.md "Security Review Triggers").

### Tests

**Runtime unit tests.** `packages/runtime/test/dashboard-owner-controls.test.ts` (default runtime config). Extend `setup()` with a fake `imessage` port: `state` resolves `{offer:true,address:'waldo@fixture.invalid',linkedHint:null}`, `issue` resolves `'K7QM2XRT9P'`, `unlink` resolves `true`.
1. `ownerControlsView('view=imessage_link')` returns `'imessage_link'`. `view=imessage` returns null.
2. **Read shape.** The data keys are exactly `address, linked_hint, offer`. When offline but linked, `address` is null and `linked_hint` is `'7731'`. When off, it is `{offer:false,address:null,linked_hint:null}`.
3. **Read failure.** The port throws, so the status is 503 with `{error:'owner_controls_unavailable'}`.
4. **Golden.** `imessage.link` returns 200 `recorded`. `link` passes `appIMessageLinkCodeV1Schema.parse`, and `send_url === 'sms:waldo@fixture.invalid&body=waldo%20K7QM2XRT9P'`. `JSON.stringify([...stored])` does not contain `K7QM2XRT9P`. A replay returns `duplicate:true` with no `link`. `issue` was called once, with `'trusted-owner'`.
5. **Not eligible.** With `offer:false`, the action returns 409 `no_longer_eligible`, `issue` is not called and no receipt row is written. An unlink while not linked returns 409.
6. **Hostile:**
   - wrong csrf returns 403;
   - `imessage_link` with `invite.member` returns 403;
   - `invites` with `imessage.link` returns 403;
   - an extra `owner` field returns 400;
   - a stale revision returns 409.
7. **Failure.** `issue` throws, so the status is 503 `unconfirmed` and the message does not contain "invite". `issue` returning null gives 409 `rejected`.

**Workerd end-to-end tests.** `packages/runtime/test/imessage-shared.test.ts` (the iMessage suite). Extend `consoleFor` (`:52`) with `controls(view)` (GET `OWNER_CONTROLS_PATH?view=`) and `ownerAct(fields)` (POST to `OWNER_CONTROLS_ACTION_PATH` with cookie, csrf, revision and request_id).
1. **Golden: "Connections links iMessage end to end".**
   - Before `sharedLive()` (`:89`), Alice's read has `offer:false`.
   - After it, the read has `offer:true` and address `waldo@fixture.invalid`, and `bridgeStub().linkReady()` is true.
   - `imessage.link` returns `link`. The host sends `link.text` from `ALICE`, then `pump()` and `deliverNext()` produce `LINK_REPLIES.redeemed`.
   - The read then has `linked_hint === ALICE.slice(-4)`.
   - `proof.turns` is empty.
   - No response body contains `host.bridgeId`, `host.accountId` or the operator's `do_name`.
2. **Offline.** After `vi.useFakeTimers({toFake:['Date']})` and `setSystemTime(t0+91_000)` (the pattern in `imessage-e2e.test.ts`), the read has `offer:false` and `linkReady()` is false. `imessage.link` returns 409 and `fx.linkCodes` size is unchanged.
3. **Unlink.** After linking, unlink returns 200. The read then has `linked_hint:null` and Alice's presence is inactive.
4. **Cross-owner.** While Alice is linked, Bob's read has `linked_hint:null` and Bob's unlink returns 409. Alice stays linked.
5. **Connector off.** `iMessageLinkPort({...env, IMESSAGE_CONNECTOR_ENABLED:'0'} as never).state(alice)` returns the off state, and `fx.calls` gains no `presence_hint` and no `imessage_shared_bridge`.
6. **Directory down.** With `fx.setUnavailable(true)`, the read is 503 with no internals in the body.

**pgTAP.** The six assertions in change 3.

**SPA tests.** `packages/dashboard-app/src/IMessage.test.tsx`. Use SSR for the pure view; add `// @vitest-environment happy-dom` for the flows, following the `App.live.test.tsx` pattern.
1. `readIMessageLink` accepts the valid shape and drops extra fields. It rejects a bad revision, `offer:true` with a null address, and a 5-character hint.
2. `readIMessageResult` rejects a code containing `I`, a text mismatch, `send_url` `javascript:…`, a link on a duplicate, and a link on unlink.
3. **SSR `IMessageBody`.**
   - The ready, code, linked and offline-linked states show the exact `COPY` strings.
   - The `Open Messages` href starts with `sms:`.
   - A hostile address `<script>` is escaped.
   - The text content (tags stripped) contains no `!`, "dashboard", "Get started", "Learn more", "Oops", "Loading…" or "seamless".
4. **Golden flow.** Click "Get my code". The POST form has `view=imessage_link`, `action=imessage.link`, csrf, revision and request_id. The code is shown and focus is on "Open Messages". Advance 4 s; the read returns hint `7731` and "Linked." is announced. Advance another 8 s; no more GETs are made.
5. **Hidden.** `offer:false` with no hint renders an empty container. A read 503 renders an empty container.
6. **Expiry.** Advance 600 s with no link; the expired copy appears and polling stops.
7. **Failure.**
   - A POST that throws shows the unconfirmed copy, and "Get a new code" stays enabled.
   - A 409 without a receipt shows the changed copy and triggers a re-read.
   - A 401 during a poll shows the sign-in line.
   - With `visibilityState: 'hidden'`, ticks make no GETs.
8. **Setup.** `SetupControls` (happy-dom): a visible read shows "Connect iMessage" with `href="#/connections"`; a hidden read shows no item. Update `Panels.test.tsx:102-107`.

### Acceptance trace

The trace runs after the freeze lifts, with S0 done. Claims are labelled.

1. [SOURCE/CI] All tests above pass at the PR head. `guard-surface-neutral-core` stays at 58 for `owner-do.ts`, and `guard-migration-fixture-sync` passes.
2. [STAGING] Operator, on `/console/imessage`: the shared number shows "shared Waldo number · active · online · text verified".
3. [STAGING] A tester signed in to staging opens `#/connections`. The Chat group shows **iMessage · Not linked** above Telegram.
4. [STAGING] The tester opens the row and taps "Get my code". The page shows `waldo XXXXXXXXXX`, `woof@heywaldo.in` and "Open Messages".
5. [LIVE] With the console open on the iPhone in Safari, tapping "Open Messages" opens Messages to `woof@heywaldo.in` with the text filled in. If it does not, record that and use "Copy the text".
6. [LIVE] After sending, the iPhone receives "Linked. Texts from this number now go to your own Waldo."
7. [STAGING] Within about 8 s, without a reload, the row shows **Linked** and "ending in" plus the last 4 characters.
8. [LIVE] Texting "hello" gets Waldo's reply.
9. [STAGING] Unlink, then confirm. The row returns to Not linked.
10. [LIVE] The next text gets the stranger onboarding reply, or nothing if this sender already had one in the last 30 days.
11. [STAGING] The operator pauses the Mac host for more than 90 s. A not-linked tester reloads Connections: no iMessage row, and no Setup item. A linked tester sees the offline line.
12. [STAGING] If S3 has merged, the same card states appear in `#/welcome` at the Connect step.

Production behaviour (no row, no RPC) is [SOURCE/CI] only, through runtime test 5.

**Screenshots (local preview):**

```
cd packages/dashboard-app
npx -y pnpm@10.34.4 build
node scripts/preview.mjs --case=imessage --port=4178
```

Open `http://localhost:4178/console/dashboard/#/connections` at 1440x900 and 390x844 and capture:
- `connections-imessage-ready-{desktop,phone}.png`
- `-code-` and `-linked-` captures (a click, then wait 8 s)

Repeat with `--case=imessage-linked` and `--case=imessage-off` (expect no row).

### Verification commands

Run from the repo root at the PR head and record PASS / FAIL / NOT RUN / UNAVAILABLE.

```
git diff --check
(cd packages/runtime && npx vitest run test/dashboard-owner-controls.test.ts)
npx -y pnpm@10.34.4 --filter @waldo/runtime test:imessage            # workerd; baseline imessage-shared 9/9 PASS at a643bcab
npx -y pnpm@10.34.4 --filter @waldo/runtime test:scenarios           # proves app-api.ts still loads in plain Node
npx -y pnpm@10.34.4 --filter @waldo/runtime exec vitest run test/app-api.test.ts
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app test               # not in CI: record as locally run
npx -y pnpm@10.34.4 --filter @waldo/dashboard-app build && npx -y pnpm@10.34.4 --filter @waldo/dashboard-app verify:assets
npx -y pnpm@10.34.4 -r typecheck
node scripts/verify-supabase-migrations.mjs && node scripts/guards/guard-migration-fixture-sync.mjs
node scripts/guards/guard-surface-neutral-core.mjs && node scripts/guards/guard-health-leak.mjs
bash scripts/pgtap/run-local.sh                                      # bootstraps PG15 from PGDG; UNAVAILABLE if the download is blocked
WALDO_DO_MIGRATION_BASE_REF=HEAD^1 npx -y pnpm@10.34.4 verify:guards
npx -y pnpm@10.34.4 verify                                           # verify:supabase needs Docker: UNAVAILABLE in the cloud container
```

The baselines were observed at a643bcab with a clean tree:
- `imessage-shared.test.ts`: 9 passed;
- `dashboard-owner-controls.test.ts`: 11 passed;
- dashboard-app `OwnerControls.test.tsx` and `Controls.test.tsx`: 15 passed.

### Rollback

- **Code.** Revert the PR. SPA and Worker roll back together, because the SPA is served by the Worker. A newer SPA against an older Worker gets 400 `invalid_query` for `view=imessage_link`, so the row stays hidden.
- **Migration.** Leave `waldo.imessage_shared_bridge` in place. It is read-only and signed, and with no caller it does nothing. Never delete an applied migration file. If removal is required, ship a forward migration that drops the function, plus a list update.
- **#1257 entry points.** Reverting restores the Setup and footer links to `/console/imessage`.

### Risks and open questions

1. **Freeze.** Default: land after the showcase. Ansh can add it to the demo.
2. **Shared host not live on staging.** The setup doc (13 Oct) says the host is fixtures-only; its live state is unverified. Then S6 is correct but invisible. Default: hidden is the intended outcome; S0 checks it first.
3. **`sms:` with an email address and `body=` is not verified on device by this doc.** #1257 asserts it works. Default: reuse it with the copy fallback always visible. If step 5 fails, change `iMessageSendUrl` once; the classic page, app and console all follow.
4. **Bearer-code shoulder-surfing** (see Security). Default: the hint plus "Not yours? Unlink it." and the S0 note.
5. **Migration ordering.** Default: a timestamp later than any migration file at merge. Re-check after rebasing.
6. **Polling load on the single shared bridge DO.** At most 15 reads a minute per linking owner, each a meta read. Default: accept. If load shows, cache readiness in the owner DO for 10 s.
7. **Follow-ups for other lanes, not in S6.**
   - The app route `link-code` offers codes with the connector off or the bridge offline (`app-api.ts:167-168`). It needs a Node-safe readiness path because `app-api.ts` must load in plain Node.
   - owner-do reads `presence_hint` on every view build even with the connector off (`owner-do.ts:3410-3415`). Gate it on `iMessageComposition` in the Mac lane.
8. **Footer link removal** (change 15). Default: remove. Keep it if Ashish asks.

### Effort

**M, 7-9 h:**
- runtime and SQL: about 3.5 h (port, owner-controls, `linkReady`, directory, migration with pgTAP, fixture, tests);
- SPA: about 3.5 h (component, CSS, Setup/footer, preview cases, tests);
- staging trace with a real iPhone: about 1 h.

**Lanes:**

| Lane | Files |
|---|---|
| SPA | `IMessage.tsx`, `Controls.tsx`, `Panels.tsx`, `App.tsx`, `style.css`, `preview.mjs` |
| Runtime, non-owner-do (Ashish reviews `imessage/**`) | `imessage/{console,directory,bridge-do,send-url}.ts`, `app-api.ts` (1 line), `dashboard-owner-controls.ts`, tests and fixture |
| `owner-do.ts` (Mac lane sequences) | 2 lines changed |
| Migrations | 1 additive function, 2 list entries, pgTAP |
