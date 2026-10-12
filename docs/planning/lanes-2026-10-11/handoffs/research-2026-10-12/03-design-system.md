# App against the design system, row by row (12 Oct 2026)

**Scope.**
- Covers rows G1–G22 and the "For the design owner (Suyash)" list in `docs/planning/lanes-2026-10-11/APP_DESIGN_SYSTEM_GAPS.md`.
- Each row is re-read against the app at `waldoco/waldo-app` `origin/main` `c2ccd5d0`.
- Read-only: nothing was edited, built, run, rendered, published or commented.

**Pins and sources:**
- **App:** `origin/main` `c2ccd5d0`, fetched 12 Oct.
  - Since the register's pins (`18d5d0c3`, `36194585`) it adds:
    - #74, static waits instead of spinners;
    - #75, the names Home, Body and Waldo;
    - #76, light only with Dark shown as "Coming soon";
    - #77, approvals and parts re-pinned from backend `21a70277`, adding `defer`.
  - No open app PR touches these rows. The open ones are #16, #27 and #29, all from 10 Oct.
- **Design-system source:** waldo-brain #35, head `f9068c84`. It is **still open, with no review decision** (checked with `gh` on 12 Oct).
- **Artifact** `7wKJuF255GspDEBR643qNS`: read with the Artifact tool at version `1791742177-7dce`.
  - Prose sections 01–19 are byte-identical to #35.
  - `README.md` differs only by the artifact's generated "Consuming this system" appendix.
  - `tokens.json` differs from #35 in one value only. Its `type.fonts` names `fonts/mottle-unified.ttf`, where #35 names `fonts/Mottle.woff2`.
  - The app's pinned `design/tokens.json` has the artifact's sha256 (`eb5c27e6…`), so the app's colour values are current.
- **Backend:** `beta-mvp` `4bb040f5`, used for contract and runtime checks.
- **React Native:**
  - The app pins `react-native` 0.81.5 and Expo ~54, with `newArchEnabled: true` (`app.json:9`).
  - The app clone's local `node_modules` holds react-native 0.76.0, so it does not match the lockfile. `[inference]` That working tree may not be at `origin/main`; either way, L4 should reinstall before a Simulator run.
  - The RN claims below come from the `v0.81.5` tag on GitHub.

**Labels:**
- `[verified]`: I read the file at the pinned SHA. It never means the screen renders or a test passes.
- `[verified upstream]`: read in React Native's v0.81.5 source.
- `[inference]`: reasoned, not read.
- "No importer found": a `git grep` over `app/` and `src/` with tests excluded found no importer. expo-router routes are file-based, so I checked route reachability through `router.push` calls instead.

**Golden path steps (S1–S6):**
- **S1:** sign-in with an invite and the 18+ checkbox.
- **S2:** Google connect.
- **S3:** health consent, ingest and scores.
- **S4:** a Main chat answer.
- **S5:** approve, "Not now" and "Don't do this".
- **S6:** a reminder firing.

## Counts (one primary status per row)

| Status | Rows |
|---|---|
| Closed | None fully closed |
| Partial | 8: G1, G3, G6, G7, G9, G10, G20, G22 |
| Open | 13: G4, G5, G8, G11, G12, G13, G14, G15, G16, G17, G18, G19, G21 |
| Needs Suyash | 1: G2. The owner holds the names: keep "Patrol" and "Spots". |
| Closed by owner ruling | No G row. Outside the rows, the register's "Still open: Apple sign-in" is closed by the owner's ruling (11 Oct, 21:25Z): no Apple sign-in for the beta (X1 below). |

How the 13 open rows split:
- **App only, doable now:** G4, G5, G19 and G21.
- **App part doable now, but the full fix also needs a dependency or an asset:** G17 and G18.
- **Backend first:** G8, G11, G12, G13, G14, G15 and G16.

## Corrections to the register

1. **G2:** the retired names in `MenuPane.tsx`, `backendHome.ts` and `FloatingTabBar` are not rendered.
   - None of them has an importer. `backendHome.ts` is reached only through `useHomeData`, which has none.
   - "Fetch" appears in no live UI.
2. **G3:** the three-place bar shows only on Body and pushed screens.
   - Home renders `NativeScreen dock={false}` (`home.tsx:14`).
   - The Waldo screen (`ChatPane`) has no dock.
3. **G4:** the chat header's blue selection never renders, because no `GlassButtonGroup` item passes `selected` (`ChatPane.tsx:294-300`). The live misuse of blue and green is elsewhere (see the row).
4. **G6:** the contrast theme is class (a), not (d).
   - RN 0.81.5 has `AccessibilityInfo.isDarkerSystemColorsEnabled()` and a `darkerSystemColorsChanged` event `[verified upstream]`.
   - `src/theme/generated/semantic.ts:156-233` already holds the contrast values.
