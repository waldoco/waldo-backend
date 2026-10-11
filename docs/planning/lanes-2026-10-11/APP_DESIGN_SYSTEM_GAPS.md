# App against the design system, 11 October 2026

**What this is.** It lists where the iPhone app does not yet follow the owner's Waldo design system, and what unblocks each gap.
- On 11 Oct the owner made the design system the app's UI contract: decision 7 in [APP_CHAT_PLAN.md](APP_CHAT_PLAN.md).
- This register is a planning document. Every app change, merge and dependency change still needs the owner's go in L4's session, the app's writer.

**Pins:**
- Design system: https://claude.ai/artifact/7wKJuF255GspDEBR643qNS, version `1791721337-e9e9`. The plan's design-system section says how to read it.
- App: `waldo-app` `main` `18d5d0c3`. It includes #69 (the chat follows the design system: a static working line, the inset user bubble, the composer placeholder) and #68.
- Backend contracts: `beta-mvp` `15134581`. L1 reports staging serves the same commit; I have not checked it.

**Method:**
- I read each row at those pins, including mechanical greps over `src/` and `app/` that leave out tests and pinned contracts. The exception is a cell marked `[inventory]`: a reading agent reported it at app `9937d456`, and I did not re-check it at `18d5d0c3`.
- L4 is running its own per-screen audit of every screen and route, and will put the report in the app repo under `Docs/audits/`. This register covers cross-cutting gaps and sorts each one by what unblocks it. Reconcile the two when L4's report lands.

**Classes:**
- **(a)** App only, doable now in L4's queue.
- **(b)** Needs backend data or a contract change.
- **(c)** Needs an owner or design-system decision.
- **(d)** Needs a dependency, a native module or an asset. Each is a dependency change reviewed in the app lane.

## The root gap: tokens are hand-copied

**[verified]**
- The design system says `tokens.json` is the single source and "nobody types a hex code into product code" (`15-platforms.md`). The app pins a design-system commit and copies a generated `exports/` (`theme.ts`, `tailwind.preset.cjs`) in a PR that names that commit.
- The app instead hand-keeps its own palette:
  - `src/theme/tokens.ts` says it is a "TS mirror of the Tailwind palette … keep in sync with `tailwind.config.js`".
  - `tailwind.config.js` uses `nativewind/preset`.
  - None of the system's semantic names appear in `src/` or `app/` (`bg-canvas`, `text-secondary`, `border-hairline`, `spot`).
  - #69 added one value by hand, `inset: '#EFEFEC'`, with a comment that names the system's `bg-inset`. The system's `bg-inset` resolves to `#ecece9`, so the copy has already drifted.
- The light palettes side by side, with the system's aliases resolved from `tokens.json`:

  | Role | App (`src/theme/tokens.ts`) | System token | System value |
  |---|---|---|---|
  | Screen background | `paper` `#F5F4F0` | `bg-canvas` | `#f5f5f2` |
  | Card | `card` `#FFFFFF` | `bg-surface` | `#fcfcfa` |
  | Field and user bubble | `inset` `#EFEFEC` | `bg-inset` | `#ecece9` |
  | Text | `ink` `#1C1C1E` | `text-primary` | `#151514` |
  | Faint text | `muted` `#8A8A8E` | `text-tertiary` | `#6b6b66` |
  | Orange | `accent` `#FB943F` | `spot` | `#f97316` |
  | Blue | `select` `#2F6FED` | `accent` | `#007aff` |
- **The pipeline exists, outside the artifact.** waldo-brain branch `claude/dreamy-archimedes-1meouj`, 42 commits ahead of waldo-brain `main` and unmerged, holds `01-Waldo/design/design-system/` with:
  - `tokens.json` and `tooling/build.mjs`;
  - the generated `exports/`: `theme.ts` ("Generated from tokens.json by tooling/build.mjs. Do not edit."), `tailwind.preset.cjs`, `tokens.css`, `tokens.dtcg.json` and `contrast-report.json`;
  - `fonts/`, with `Mottle.woff2`, DM Mono, SF Pro Rounded and `OFL.txt`.
  - The artifact looks published from it: its version note and the branch's last commit both name the v0.3 founder review.
- **Consequence:** an edit made only in the artifact, such as the 11 Oct Telegram line in section 13, is undone by the next publish from that branch unless it is mirrored there.

**Proposed:**
- The owner names that waldo-brain branch, once merged, as the design system's source. L4 then copies its `exports/` from a pinned commit in a PR that names the commit, as `15-platforms.md` lays out. Nothing new needs building.
- The palette then moves to semantic names, screen by screen.
- Everything visual below gets cheaper once this lands. So it goes first, and the owner should say so explicitly.

## Gaps by class

