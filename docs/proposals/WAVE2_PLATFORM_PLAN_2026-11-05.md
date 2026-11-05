# Wave 2 platform plan: Android AppFunctions, iOS App Intents, widget, Live Activity, device signals (5 November 2026)

Status: **plan, not built.** Base: `beta-mvp` `60496b8b`. The design for device signals is the companion ADR draft, [`ADR_DRAFT_DEVICE_CONTEXT_2026-11-05.md`](ADR_DRAFT_DEVICE_CONTEXT_2026-11-05.md).

Every platform fact below was read from a primary page on 5 Nov 2026 and carries its link. Anything not confirmed on such a page is marked **[unverified]**; a conclusion is marked **[inference]**. Two research passes read the pages. I re-checked the three AppFunctions claims that decide the Android plan (Gemini status, the permission, the library version) on the pages myself.

## The short answer

| Surface | Possible today | Not possible today |
|---|---|---|
| **iOS Siri** | App Shortcut phrases ("Ask Waldo…", "What's my plan in Waldo"), Spotlight, Shortcuts and the Action button, on iOS 16+ | Waldo's own actions in the new Siri AI from an App Store build: custom actions are a developer preview. Siri AI has no health domain and is not in the EU at first |
| **iOS widget** | Home and Lock Screen widgets, with buttons that run an App Intent (iOS 17+) | — |
| **iOS Live Activity** | Up to 8 h active plus 4 h on the Lock Screen; push-to-start (iOS 17.2+); 4 KB of data | A published per-hour update budget. Content that stays off Apple's push service |
| **Android AppFunctions** | Waldo can declare functions on Android 16 (API 36) with `androidx.appfunctions` 1.0.0-rc01, and test them with `adb` | **Gemini calling them.** That is a private preview with trusted testers, and signing up for early access does not grant it. Other third-party apps can't call them either |
| **Screen time** | Android, through Usage access (built: #1863, #234) | **iOS off the device.** Apple's report extension cannot make network requests. The only exception is EU-only, iOS 26.4+, one app per device |
| **Coarse place** | Both platforms in the foreground. Android coarse is about 3 km²; iOS approximate is 1–20 km and "typically preserves the city" | Geofences or region monitoring with coarse or approximate location, on either platform |
| **Weather** | A server-side provider for both platforms (WeatherKit REST has forecast and UV, 500k calls a month included) | Air quality from WeatherKit (it has none) |

## Android

### AppFunctions

- **Platform.** `android.app.appfunctions`; `EXECUTE_APP_FUNCTIONS` was "Added in API level 36". The overview says it is available on "Android 16 or higher" and is labelled Experimental. ([Manifest.permission](https://developer.android.com/reference/android/Manifest.permission), [AppFunctions overview](https://developer.android.com/ai/appfunctions))
- **Library.** Jetpack `androidx.appfunctions` is at **1.0.0-rc01** (4 Nov 2026), after 1.0.0-beta01 (21 Oct). There is no stable release. ([release notes](https://developer.android.com/jetpack/androidx/releases/appfunctions))
- **Who can call.**
  - `EXECUTE_APP_FUNCTIONS` has "Protection level: normal".
  - The same reference says "allowlist checks for AppFunctions API access are enforced at runtime".
  - The overview says "only a limited number of apps and system agents can access the entire pipeline".
  - `BIND_APP_FUNCTION_SERVICE` is signature-only, so only the system binds to an app's function service.
  - So in practice an ordinary third-party app cannot call Waldo's functions, and Waldo cannot call other apps' functions **[inference]**.
- **Gemini.** "As of May 2026, AppFunctions integration with Gemini is in a private preview with trusted testers." The Early Access Program sign-up "does NOT automatically" grant access. ([overview](https://developer.android.com/ai/appfunctions)) A February post names partner integrations, such as Samsung Gallery on the Galaxy S26 series and Calendar, Notes and Tasks apps with "a small set of app developers" ([blog, Feb 2026](https://android-developers.googleblog.com/2026/02/the-intelligent-os-making-ai-agents.html)).
- **How Waldo declares functions:**
  - a KSP-processed `AppFunctionService` subclass marked `@AppFunctionServiceEntryPoint`;
  - each method marked `@AppFunctionDeclaration(isDescribedByKDoc = true)` (renamed from `@AppFunction`);
  - data types marked `@AppFunctionSerializable`.
  - The OS indexes a generated schema, which `adb shell cmd app_function list-app-functions` shows. ([overview](https://developer.android.com/ai/appfunctions))
  - From Expo this needs a Kotlin native module or config plugin, and a call may arrive when the JS runtime is not running **[inference]**.
- **What this means.** Build it so Waldo is ready when Gemini opens, and apply to the Early Access Program. Until Google accepts us, no user can reach it. It is worth a slice only because it is small and the backend endpoints are shared with iOS.

### Device signals

- **Usage access (screen time).**
  - `PACKAGE_USAGE_STATS` is an app-op the user grants in Settings.
  - `queryEvents` keeps events only "a few days" and returns nothing while the device is locked on Android 11 and later. ([UsageStatsManager](https://developer.android.com/reference/android/app/usage/UsageStatsManager))
  - I found no Play declaration specific to this permission **[unverified that none exists]**. The general User Data and Data safety rules apply.
  - Play also bars the Accessibility API for apps that "autonomously" plan and act. Waldo cannot use Accessibility to drive other apps. ([Play policy](https://support.google.com/googleplay/android-developer/answer/9888170))
- **Location.**
  - Coarse is "within about 3 square kilometers"; fine is "usually within about 50 meters". ([permissions](https://developer.android.com/develop/sensors-and-location/location/permissions))
  - Passive updates reuse other apps' fixes at no battery cost and work with coarse. ([battery](https://developer.android.com/develop/sensors-and-location/location/battery/optimize))
  - Geofencing **requires fine**, plus background location from API 29. ([geofencing](https://developer.android.com/develop/sensors-and-location/location/geofencing))
  - `ACCESS_BACKGROUND_LOCATION` needs a Play declaration form, a demo video and in-app disclosure. ([Play](https://support.google.com/googleplay/android-developer/answer/9799150))
  - The Activity Transition API (walking, in a vehicle, still) needs `ACTIVITY_RECOGNITION` and no location permission **[inference from the guide]** ([transitions](https://developer.android.com/develop/sensors-and-location/location/transitions)). It is the cheapest "the owner is travelling" hint, and is not in v1.
- **Health Connect (steps).**
  - `StepsRecord.COUNT_TOTAL` aggregation avoids double counting.
  - History older than 30 days before the first grant needs `READ_HEALTH_DATA_HISTORY`; background reads need `READ_HEALTH_DATA_IN_BACKGROUND`. ([read data](https://developer.android.com/health-and-fitness/health-connect/read-data))
  - Rate limits exist and are stricter in the background; no numbers are published **[unverified]**. ([rate limiting](https://developer.android.com/health-and-fitness/health-connect/rate-limiting))
  - Steps already reach the backend through the health ingest (`get_health` signal `steps`), so Wave 2 adds no step pipeline.

## iOS

### App Intents, App Shortcuts and Siri

- **App Intents and `AppShortcutsProvider` need iOS 16.** Actions appear in Siri, Spotlight, Shortcuts, the Action button, widgets, Controls, Live Activities and Focus. ([App Intents](https://developer.apple.com/documentation/appintents))
- **Voice works today through App Shortcut phrases.** These are "spoken phrases that someone might use to run the shortcut", and they are live as soon as the app is installed. ([App Shortcuts](https://developer.apple.com/documentation/appintents/app-shortcuts))
- **Siri AI shipped on 14 Sep 2026, "in beta in English".**
  - It needs an Apple Intelligence device and does not run in the EU at first. ([Newsroom](https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/))
  - Shipping apps reach it through App Schemas (`@AppIntent(schema:)`). ([WWDC26 session 240](https://developer.apple.com/videos/play/wwdc2026/240/), [App Intents for Siri AI](https://developer.apple.com/documentation/appintents/apple-intelligence-and-siri-ai))
  - The schema domains include calendar, mail, reminders and search. **There is no health or fitness domain.** `.assistant` is "available only in Japan". ([domains](https://developer.apple.com/documentation/appintents/app-schema-domains))
  - Custom actions outside the schemas are a developer preview that does not ship in App Store builds. ([developer preview](https://developer.apple.com/documentation/appintents/siri-ai-developer-preview))
- **What this means.** Ship App Shortcuts now; they work by voice. Waldo is not a calendar or mail app, so whether to adopt the calendar or reminders schemas is a later question **[inference]**.

### Widgets and Live Activities

- **Interactive widgets.** A `Button(_:intent:)` or `Toggle(isOn:intent:)` needs iOS 17. ([Button](https://developer.apple.com/documentation/swiftui/button/init(_:intent:)))
- **ActivityKit (iOS 16.1).**
  - An activity runs up to 8 hours, then can stay on the Lock Screen up to 4 more.
  - All data, push payloads included, "can't exceed a combined size of 4 KB". ([Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities))
  - Push-to-start needs iOS 17.2. ([pushToStartTokenUpdates](https://developer.apple.com/documentation/activitykit/activity/pushtostarttokenupdates))
  - Priority-10 updates count against "a certain budget" per hour; the number is not published **[unverified]**. ([ActivityKit push](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications))

### Screen Time and location

- **Screen Time.**
  - FamilyControls individual authorization needs iOS 16, and Apple must approve the entitlement for each extension. ([entitlement](https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement))
  - The `DeviceActivityReport` sandbox "prevents your extension from making network requests". ([DeviceActivityReport](https://developer.apple.com/documentation/deviceactivity/deviceactivityreport))
  - An EU-only data-access path exists from iOS 26.4 ([approvedWithDataAccess](https://developer.apple.com/documentation/familycontrols/authorizationstatus/approvedwithdataaccess)). It doesn't fit a global beta.
  - **iOS screen time stays off the server.**
- **Location.**
  - Approximate location is "usually within 1–20 kilometers" and updates "at most a few times per hour". ([reduced accuracy](https://developer.apple.com/documentation/corelocation/kcllocationaccuracyreduced))
  - With approximate location the app "can't use region monitoring". ([accuracyAuthorization](https://developer.apple.com/documentation/corelocation/cllocationmanager/accuracyauthorization))
  - Visit monitoring works with approximate location and relaunches the app. ([visits](https://developer.apple.com/documentation/corelocation/cllocationmanager/startmonitoringvisits()))
  - How significant-change behaves with approximate location is not documented **[unverified]**.
  - Always authorization is a two-step prompt the user can refuse. ([requestAlwaysAuthorization](https://developer.apple.com/documentation/corelocation/cllocationmanager/requestalwaysauthorization()))

## Weather provider

| | WeatherKit REST | Open-Meteo | OpenWeather One Call | Google Weather |
|---|---|---|---|---|
| Free tier | 500k calls/month with the Developer Program | Non-commercial only | 1,000 calls/day | 10k events/month |
| Paid | $49.99 for 1M calls | Plans from 1M calls/month; prices **[unverified]** | Per call or tiers **[unverified]** | $0.15 per 1k, falling with volume |
| Serves Android users | Yes ("Corresponding Product") | Yes | Yes | Yes |
| UV | Yes | Yes | Yes | Yes |
| Air quality | **No** | Separate API (CAMS) | Air Pollution API | Separate API, $5 per 1k after 10k free |
| Attribution | Apple Weather mark and legal link | CC BY 4.0 credit | ODbL credit, share-alike | Google Maps credit |
| Caching | Only "temporary and limited", for performance; no derived database | Not addressed | Not addressed | Terms not fetched **[unverified]** |

Sources:
- WeatherKit: [get started](https://developer.apple.com/weatherkit/get-started/), [REST API](https://developer.apple.com/documentation/weatherkitrestapi), [Program License Agreement, Attachment 8](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/).
- Open-Meteo: [pricing](https://open-meteo.com/en/pricing), [terms](https://open-meteo.com/en/terms).
- OpenWeather: [One Call 3](https://openweathermap.org/api/one-call-3).
- Google: [pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [Weather policies](https://developers.google.com/maps/documentation/weather/policies).

**Recommendation:**
- **Forecast and UV: WeatherKit REST.** It costs nothing within the existing membership, serves Android users, and its cache rule matches the ADR's few-hour, cell-keyed cache with no history.
- **Air quality: a second, paid source.** Open-Meteo's free tier is non-commercial, and Waldo is a product. This is an owner decision.

## Which Waldo actions each surface exposes

The rule: **an assistant or widget acts as the owner, through the owner's own session, on routes that already exist.** There is one authority root. Nothing new can approve on the owner's behalf.

| Waldo action | iOS (App Intent / App Shortcut) | Android (AppFunction) | Backend route | Exists? |
|---|---|---|---|---|
| **Ask Waldo** | `AskWaldoIntent(text)`, phrase "Ask Waldo…". It sends, then shows the reply when it lands or says "Waldo's on it" and opens the chat | `askWaldo(text)` | `POST /app/v1/chat/main/messages`, then `GET /app/v1/chat/main` | **Yes** |
| **Today's plan** | `TodayIntent`, phrase "What's my plan in Waldo"; also the widget's content | `getToday()` | A compact read for surfaces: the next block, the next event, how many cards wait, and the Brief's one line | **No:** proposed `GET /app/v1/today` (additive, read-only). Today the parts are spread over `/calendar/day`, `/approvals` and the chat |
| **Approve a card** | `OpenPendingCardsIntent`. It opens the app on the card, needs the device unlocked (`authenticationPolicy`), and approval happens in the app as today | `listPendingCards()` returns titles only. Approval opens the app | `GET /app/v1/approvals`, `POST /app/v1/approvals/decisions` | **Yes** |
| **Quick log** | `QuickLogIntent(text)`, e.g. "log to Waldo: had a coffee at 4". It becomes an owner message the model reads | `quickLog(text)` | `POST /app/v1/chat/main/messages` | **Yes.** No structured log endpoint: what a log means is the model's call |

**Not proposed:** approving a card from Siri, Gemini or a widget button without opening the app. That would let an assistant approve an action without the owner seeing it. If the owner wants it, it is a separate decision under the approvals contract, with device unlock required.

### Two conflicts the owner should see

1. **Lock-screen content against the 3 Nov ruling.** The Brief push stays content-free. Widgets and Live Activities show on the Lock Screen, and a Live Activity push carries its content through Apple's push service.
   - Proposal: the widget shows content only once the device is unlocked. SwiftUI's `privacySensitive()` does this **[unverified for widgets]**.
   - The Live Activity is started by the app while it is open, and its pushes stay content-free **[inference: a content-free update may not be useful]**.
   - Otherwise the owner must allow lock-screen content explicitly.
2. **The session in an extension.** Widgets and some intents run outside the app process, so they need the owner's session through a shared keychain access group. ADR-0082's purge must cover that group on sign-out, switch and deletion. This is an app-side change to the custody adapter.

## Build slices (Wave 2)

Switch names follow the repo rule: `"0"` in production, `"1"` in staging once the gate turns them on.

| # | Slice | Owner | Depends on | Switch | Tests | Size |
|---|---|---|---|---|---|---|
| **B1** | Device-context contract, place consent and latest-place storage, app routes | backend | none (dark); the ADR review before any app ships against it | `DEVICE_PLACE` | contract valid/invalid; pgTAP; Worker route tests | M (draft PR, this lane) |
| **B2** | `get_device_context` tool: place name, time zone, age; turn-only. Offered in owner chat, the Brief and the Close, `patrol`, `intervention`, `fetch_alert` and `handoff_plan` | backend | B1 | `DEVICE_PLACE` | tool tests; permissions table; prompt snapshot; trace scrub | S |
| **B3** | Weather: a WeatherKit REST adapter (signing key as a secret), a cell-keyed cache with no owner id, and the `get_weather` tool | backend | B1; owner picks the provider; `provider_lookup` consent | `DEVICE_WEATHER` | adapter mock in CI and real provider in nightly; cache holds no owner id; tool tests | M |
| **B4** | Air quality from a second provider | backend | B3; owner decision | `DEVICE_WEATHER` | as B3 | S |
| **B5** | `GET /app/v1/today`: compact read for the widget, intents and AppFunctions | backend | none | none (read-only, additive) or `APP_TODAY` | contract and route tests | S–M |
| **B6** | Live Activity push: register push-to-start and update tokens (additive to the devices contract), an APNs `liveactivity` sender, under the proactive ledger's limits | backend | owner ruling on lock-screen content; A5 | `LIVE_ACTIVITY` | sender mock; ledger budget test | M–L |
| **A1** | Place consent screen; foreground coarse read; rounding to the cell on the phone; upload; ADR-0082 purge | app | B1 | app flag | device test on both platforms | M |
| **A2** | Android screen-time upload, follow-on to #234 | Ashish | existing `SCREEN_TIME` routes | `SCREEN_TIME` | device test | M |
| **A3** | iOS App Intents and App Shortcuts: Ask Waldo, Today, Open pending cards, Quick log | app | B5 (Today); shared keychain group | app flag | device test plus Shortcuts | M |
| **A4** | iOS widget, private on the Lock Screen | app | B5, A3 | app flag | device test | M |
| **A5** | iOS Live Activity for the day's next move | app | B6, owner ruling | app flag | device test | L |
| **A6** | Android AppFunctions on API 36+: `askWaldo`, `getToday`, `listPendingCards`, `quickLog` | app | B5; Gemini early access for real use | app flag | `adb shell cmd app_function` | M–L |
| **A7** | iOS on-device-only screen-time view | app | Apple entitlement approval | — | — | M, deferred |
| **D1** | Privacy notice and store listings: place, weather provider, screen time, AppFunctions | owner and legal | before production | — | — | S |

**Order.**
1. B1 → B2 → A1 makes place real end to end.
2. B3 adds weather.
3. B5 unblocks A3, A4 and A6 in parallel.
4. B6 and A5 wait for the lock-screen ruling.

Steps and trips need no slice: steps already flow through the health plane, and trips are the model's reading of mail, calendar and place.