5. **G7:** the Settings half of the owner's ruling is already met (`ScheduleSettings.tsx:91-96`). Only how times are formatted is open.
6. **G17:** class (d) if it uses network status, because `package.json` has neither `@react-native-community/netinfo` nor `expo-network`. A banner driven by transport failures would be (a).
7. **G22:** `muted` now maps to `text-tertiary` (#72), and a test enforces 4.5:1. The remaining failures are elsewhere (see the row).
8. **G8:** the backend contract on `beta-mvp` now has an optional `created_at` on history rows (`packages/contracts/src/app/core.ts:48-55`).
   - The runtime does not emit it: `packages/runtime/src/channels/app-api.ts:191-206` builds rows without it.
   - `telegram-owner-do.ts:673` returns that page unchanged.

## Rows

Each row gives:
- the requirement, with its design-system reference;
- the app at `c2ccd5d0`;
- the status;
- the smallest fix and the files it touches;
- whether it needs backend work;
- whether it is on the golden path.

### G1. Tokens come from `tokens.json`

**Requirement:**
- "`tokens.json` is the single source … nobody types a hex code into product code" (`15-platforms.md:3`).
- The app copies `exports/` from a pinned commit (`15-platforms.md:21`).

**App at `c2ccd5d0` [verified]:**
- **Generated colours:** #72 generates `src/theme/generated/semantic.ts` from the pinned `design/tokens.json` with `tooling/generate-theme.cjs`, colours only.
  - `src/theme/__tests__/generatedTheme.test.ts:15-31` fails on drift, and fails when secondary text drops under 4.5:1.
- **Only five roles take generated values:** paper, card, ink, muted and inset (`tokens.ts:11-17`).
- **Eleven colours are still hand-kept** (`tokens.ts:14,16,18-26`): `inkSoft`, `line`, `glass`, `select` (#2F6FED), `accent` (#FB943F), `recovery`, `weight`, `meeting`, `meal`, `now` and `white`.
- **Tailwind:** `tailwind.config.js:11-26` exposes only the legacy names.
  - Radius (`:45-53`, 8/12/16/20/24/28), fonts (`:27-40`) and motion are hand-kept.
  - No type style comes from the tokens.
- **Hex literals remain in live code,** for example:
  - `ChatPane.tsx:453` (`#BDBDBD`);
  - `NativeScaffold.tsx:169-172`;
  - `LiquidGlass.tsx:46,58`;
  - `connect-healthkit.tsx:68` (`#1A1A1A`).

**Status: partial.** The last step waits on #35 merging, and governance asks for Suyash's review first.

**Smallest fix:**
- Tonight, nothing beyond the per-row fixes. The drift test bridges until #35 merges.
- After #35 merges:
  - copy `exports/theme.ts` and `exports/tailwind.preset.cjs` from a pinned `main` SHA with a script;
  - point `tailwind.config.js` at the preset;
  - set the CSS variables in `ThemeProvider.tsx` as `15-platforms.md:25-42` shows;
  - retire `tooling/generate-theme.cjs`, then the legacy names, screen by screen.
- Files: `tailwind.config.js`, `src/theme/ThemeProvider.tsx`, `src/theme/tokens.ts`, `tooling/`, `design/`.

**Gotcha:** `ThemeProvider.tsx:45-51` (`hexToRgb`) assumes `#RRGGBB`. An rgba token such as `border-hairline` passed through it becomes NaN.

**Backend work:** no. **Golden path:** indirectly, every screen.

### G2. Retired names never appear

**Requirement:** "Patrol, Fetch and Spot are retired names and never appear in a link" (`09-voice-and-content.md:63`).

**App at `c2ccd5d0` [verified]:**
- **Rendered:**
  - Home's "The Patrol" and "The Spots" cards, with "Show all Patrol entries" and "Show recent Spots" (`TodaySummary.tsx:92-97`);
  - the route header titles (`app/(app)/_layout.tsx:45-46`);
  - the drawer rows "Spots" and "The Patrol" (`sideMenuItems.ts:21-22`), drawn by `SideMenu` from `_layout.tsx:51`;
  - the "from Patrol" and "from Spot" chips on local threads (`chats.tsx:22-23`). `[inference]` No live screen creates threads with those context types.
- **Not rendered:**
  - `MenuPane.tsx:42,44` (no importer found);
  - `backendHome.ts:116-119` (reached only through `useHomeData`, which has no importer);
  - `LiquidGlass.tsx:277` (`FloatingTabBar`, no importer found);
  - the titles in `featureAvailability.ts`, because `UnavailableFeature.tsx:7-8` draws only the headline and the detail.
- "Fetch" appears in no live UI.

**Status: needs Suyash.**
- The owner kept "Patrol" and "Spots", and the system is not edited until Suyash resolves the conflict.
- "Spots" also collides with the system's Spot, the one orange action per screen (`01-color.md:32`, `README.md:27`).

**Smallest fix:**
- Tonight, none.
- If Suyash renames them: `TodaySummary.tsx:92-97`, `_layout.tsx:45-46`, `sideMenuItems.ts:21-22`, `chats.tsx:22-23`, and the route files `patrol.tsx` and `spots.tsx`.

**Backend work:** no. **Golden path:** no, though the cards are visible on Home after sign-in.

### G3. Three places on the native tab bar

**Requirement:**
- Three tabs: Home, Body and Waldo.
- Icons keep their signature colours, and unselected ones drop to `opacity-inactive`.
- The only badge is a Spot dot on Home, with no counts (`components/TabBar/README.md:5-11`).
- "Use the native tab bar" (`15-platforms.md:66`).

**App at `c2ccd5d0` [verified]:**
- #75 labels the dock buttons "Home", "Body" and "Waldo" (`GlassTabBar.tsx:52-75`), plus "Open menu" (`:45-51`). The owner keeps the side menu for now.
- **Home has no dock:** it renders `NativeScreen dock={false}` with its own hamburger and "Waldo" title (`home.tsx:14-19`).
- **The Waldo screen has no dock:** its header has a house button instead (`ChatPane.tsx:286-300`).
- So the bar shows only on Body and pushed screens (`NativeScaffold.tsx:29`), and `GlassDock.tsx:12-16` never marks Home active.
- **Icons:**
  - The names are only accessibility labels; no text label shows.
  - Inactive glyphs are tinted grey with `colors.muted` (`GlassTabBar.tsx:117,119`). That breaks "inactive icons drop to `opacity-inactive`, never grey" (`README.md:36`).
  - The glyphs are `house` and `waveform.path.ecg`, not the filled symbols the system names.
- There is no Spot dot, and the bar is a custom glass bar, not the native one.

**Status: partial.** The names are done.

**Smallest fix:**
- Render the bar on Home and Waldo: change `home.tsx:14`, and add a dock to `ChatPane.tsx` (or move to a shared tab layout).
- Mark Home active in `GlassDock.tsx:12-16`.
- In `GlassTabBar.tsx`:
  - show labels in `micro`;
  - colour icons from `semanticColors.light['icon-blue' | 'icon-red' | 'icon-teal']`, with unselected icons at `opacity-inactive`;
  - add a Spot dot on Home while an approval waits.
- The native tab bar (expo-router's native tabs) means restructuring the routes. Do it later `[inference: needs a Simulator check on SDK 54]`.

**Backend work:** no. **Golden path:** indirectly; it is how you move between every step.

### G4. Selection is ink; blue only for a Switch's on track and a radio or checkbox mark

**Requirement:**
- `README.md:33` reserves blue for a Switch's on track and a radio or checkbox mark.
- `01-color.md:28` defines `accent`, and `:118` says "Don't use green for 'on'".
- `text-link` is `text-primary` with an underline (`01-color.md`, the text-link row).

**App at `c2ccd5d0` [verified]:**
- **The register's locus never renders:** `GlassButtonGroup` paints blue only when `item.selected` is true (`LiquidGlass.tsx:104-120`), and `ChatPane.tsx:294-300` never passes `selected`.
- **Live misuse:**
  1. The Health agreements `Switch` has no `trackColor` (`HealthConsent.tsx:29`), so iOS draws its default green on track `[inference: the RN iOS default]`.
  2. Links in Waldo's replies are `colors.select` blue (`ChatPane.tsx:468`). The underline is at `MarkdownText.tsx:25`.
  3. Inactive tab icons are grey (see G3).
  4. `select` is #2F6FED, not `accent` #007aff (`tokens.ts:19`). It colours the radio and checkbox marks in `OptionList.tsx:115-122`, which only the onboarding question screens render.

**Status: open.**

**Smallest fix:**
- `HealthConsent.tsx:29`: add `trackColor={{ true: <accent #007aff>, false: <bg-pressed> }}`.
- `ChatPane.tsx:468`: give links `colors.ink`.
- `tokens.ts:19`: set `select: light['accent']`.
- Make the selected fill in `LiquidGlass` ink before any caller passes `selected`.

**Backend work:** no. **Golden path:** yes; the Switch is on S3 and the links on S4.

### G5. Colour only for Spot, state, Form zones and icon identity; data in ink

**Requirement:**
- `README.md:8` and `README.md:32`.
- FormGauge colours only the active zone segment and the zone word, and the numeral is ink.
- Home uses the `sm` gauge, with no arc (`components/FormGauge/README.md:47-52`).

**App at `c2ccd5d0` [verified]:**
- **Home's "Body" card rings** (`TodaySummary.tsx:79`, `tokens.ts:20-22`):
  - Form is the legacy orange `accent` #FB943F, which reads as Spot;
  - Recovery is green #7CB342;
  - Weight is pink #E14B8A.
  - The arcs reach 2.17:1, 2.44:1 and 3.67:1 on the card.
- `ScoreRing.tsx:20` sweeps again on every score change and ignores Reduce Motion. FormGauge draws once per mount, and shows complete under Reduce Motion.
- Body (`HealthScores.tsx:41-53`) draws scores as ink text, which complies.

**Status: open.** The app part is doable now. The Recovery and Weight gauges wait on Suyash, as the owner decided.

**Smallest fix:**
- `TodaySummary.tsx:79`:
  - Recovery and Weight in ink (`viz-ink`);
  - Form in the mark colour of its zone (`zone-*-mark`, from the zone the server sent), or ink when there is no zone;
  - the track in `gauge-track`.
- `ScoreRing.tsx`: sweep once per mount, and skip the sweep under `useReducedMotion` (`chat/motion.tsx:12`).

**Backend work:** no; the server sends the zone. **Golden path:** yes, S3, visible on Home.

### G6. Light ships; Dark "Coming soon"; a contrast theme

**Requirement:** `README.md:19`, `18-settings.md:14`, `14-accessibility.md:38` and `15-platforms.md:44`.

**App at `c2ccd5d0` [verified]:**
- `useResolvedThemeScheme()` always returns `'light'` (`theme.store.ts:22-26`), tested in `lightOnly.test.ts`.
- Settings shows "Light · Selected" and "Dark · Coming soon" (`settings.tsx:17-20`).
- There is no contrast theme: `palettes` has only light and dark (`tokens.ts:9-46`), although `semantic.ts:156-233` holds the contrast values.

**Status: partial.** Dark is done.

**Smallest fix:**
- Add a `contrast` palette in `tokens.ts` from `semanticColors.contrast`; the legacy keys reuse light.
- Return `'contrast'` from `theme.store.ts` while `AccessibilityInfo.isDarkerSystemColorsEnabled()` is true, and listen for `darkerSystemColorsChanged`.
  - The API exists in RN 0.81.5 `[verified upstream]`. How it behaves on iOS is `[inference]` until a Simulator run.
- `ThemeProvider.tsx` then picks the palette up. Extend `lightOnly.test.ts`.

**Backend work:** no. **Golden path:** no.

### G7. Times in the person's zone; a zone the owner set wins

**Requirement:**
- `09-voice-and-content.md:74`.
- The owner's ruling (11 Oct): a zone the owner set wins over the phone's, with a one-tap "Use this device's time zone" row.
- The system text still says device zone and no override (`19-internationalisation.md:28,66`, `17-account-and-identity.md:68`). That is a Suyash item.

**App at `c2ccd5d0` [verified]:**
- **Settings meets the ruling.** It shows the stored zone, and when the phone's zone differs it offers "Use this device's time zone" as one tap (`ScheduleSettings.tsx:91-96`, `controlsController.ts:29-33`).
- The app never writes the zone by itself.
- **Displayed times use the device zone,** through `toLocaleString()`:
  - approval change times and expiry (`approvalsView.ts:26,60`);
  - score freshness (`scoresView.ts:45`);
  - "Last sent" (`HealthConsent.tsx:16`);
  - connections (`connectionsView.ts:23`).

**Status: partial.**

**Smallest fix:**
- Add one helper, `formatInstant(value, zone)`, built on `Intl.DateTimeFormat(undefined, { timeZone, dateStyle, timeStyle })`.
  - Feed it `controls.day?.data.timezone`.
  - Name the zone when it differs from the device's.
  - While the day view isn't loaded, fall back to the device zone and name it.
- Files: `approvalsView.ts:26,60`, `ApprovalsList.tsx:51,53`, `ApprovalCard.tsx:53-54`, `scoresView.ts:43-48`, `HealthConsent.tsx:16`.
- `[inference]` Hermes honours `timeZone` when formatting. The app already builds an `Intl.DateTimeFormat` with `timeZone` (`controlsController.ts:8`); confirm with a unit test.

**Backend work:** no; the day view carries the zone. **Golden path:** yes; approval times on S5 and score freshness on S3.

### G8. Waldo's turn shows the mark, "Waldo" and the time

**Requirement:** `components/Message/README.md:6`.

**App at `c2ccd5d0` [verified]:**
- Waldo's turn shows `MascotMark` in its thinking pose.
- The visible attribution is the channel string ("app", "telegram" or "local"); "Waldo" appears only in the accessibility label (`ChatPane.tsx:462-467`).
- There is no time, because the pinned row schema has none (`src/agent/contracts/backend-999/core.ts:47-50`).
- History is read tolerantly (`app-routes-v1.ts:29`), so a field the backend adds is dropped rather than breaking the page.

**Backend at `4bb040f5` [verified]:**
- The contract has an optional `created_at` (`packages/contracts/src/app/core.ts:48-55`).
- The runtime builds rows without it (`packages/runtime/src/channels/app-api.ts:191-206`) and returns them unchanged (`telegram-owner-do.ts:673`).
- The app has not pinned the C1 `core.ts`, as its contracts README says.

**Status: open.** The time needs backend work.

**Smallest fix:**
- Now, app only: show "Waldo" in place of the bare channel (`ChatPane.tsx:467`).
- After L2 emits `created_at` and staging serves it:
  - pin the C1 `core.ts`;
  - show the time in the `data` style through the G7 helper;
  - show no time on rows that have none.

**Backend work:** yes; L2 emits the field and L1 deploys. **Golden path:** yes, S4.

### G9. The working state is one specific line, never dots

**Requirement:** `components/Message/README.md:8` and `11-states.md:13`.

**App at `c2ccd5d0` [verified]:**
- A static line with no dots (`ChatPane.tsx:486-503`):
  - "Waldo has your message.";
  - "Waldo is working.";
  - after 30 seconds, "Still working. This one is taking longer than usual."

**Status: partial.** "No animation" is met. The line is generic; it doesn't say what Waldo is doing.

**Smallest fix:** none in the app until a source of steps exists. Then show the current step.

**Backend work:** yes; the steps route (L2 W4, L3). **Golden path:** yes, S4.

### G10. Approval card anatomy, with two ways out

**Requirement:**
- `components/NeedsYouCard/README.md:5-11,31` and `10-agency-and-approval.md:42`.
- `components/CardActions/README.md:10-15`:
  - Edit and Not now lead, as quiet buttons;
  - the effect trails;
  - "Don't do this" sits under the unit.

**App at `c2ccd5d0` [verified]:**
- **Contract:**
  - `defer` ("Not now") now sits beside `skip` ("Don't do this", which is final) (`parts.ts:19-21`, `approvals.ts:17-19`). The app labels them that way (`approvalsView.ts:18`).
  - The item still carries one `review` string, with no why-now, if-you-approve, if-you-don't or based-on fields (`approvals.ts:51-55`).
- **What is visible tonight:** staging `726ad0e7` predates the pin, and the backend offers `defer` nowhere until its desk records deferrals (`src/agent/contracts/README.md`, the "Approvals defer" section). So only the relabel shows.
- **Layout:** both surfaces draw every offered decision in one wrapping row, in the server's order (approve, edit, skip, defer). Approve leads in ink, and "Don't do this" sits beside it (`ApprovalsList.tsx:54-58`, `ApprovalCard.tsx:55-59`).
- **Effect labels** are per kind ("Make the change", "Send it"; `approvalsView.ts:13-15`), not the exact effect.
- **State words:**
  - "Waiting for you" is an orange `Pill` (`ApprovalsList.tsx:48`, `NativeScaffold.tsx:169`). Orange belongs to Spot, and StateBadge's "Waiting" is neutral (`components/StateBadge/README.md:11`).
  - "Done" (`approvalsView.ts:10`) collapses states the badge rule keeps apart (`StateBadge/README.md:17`). L3 needs to say whether `done` means confirmed.

**Status: partial.**

**Smallest fix (app only):**
- Add one `actionLayout(actions)` in `approvalsView.ts` that returns the leading decisions (edit, defer), the primary (approve) and the refusal (skip).
- The server sends a different set per state (`approvals.ts:17-19`), so the layout must not assume a primary:
  - `open` sends approve, edit, skip and defer;
  - `review_only` sends only skip and defer, with no primary;
  - `done` sends only undo, which belongs to the receipt (G11).
- On both cards:
  - quiet buttons lead;
  - the ink primary trails;
  - "Don't do this" sits under the row as a quiet text button;
  - the state Pill is neutral.
- Files: `approvalsView.ts`, `ApprovalsList.tsx:48,54-58`, `ApprovalCard.tsx:55-59`.
- Tests: `ApprovalsList.test.tsx`, `ApprovalCard.test.tsx`, `approvalsView.test.ts`.

**Backend work:**
- Yes for the structured fields, which need a new version or a sequence rule (L3).
- Yes for offering `defer`, which needs the desk.
- No for the layout.

**Golden path:** yes, S5.

### G11. Receipts carry the change, why, what was checked, and Undo with its window

**Requirement:** `components/ReceiptCard/README.md:5-13` and `10-agency-and-approval.md:52-57`.

**App at `c2ccd5d0` [verified]:**
- A done approval shows:
  - the kind title;
  - a green "Done" Pill;
  - the review text and detail lines;
  - an "Undo" button when the server offers one (`ApprovalsList.tsx:44-58`; `approvals.ts:18`, `done: ['undo']`).
- It has no window, no evidence and no past-tense title, because the item carries none of them (`approvals.ts:51-58`).

**Status: open.**

**Smallest fix:**
- After L3 adds an undo-until time and evidence, draw a ReceiptCard:
  - a past-tense title;
  - the reason and the evidence;
  - the window ("Until 10:30") beside a trailing Undo.
- App only, now: move Undo to the trailing end.

**Backend work:** yes. **Golden path:** next to S5.

### G12. Threads list

**Requirement:** `components/ThreadRow/README.md:8-30`.

**App at `c2ccd5d0` [verified]:**
- Local drafts only (`chats.tsx`).
- An all-caps "Recent" header (`chats.tsx:96`).
- Delete goes through `Alert.alert`, with no consequence copy (`chats.tsx:46-55`).

**Backend at `4bb040f5` [verified]:**
- The C1 `threads.ts` contract exists, with title, preview and `last_activity_at`.
- I found no `/app/v1/threads` route in the runtime.

**Status: open.**

**Smallest fix:**
- After the routes ship, pin `threads.ts` and draw a ThreadRow with the server's title, preview and time.
- Use the ConfirmSheet copy from ThreadRow's table for delete.

**Backend work:** yes. **Golden path:** no.

### G13. Push

**Requirement:** `13-notifications-and-channels.md:7-22,40-45`:
- a reminder the person set may push (`:13`);
- at most three pushes a day (`:19`);
- no badges (`:22`);
- provisional authorisation (`:41`).

**App at `c2ccd5d0` [verified]:** `expo-notifications` ~0.32.17 is in `package.json:30` and never imported.

**Backend at `4bb040f5` [verified]:**
- The `devices.ts` contract exists, with `/app/v1/devices`, register and revoke.
- The runtime has no device route.
- The delivery gate has an APNs policy (`delivery-gate/gate.ts:98-176`).
- The app contracts have no reminder route.
- ADR-0068 ("owner-set reminders may push") merged in waldo-brain #36 (11 Oct, 21:30Z).

**Status: open.**

**Smallest fix:**
- After the routes ship, register the APNs token after the first value, with provisional authorisation, behind a PermissionPrePrompt.
  - Use `expo-notifications` and a new `src/agent/pushRegistration.ts`.
- Revoke the token on sign-out.

**Backend work:** yes. **Golden path:** yes, S6. It cannot close tonight.

### G14. Quick replies as ChoiceChips

**Requirement:** `components/ChoiceChips/README.md`.

**App at `c2ccd5d0` [verified]:** `quick_replies` parts parse (the pinned `core.ts:41-46`), but only text and approval parts render (`transcriptAdapter.ts:4-20`, `ChatPane.tsx:468-470`).

**Backend at `4bb040f5` [verified]:** nothing in the runtime produces a `type: 'quick_replies'` part.

**Status: open.**

**Smallest fix:** once a producer exists, a ChoiceChips row under the reply. A tap sends the chip's label as the person's message.

**Backend work:** yes. **Golden path:** no.

### G15. Research answers list their sources ("No source, no claim")

**Requirement:** `components/Message/README.md:12` and `components/SourceCard/README.md`.

**App at `c2ccd5d0` [verified]:** the pinned parts (`parts.ts`) have no source part, and there is no SourceCard.

**Status: open.**

**Backend work:** yes. **Golden path:** no, unless the S4 question is a research question.

### G16. Memory shown as MemoryClaim, with correct and forget

**Requirement:** `components/MemoryClaim/README.md` and `18-settings.md:13`.

**App at `c2ccd5d0` [verified]:**
- The `spots` route says "Memory is unavailable" and `constellations` says "Graph is unavailable" (`featureAvailability.ts:2`).
- `ConstellationPanel` has no importer.
- The pinned controls contract has a read-only `constellation` view (contracts README). Staging doesn't serve it yet.

**Status: open.**

**Backend work:** yes; forget and correct routes. **Golden path:** no.

### G17. Offline is shown as a Banner

**Requirement:** `11-states.md:16` and `components/Banner/README.md`.

**App at `c2ccd5d0` [verified]:** no network status module and no offline banner.

**Status: open.**

**Smallest fix:**
- **(a), with no dependency:**
  - mark the app offline when the transport fails with no answer (the app already tells that case apart, `schedule.ts:66-73`);
  - show a neutral Banner, with the time of the last read, on Home and Waldo.
- **(d), detection before a request fails:** needs `@react-native-community/netinfo` or `expo-network`. That is a dependency change and needs the owner's go.

**Backend work:** no. **Golden path:** no.

### G18. Mottle for display, SF Pro Rounded from the system, DM Mono for command lines

**Requirement:**
- `README.md:20`, `02-typography.md:15` and `15-platforms.md:46`.
- Governance decision 33: the app bundles six static instances (`16-governance.md:57`).
- The owner's ruling: on iOS, take SF Pro Rounded from the system.

**App at `c2ccd5d0` [verified]:**
- Four bundled SF Pro Rounded OTFs in `assets/fonts/`, loaded with `useFonts` (`app/_layout.tsx:22-28`).
- Every family alias points at them (`tokens.ts:55-68`, `tailwind.config.js:27-40`).
- No Mottle and no DM Mono.

**Upstream [verified]:**
- In RN 0.81.5, the new architecture maps `fontFamily: 'ui-rounded'` to the system's rounded design (`RCTFontUtils.mm:289-310`).
- The old architecture's `RCTFont.mm` has no such mapping.
- The app runs the new architecture (`app.json:9`).

**Asset gap [verified]:**
- #35's `fonts/` holds only woff2 web subsets.
- The artifact has `fonts/mottle-unified.ttf`, declared as weight "400 900", so it is variable.
- No static Mottle instance exists for the app.

**Status: open.**

**Smallest fix:**
- On iOS, set the family to `ui-rounded` with weights 400, 500 and 600, through `Platform.select` in `tokens.ts:55-68` and `tailwind.config.js:27-40`.
- Drop the iOS `useFonts` load, and keep it for Android. The licence outside Apple platforms is still open (`16-governance.md:82`).
- Mottle and DM Mono wait for static TTF instances (an asset task) and a licence check.

**Backend work:** no. **Golden path:** no; it is visible everywhere, but it is polish.

### G19. Display styles cap Dynamic Type at 1.3×

**Requirement:** `02-typography.md:56` and `15-platforms.md:50`.

**App at `c2ccd5d0` [verified]:** no `maxFontSizeMultiplier` anywhere.

**Status: open.**

**Smallest fix:**
- Add `maxFontSizeMultiplier={1.3}` to the display-role text that exists:
  - Home's title (`home.tsx:19`);
  - the HomeCard titles (`HomeCard.tsx:14`);
  - the sign-in title (`agent-sign-in.tsx:39`).
- Native large titles follow iOS.

**Backend work:** no. **Golden path:** no.

### G20. Copy and states: no generic waits, no spinner, no banned words

**Requirement:**
- `09-voice-and-content.md:49`, `README.md:35`, `11-states.md:12` and `components/ProcessingCard/README.md:15`.
- Sentence case everywhere, and no typed arrows (`02-typography.md:48-49`).

**App at `c2ccd5d0` [verified]:**
- **Mostly fixed by #74:**
  - It replaced the spinners and "Loading…" text on 11 agent screens with `StatusLine` (`ui/StatusLine.tsx`), guarded by `noSpinners.test.ts:6-17`.
  - Live copy has no "Loading", "Oops", "Thinking…", "Are you sure", OK, Yes, Approve or exclamation marks. The only "OK" is in `MetricLevelChart.tsx:12`, which has no importer.
- **Spinners remain on two live Body screens,** reached from `HealthStats.tsx:16-17` and missing from the test list:
  - `wearable.tsx:59,89`;
  - `connect-healthkit.tsx:68`.
- **Spinners also remain where nothing reaches them:** `connect-watch.tsx` (no in-app link found), `DayZones.tsx` and `EmptyDataCard.tsx` (no importer).
- **All-caps headers on every scaffold screen:** `NativeScaffold.tsx:44,68` (`uppercase tracking-wide`), and `chats.tsx:96`.
- **Typed arrows:**
  - "Latest ↓" (`ChatPane.tsx:243`);
  - "before → after" in task change lines (`approvalsView.ts:52-55`).

**Status: partial.** Mostly closed by #74.

**Smallest fix:**
- Replace the spinners in `wearable.tsx` and `connect-healthkit.tsx` with StatusLine lines, and add both files to `noSpinners.test.ts`.
- Drop `uppercase tracking-wide` at `NativeScaffold.tsx:44,68` and `chats.tsx:96`.
- Show "Latest" with the chevron icon.

**Backend work:** no. **Golden path:** yes; Apple Health access is on S3, and the headers sit on the S2, S3 and S5 screens.

### G21. The composer's counter matches what send accepts

**Requirement:** the register's row. No single design-system line covers it; the closest are Composer's send rules (`components/Composer/README.md:15`).

**App at `c2ccd5d0` [verified]:**
- The counter and `maxLength` are 4,000 characters (`ChatPane.tsx:532-546`).
- The client refuses a body over 8,192 bytes (`appRoutesClient.ts:130`).
- The pinned contract allows 32,768 bytes (`core.ts:8,64`), and it pins `appSendWireFits` (`core.ts:9-16`).

**Status: open.**

**Smallest fix:**
- In `appRoutesClient.ts:130`, use `!appSendWireFits({ client_message_id, text })`.
- After that the counter can't overflow the byte cap: the worst case is 4,000 UTF-16 units × 6 bytes (escaped control characters or lone surrogates), about 24,060 bytes with the envelope, under 32,768.
- Test in `appRoutesClient.test.ts`: a 4,000-character Devanagari message (about 12 KB) fails today and passes after.

**Backend work:** no. **Golden path:** yes, an edge case of S4 (long Hindi text).

### G22. Text holds 4.5:1 contrast

**Requirement:** `14-accessibility.md:7` and `README.md:30`.

**App at `c2ccd5d0` [verified]:**
- **Fixed and enforced by a test:** `muted` is now `text-tertiary` (#6b6b66). It reaches 4.90:1 on paper, 5.22:1 on card and 4.53:1 on inset.
- **Remaining failures:**
  - The channel label on the person's bubble is `#BDBDBD` on `bg-inset`: 1.59:1 (`ChatPane.tsx:453`).
  - Control outlines use `line` (#E9E8E4), which reaches 1.19:1 on card. Control borders need 3:1 (`14-accessibility.md:7`); `border-control` (#85857f) reaches 3.61:1. The outlines are in the button styles at:
    - `ApprovalsList.tsx:11`;
    - `ConnectionsList.tsx:11`;
    - `HealthConsent.tsx:11`;
    - `ScheduleSettings.tsx:9`;
    - `TodaySummary.tsx:15`;
    - `HomeCard.tsx:17`;
    - `ApprovalCard.tsx:30`.
  - The Home rings (see G5).
- `inkSoft` reaches 3.72:1, but only an orphan uses it.

**Status: partial.**

**Smallest fix:**
- `ChatPane.tsx:453`: use `colors.muted`, or drop the channel line from the person's bubble.
- Add a hex `control` colour (`border-control`) to the `tokens.ts` palettes, the `ThemeProvider.tsx` variables and `tailwind.config.js`, and use it for outlines.

**Backend work:** no. **Golden path:** yes; the bubble is on S4, and the outlines are on S2, S3 and S5.

## Outside G1–G22, on the golden path

### X1. Apple sign-in

**Status: closed by owner ruling** (11 Oct, 21:25Z): no Apple sign-in for the beta. This was the register's "Still open" item.
- `17-account-and-identity.md:7` and `components/AuthButton/README.md` still put Apple first. Flag it to Suyash; don't edit.
- `[inference, unchecked]` App Store guideline 4.8 probably requires an equivalent privacy-preserving login once Google sign-in ships.

### X2. The 18+ checkbox at sign-in

**Requirement:** owner answer 8, and `17-account-and-identity.md:9`.

**App at `c2ccd5d0` [verified]:**
- `agent-sign-in.tsx` has email, invite and code, with no 18+ item and no terms line.
- The only 18+ control is a `Switch` on Health agreements (`HealthConsent.tsx:93`).
- The consent grant needs that attestation on every grant (`age_attested_18_plus: true`, pinned `health-ingest.ts:38`).
- `appCodeRequestSchema` has no age field, so tonight the sign-in check can only be a gate in the app.

**Status: open.**

**Smallest fix:**
- Add a `Checkbox` component (`src/components/ui/Checkbox.tsx`): an `accent` box with a "Required" caption.
- Put it on `agent-sign-in.tsx`. Until it is ticked, "Email me a code" stays disabled with the reason "Waldo is for adults. Confirm you're 18 or over."
- Change `HealthConsent.tsx:93-94` from a Switch to a Checkbox, keeping the attestation on every grant.
- Question for L3: does ADR-0073 need the sign-in attestation recorded on the server?

**Golden path:** S1.

### X3. The Telegram row in Connections

**App at `c2ccd5d0` [verified]:** `ConnectionsList.tsx:69` shows a Telegram row with its status.

**Rule:** decision 52 says Telegram is never offered to people (`13-notifications-and-channels.md:63`). The row shows status; it doesn't offer a link.

**Owner's call:** keep it for testers, or show it only in staging builds (`talksToStaging()`).

**Golden path:** it sits on the S2 screen.

### Reminder firing (S6)

It can't close tonight:
- The app has no push code.
- The backend at `4bb040f5` has no device route and no app reminder route.
- Whether a fired reminder appears in Main chat is a backend question `[unverified]`.

## For the design owner (Suyash), updated

**The register's items, as they stand now:**

| Item | Status now |
|---|---|
| G2, retired names | Still open. The owner holds the names. |
| G5, Recovery and Weight gauges | Still open. |
| The morning notification | Still open. It is the owner's call. |
| Time zones | Still open. `19-internationalisation.md:28,66` and `17-account-and-identity.md:68` still say device zone and no override, while the app already does what the owner ruled (`ScheduleSettings.tsx:91-96`). |
| Session-delete copy | Open. |
| "Pinned by Waldo" chips | Open. There is no component for them. |
| Not now and Don't do this on chat cards | The contract landed (#1070), and `NeedsYouCard` already specifies both (`onDefer`, `onDeny`). Nothing is needed from Suyash beyond review. |
| Decision 53 | Open. |
| Review of #35 | Open, with no review decision. It blocks G1's last step. |

**New from this pass:**
- `17-account-and-identity.md:7` and AuthButton put Apple first. That conflicts with the ruling of no Apple sign-in for the beta.
- `01-color.md`'s Form-zone table disagrees with `tokens.json`. `tokens.json` is the stated source (`15-platforms.md:3`), so the table is stale. For example:
  - Steady is `#B45309` with tint `#FEF3C7` in the table; `zone-steady` resolves to `{amber-800}` #92400e with tint #f8efe2.
  - The table's Energized tint is #D1FAE5; `zone-energized-bg` is #e3f2ec.
- `15-platforms.md:17,25` give `#1A1A1A` and `#fafaf8` as examples; the tokens resolve to `#151514` and `#f5f5f2`.
- `15-platforms.md:44` asks whether React Native covers Increase Contrast. RN 0.81.5 does, through `isDarkerSystemColorsEnabled`.
- **Mottle for the app:**
  - Decision 33 wants static instances.
  - #35 has only a woff2 web subset, and the artifact has only a variable TTF.
  - #35 and the artifact also name different Mottle files.
- `14-accessibility.md` still names DM Sans for Bold Text. L4's audit also found this.

## Tonight's fix list for the app lane, in order

Order by golden-path step first, then app only, small, and visible on the owner's run.

| # | Fix | Golden path | Files |
|---|---|---|---|
| 1 | **X2:** 18+ Checkbox at sign-in; the consent 18+ item becomes a Checkbox | S1, S3 | `app/(auth)/agent-sign-in.tsx`; new `src/components/ui/Checkbox.tsx`; `src/components/health/HealthConsent.tsx:25-32,93-94`. Tests: `agentSignIn.test.tsx`, `HealthConsent.test.tsx`. |
| 2 | **G10:** action layout (quiet buttons lead, ink effect trails, "Don't do this" under the row) and a neutral state pill | S5 | `src/components/approvals/approvalsView.ts`, `ApprovalsList.tsx:48,54-58`, `src/components/chat/ApprovalCard.tsx:55-59`. |
| 3 | **Chat and consent polish:** G4 (`accent` track on the Switch, ink links), G22 (the `#BDBDBD` label), G8 ("Waldo" attribution) and G20 ("Latest ↓") | S3, S4 | `HealthConsent.tsx:29`; `src/components/chat/ChatPane.tsx:243,453,467,468`; `src/theme/tokens.ts:19`. |
| 4 | **G5:** Home rings in ink, Form in its zone mark, and a sweep once per mount | S3 | `src/components/home/TodaySummary.tsx:79`, `src/components/home/ScoreRing.tsx:20-26`. |
| 5 | **G20, the rest:** spinners on Apple Health access and readings, and sentence-case headers | S3, and every scaffold screen | `app/(app)/wearable.tsx:59,89`, `app/(onboarding)/connect-healthkit.tsx:68`, `src/components/ui/__tests__/noSpinners.test.ts:6-10`, `src/components/prototype/NativeScaffold.tsx:44,68`, `app/(app)/chats.tsx:96`. |
| 6 | **G7:** owner-zone time helper | S5, S3 | `approvalsView.ts:26,60`, `ApprovalsList.tsx:51,53`, `ApprovalCard.tsx:53-54`, `src/components/health/scoresView.ts:43-48`, `HealthConsent.tsx:16`. |
| 7 | **G21:** send cap from `appSendWireFits` | S4 | `src/agent/appRoutesClient.ts:130`; test in `src/agent/__tests__/appRoutesClient.test.ts`. |
| 8 | **G3:** bar on Home and Waldo, Home marked active, text labels, signature colours, Spot dot | Navigation between all steps | `app/(app)/home.tsx:14`, `ChatPane.tsx` header, `src/components/ui/GlassDock.tsx:12-16`, `src/components/ui/GlassTabBar.tsx`. |

**After those:**
- G22 control outlines: `tokens.ts`, `ThemeProvider.tsx`, `tailwind.config.js` and the button styles.
- G6 contrast theme.
- G18 `ui-rounded` on iOS.
- G19 caps.
- G17 banner driven by transport failures.
- G1, once #35 merges.

Each fix still needs:
- the owner's go in L4's session;
- `pnpm run check` and `pnpm test`;
- Simulator evidence, labelled separately from device evidence.

## Evidence, inference, unverified

**Observed:**
- `git show` and `git grep` on `waldo-app` `origin/main` `c2ccd5d0`, `waldo-brain` `origin/design-system/owner-rulings-20261011` `f9068c84`, and `waldo-backend` `origin/beta-mvp` `4bb040f5`.
- Artifact reads (list, and read with paths) at `1791742177-7dce`, with byte diffs against #35.
- `gh` for the states of waldo-brain #35 and #36, and for the open and merged app PRs.
- React Native `v0.81.5` source through `gh api`: `AccessibilityInfo.js` and `RCTFontUtils.mm`.
- WCAG contrast computed from the hex values with a local script.

**Inference:**
- The iOS `Switch` defaults to a green track.
- Hermes formats with `timeZone`.
- `ui-rounded` renders on a device.
- App Store guideline 4.8 applies.
- No live screen creates threads with the Patrol or Spot context types.

**Unverified:**
- No build, test, Simulator or device run.
- Staging was not called. I don't know whether it serves C1, `defer` or the `constellation` view; the contracts README says staging predates them.
- A route built dynamically in the backend runtime would escape my grep. I found no threads, devices or reminder route.