| # | Rule (design-system source) | App at `18d5d0c3` | Class | Severity | Lane |
|---|---|---|---|---|---|
| G1 | Tokens come from `tokens.json` (`15-platforms.md`) | A hand-kept palette (above). The exports exist on an unmerged waldo-brain branch. | (c): merge and name the source; then (a): copy `exports/` | Blocks every visual row | Owner, L4 |
| G2 | Retired names never appear: "Patrol, Fetch and Spot are retired names" (`09-voice-and-content.md`) | Home renders a "The Patrol" card with "Show all Patrol entries", which opens the `patrol` route (`TodaySummary.tsx:91-92`, rendered by `home.tsx`). Kind labels "Fetch" and "Patrol" come from `backendHome.ts:116-119`, used by `useHomeData.ts`. A `spots` route exists. `PatrolCompact`, `SpotsCompact` and `FloatingTabBar` hold the names too, but nothing renders them. | (c): renaming waits for the owner's explicit yes, which L4 asked for | Visible | Owner, L4 |
| G3 | Three places: Home, Body, Waldo, on the native tab bar (`TabBar`, `15-platforms.md`) | The live dock is `GlassTabBar`, inside `GlassDock`, which the `NativeScaffold` screens render. It shows Open menu, Overview, Health Stats and Ask Waldo. The three places exist under other labels, plus a side menu the system doesn't have. It is a custom bar, not the native one. `FloatingTabBar` (Brief, Health, Patrol) is exported but never rendered. | (c): the labels and the side menu | Visible | Owner, L4 |
| G4 | Selection is ink; blue (`accent`) is only a Switch's on track and a radio or checkbox mark (README, "The rules agents break most") | The dock already marks the active place in ink (`GlassTabBar.tsx:119`). The chat header's switcher uses `GlassButtonGroup` (`ChatPane.tsx:294`), which selects in blue `select` with a blue tint (`LiquidGlass.tsx:78-120`). | (a) | Polish | L4 |
| G5 | Colour only for Spot, state, Form zones and icon identity; data in ink (`viz-ink`) (README principle 2) | The Recovery gauge is green and the Weight gauge pink (`tokens.ts`: `recovery`, `weight`). The system specifies `FormGauge` by zone, and no Recovery or Weight gauge. | (c): the three-score product decision against the system's colour rule | Visible | Owner, Suyash |
| G6 | Light ships; Dark is "Coming soon" at launch; a `contrast` theme serves Increase Contrast (README) | A working light/dark/auto override that is not saved (`theme.store.ts`). No contrast theme. | Dark: (c). Contrast: (d), a native module or an `AccessibilityInfo` check. | Visible | Owner, L4 |
| G7 | Times show in the person's time zone (`09`); the owner-set zone wins (ruling, 11 Oct) | Approval times use the device zone, through `toLocaleString()` (`approvalsView.ts:23,57`) | (a) | Visible | L4 |
| G8 | Waldo's turn shows the mark, "Waldo" and the time (`Message`) | Unboxed with the mark (matches). No time, because history rows carry none. | (b): stored `created_at` (L2 W2), exposed by L3's C1 contract | Visible | L2, L3, L4 |
| G9 | The working state is one specific line, never dots (`Message`, `11-states.md`) | #69 made the line static and removed the dots. The line still says only what the receipt phase says. | (b) for real steps: L3's steps route, L2 W4 | Done for now | L2, L3 |
| G10 | Approval card: why now, if you approve, if you don't, based on, and an effect-named button; two ways out, Not now and Don't do this (`NeedsYouCard`, `10-agency-and-approval.md`) | The contract carries one `review` text, `exact`, `expires_at` and actions `approve`, `skip`, `edit`, `undo` (`contracts/src/app/approvals.ts`, `parts.ts:20-21`). The app parses each approval item strictly, so new fields there are not additive. | (b) and (c): structured fields need a sequence rule or a new version (L3), and deny against `skip` needs a decision | Visible | L3, L4 |
| G11 | Receipts carry the change, why, what was checked, and Undo with its window (`ReceiptCard`) | Undo exists for calendar changes only, within 10 minutes (backend `approvals.ts:31`). There is no structured "checked" evidence on the item. | (b) | Visible | L2, L3 |
| G12 | Threads: a topic title, the last line as written, the time, an unread dot, "Waldo added …" (`ThreadRow`) | Local drafts only. #998's list has no preview or unread state. | (b): sent to L3 for the C1 subset | Blocks sessions | L3, L2, L4 |
| G13 | Push: at most three a day, collapsed per object, no Brief, no health values, no badges, provisional authorisation after the first value (`13-notifications-and-channels.md`) | `expo-notifications` is installed and never imported. There is no sender. | (b): L2 W2 (S7). (d) is the wiring. Whether a reminder the owner set may push: (c). | Blocks proactive | L2, L4, owner |
| G14 | Quick replies as `ChoiceChips`: answers written as the person would say them; chips ask and never act | No producer; the app draws no `quick_replies` part | (b), with the plan's fallback rule first | Visible | L2, L4 |
| G15 | Research answers list their sources: "No source, no claim" (`Message`, `SourceCard`) | No provenance comes from the backend | (b): the steps and sources route | Visible | L2, L3, L4 |
| G16 | Memory shown as `MemoryClaim`, with correct and forget | The backend has no app.v1 memory routes and no `update_memory` handler. The app shows a memory placeholder `[inventory]`. | (b) | Visible | L3, L2, L4 |
| G17 | Offline is shown as a `Banner`: "You're offline. Showing what Waldo knew at 07:14." | No network awareness | (a) | Visible | L4 |
| G18 | Display type in Mottle; interface in SF Pro Rounded; DM Mono only for command lines (README) | SF Pro Rounded is bundled in 4 weights. No Mottle file. | (d): the Mottle file is in the artifact (`fonts/mottle-unified.ttf`); check its licence (`16-governance.md`) | Polish | L4 |
| G19 | Display styles cap Dynamic Type at 1.3×; others are uncapped (`15-platforms.md`) | No `maxFontSizeMultiplier` anywhere | (a), once display styles exist | Polish | L4 |
| G20 | Copy and states: no "Loading…" or other generic waits; a specific line instead (`11-states.md`). No spinner (`ProcessingCard`). No "Oops", "Thinking…", "Are you sure?", OK/Yes/Approve buttons or exclamation marks (`09`). | L4's audit found what my first grep missed: 15 files render `ActivityIndicator`. Home shows "Loading approvals", "Loading cards" and "Loading scores" (`TodaySummary.tsx:59,70,88`), and chat "Loading earlier…" (`ChatPane.tsx:219`). #69 replaced "Loading main chat…". No "Oops", OK/Yes/Approve or exclamation marks were found. | (a) | Visible | L4 |
| G21 | Long messages: the composer's counter matches what send accepts | The counter allows 4,000 characters, but the app caps the body at 8,192 bytes (`appRoutesClient.ts:130`). The server allows 32,768. | (a) | Visible for non-Latin text | L4 |
| G22 | Text holds 4.5:1 contrast on its grounds in every theme (README; `craft.md`) | Light `muted` `#8A8A8E` reaches 3.12:1 on `paper` and 3.44:1 on `card`. `colors.muted` and `text-muted` appear 191 times; that raw count includes icon tints. `inkSoft` (ink at 55%) reaches 3.73:1. The system's `text-tertiary` reaches 4.90:1 on `bg-canvas`. Dark `muted` passes, at 6.37:1. | (a): an interim copy of `text-tertiary`'s value is a quick fix, which G1 then replaces | Accessibility, visible | L4 |

