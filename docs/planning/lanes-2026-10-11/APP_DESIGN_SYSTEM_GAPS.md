# App against the design system, 11 October 2026

**What this is.** It lists where the iPhone app does not yet follow the owner's Waldo design system, and what unblocks each gap.
- On 11 Oct the owner made the design system the app's UI contract: decision 7 in [APP_CHAT_PLAN.md](APP_CHAT_PLAN.md).
- This register is a planning document. Every app change, merge and dependency change still needs the owner's go in L4's session, the app's writer.

**Pins:**
- Design system: https://claude.ai/artifact/7wKJuF255GspDEBR643qNS, version `1791721337-e9e9`. The plan's design-system section says how to read it.
- App: `waldo-app` `main` `18d5d0c3`. It includes #69 (the chat follows the design system: a static working line, the inset user bubble, the composer placeholder) and #68.
- Backend contracts: `beta-mvp` `15134581`. Staging serves the same commit.

**Method:**
- Rows marked `[verified]` I read at those pins, including mechanical greps over `src/` and `app/` that leave out tests and pinned contracts.
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
- The export pipeline the system describes (`tooling/build.mjs` writing `exports/`) is not in the artifact. Where it lives is unknown. Class (c), then (d).

**Proposed:**
- If the pipeline does not exist, L4 adds a small script to the app repo that reads a pinned copy of `tokens.json` and writes `theme.ts` and a NativeWind preset, as `15-platforms.md` lays out. It needs no new dependency.
- The palette then moves to semantic names, screen by screen.
- Everything visual below gets cheaper once this lands. So it goes first, and the owner should say so explicitly.

## Gaps by class

| # | Rule (design-system source) | App at `18d5d0c3` [verified] | Class | Severity | Lane |
|---|---|---|---|---|---|
| G1 | Tokens come from `tokens.json` (`15-platforms.md`) | A hand-kept palette (above) | (c) then (d), then (a) | Blocks every visual row | Owner, L4 |
| G2 | Retired names never appear: "Patrol, Fetch and Spot are retired names" (`09-voice-and-content.md`) | The tab bar's third tab is "Patrol" (`LiquidGlass.tsx:277`). Home shows "The Patrol" and "The Spots" (`PatrolCompact.tsx:19,42`; `SpotsCompact.tsx:24`; `TodaySummary.tsx:91-92`). Labels read "Fetch", "Patrol", "Fetch candidate" and "Fetch suppressed" (`backendHome.ts:116-119`, `surfaceContracts.ts:105-106`). Routes `patrol.tsx` and `spots.tsx`. | (a) once decision 7 holds. L4 asked the owner about naming. | Visible | L4 |
| G3 | Three places: Home, Body, Waldo, on the native tab bar (`TabBar`, `15-platforms.md`) | A custom glass tab bar: Brief, Health, Patrol. Chat is a separate route reached from the "Ask Waldo" dock. | (c): the structure change needs the owner's confirmation | Visible | Owner, L4 |
| G4 | Selection is ink; blue (`accent`) is only a Switch's on track and a radio or checkbox mark (README, "The rules agents break most") | Tabs and nav items select in blue `select` with a blue tint (`LiquidGlass.tsx:78-120`, `GlassTabBar.tsx:108`) | (a) | Polish | L4 |
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
| G16 | Memory shown as `MemoryClaim`, with correct and forget | "Memory is unavailable". No app.v1 memory routes, and no `update_memory` handler. | (b) | Visible | L3, L2, L4 |
| G17 | Offline is shown as a `Banner`: "You're offline. Showing what Waldo knew at 07:14." | No network awareness | (a) | Visible | L4 |
| G18 | Display type in Mottle; interface in SF Pro Rounded; DM Mono only for command lines (README) | SF Pro Rounded is bundled in 4 weights. No Mottle file. | (d): the Mottle file is in the artifact (`fonts/mottle-unified.ttf`); check its licence (`16-governance.md`) | Polish | L4 |
| G19 | Display styles cap Dynamic Type at 1.3×; others are uncapped (`15-platforms.md`) | No `maxFontSizeMultiplier` anywhere | (a), once display styles exist | Polish | L4 |
| G20 | Copy: no "Loading…", "Oops", "Thinking…", "Are you sure?", OK/Yes/Approve buttons or exclamation marks (`09`) | None found by grep | Follows | Done | n/a |
| G21 | Long messages: the composer's counter matches what send accepts | The counter allows 4,000 characters, but the app caps the body at 8,192 bytes (`appRoutesClient.ts:130`). The server allows 32,768. | (a) | Visible for non-Latin text | L4 |
| G22 | Text holds 4.5:1 contrast on its grounds in every theme (README; `craft.md`) | Light `muted` `#8A8A8E` reaches 3.12:1 on `paper` and 3.44:1 on `card`, and it is a text colour in 191 places. `inkSoft` (ink at 55%) reaches 3.73:1. The system's `text-tertiary` reaches 4.90:1 on `bg-canvas`. Dark `muted` passes, at 6.37:1. | (a); G1 fixes it everywhere | Accessibility, visible | L4 |

## Questions for the owner

1. **Token pipeline.** Where does the system's `tooling/build.mjs` live? If it doesn't exist, may L4 generate `theme.ts` and the preset from a pinned `tokens.json` (G1)?
2. **Tabs.** Home, Body, Waldo, with chat as the Waldo tab, replacing Brief, Health, Patrol (G3)?
3. **Three scores.** Do the Recovery and Weight gauges keep their own colours, or follow the system's rule that colour means a zone or a state (G5)?
4. **Dark mode at launch.** Hide it as "Coming soon", as the system says, even though it works (G6)?
5. **Reminders.** May a reminder the owner set send a push (G13)?
6. **Approvals.** Is "Don't do this" (deny) its own action, or part of `skip` (G10)?
</content>
</invoke>