## Reconciled with L4's audit

L4's own audit is `Docs/audits/APP-design-system-gap-audit-2026-10-11.md` in waldo-app PR #70, not merged. L4 reports:
- **Agreed:** G2 to G6, G8 to G16, and G18. Its colour section now uses this register's `tokens.json` values; its first draft used a stale card.
- **Found only by this register:** G7, G19, G21 and G22. L4 will check them as it builds.
- **Found only by L4** `[L4 audit, not re-checked here]`:
  - 18 legacy components nothing renders;
  - 15 onboarding stubs, plus `connect-watch`;
  - `Alert.alert` where the system uses `ConfirmSheet`;
  - account deletion as a one-step typed DELETE;
  - the 18+ item as a `Switch` where the system uses a `Checkbox`;
  - no session-ended screen;
  - a website-promise matrix with a 24-item backend ask list. L4 waits for the owner's go before posting it on #116.
- **In flight:** waldo-app #71 corrects #69's `inset` to `#ecece9` (dark `#1c1c1b`).
- **Blocking the device run:** `GET /app/v1/chat/main` returned 503 on staging release `81c4f892` for the owner's account. L4 retries against `15134581`. The handler's bare `catch` hides the cause (`telegram-owner-do.ts:644-651`); a lead went to L2.

## Questions for the owner

1. **Design-system source.** Merge the waldo-brain design-system branch and name it the source, so L4 copies its `exports/` (G1)? The Telegram fix in the artifact needs mirroring there too.
2. **Tabs.** Should the dock read Home, Body, Waldo instead of Overview, Health Stats, Ask Waldo? Does the side menu stay (G3)?
3. **Three scores.** Do the Recovery and Weight gauges keep their own colours, or follow the system's rule that colour means a zone or a state (G5)?
4. **Dark mode at launch.** Hide it as "Coming soon", as the system says, even though it works (G6)?
5. **Reminders.** May a reminder the owner set send a push (G13)?
6. **Approvals.** Is "Don't do this" (deny) its own action, or part of `skip` (G10)?
7. **Retired names.** Rename "The Patrol", the "Fetch" and "Patrol" labels, and the `spots` route, as the system says (G2)? L4 is waiting for this answer, and proposes names from the system's Home order.
8. **The morning Brief.** The website promises a 6:30 notification; the system says the Brief never pushes. Flagged by the audit lane.
9. **From L4:**
   - Does an automatic time-zone write at sign-in count as the owner setting the zone?
   - Does sign-in need both Apple and Google, and where does the 18+ check sit?
   - The SF Pro Rounded licence, which `16-governance.md` lists as open.
</content>
</invoke>
