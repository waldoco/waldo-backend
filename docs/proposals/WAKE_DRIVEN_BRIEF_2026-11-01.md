# Wake-driven Brief

Status: **Proposed**. Design only, no code. The owner asked for it ("Yes, design it"). It builds on S8c-1 (#1780).

## The ask

The owner's words: when the owner wears their wearable and wakes up, "Waldo should automatically understand that now they have woken up… start creating the brief and then send those notifications when the user wakes up and starts their phone".

Today the Brief's time is planned the night before (`planToday`, nightly at 03:00 and at boot). S8c-1 re-plans it when today's calendar changes. Waking up is not used anywhere: nothing in the backend stores or emits a "woke" signal [verified at `3352cee9`; the only wake logic is `scores/energy-windows.ts:56`, inside the health-plane recompute].

## Shape in one paragraph

The phone syncs the night's sleep as soon as iOS lets it, which is usually just after the first unlock. The health plane decides from that sleep record that today's night is in, and wakes the owner object with a reason code. The code carries no time and no value. Every Brief that is still waiting then gets one model turn. The turn has a new choice, "send now", alongside "keep" and "move". The owner's planned time is still the deadline when no signal comes. "One Brief a day" stays where it is, on the Brief's own row.

## 1. App half (waldo-app, Suyash's lane)

Each claim below names Apple's documentation. Anything not confirmed on a device is marked [inference].

**Background delivery.**
- Register `HKObserverQuery` for `sleepAnalysis`, `stepCount` and `heartRate`, and call `enableBackgroundDelivery(for:frequency:)` for each ([enableBackgroundDelivery](https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)), [Executing observer queries](https://developer.apple.com/documentation/healthkit/executing-observer-queries)).
- **Entitlement.** On iOS 15 and later this needs `com.apple.developer.healthkit.background-delivery`; without it the call fails with an authorization error.
- **Register at launch.** The queries must be registered in `application(_:didFinishLaunchingWithOptions:)`, so the delivery that relaunched the app is not missed. In Expo that means a config plugin and native AppDelegate code, not JS after the bridge loads [inference].
- **Completion handler.** The app must call the observer's completion handler. After three misses, HealthKit stops background delivery ([HKObserverQueryCompletionHandler](https://developer.apple.com/documentation/healthkit/hkobserverquerycompletionhandler)).
- **On each delivery** the app runs its existing anchored read and posts to the existing `POST /app/v1/health/ingest`. Sleep already arrives there as `sleep_duration` with `start_at`/`end_at` and `sleep_context` (`waking_day`, intervals) (`packages/contracts/src/app/health-ingest.ts:104-186`). No new endpoint is needed.

**How often iOS delivers.**
- `HKUpdateFrequency` is an upper bound, not a promise ([HKUpdateFrequency](https://developer.apple.com/documentation/healthkit/hkupdatefrequency)).
- On iOS, some types are capped at hourly without warning, `stepCount` among them (same enableBackgroundDelivery page).
- Whether `sleepAnalysis` and `heartRate` are capped on iOS is **not documented** [unverified]. We ask for `.immediate` for sleep and plan as if it may be held to hourly.
- Steps and heart rate are corroboration (the owner is up and moving). Their hourly cap makes them too slow to be the trigger.

**The locked phone is the real constraint, and it helps.**
- The HealthKit store is unreadable while the phone is locked: `errorDatabaseInaccessible` ([HKError.Code](https://developer.apple.com/documentation/healthkit/hkerror/code/errordatabaseinaccessible), [Protecting user privacy](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)).
- Apple's platform security guide says the health database is "Protected Unless Open": access ends 10 minutes after lock, and records written while locked are journaled and merged on unlock ([Platform Security](https://support.apple.com/guide/security/protecting-access-to-users-health-data-sec88be9900f/web)).
- So the night's sleep is normally readable, and synced, **just after the first unlock after waking** [inference, to confirm on device]. That is the "starts their phone" moment the owner described.

**There is no "phone unlocked" signal that launches an app.**
- `applicationProtectedDataDidBecomeAvailable` and its notification only reach an app that is already running ([UIApplicationDelegate](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/applicationprotecteddatadidbecomeavailable(_:))). Unlock is not among the background-launch reasons ([Preparing your UI to run in the background](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background)).
- The real stand-ins, in order:
  1. A HealthKit background delivery that arrives just after unlock, because the store only becomes readable then.
  2. The owner opening the app, a foreground sync.
  3. A `BGAppRefreshTask` backstop. `earliestBeginDate` is only a lower bound, and a task gets about 30 seconds ([earliestBeginDate](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate)).
- Significant location changes need about 500 m of movement, and Focus status reports only whether the owner is focused. Neither is a wake signal.
- **No API for the Sleep schedule.** Third-party apps cannot read the owner's Sleep schedule or wake alarm; no such type exists in [HealthKit data types](https://developer.apple.com/documentation/healthkit/data-types). Onboarding's `brief_time.set` and the nightly plan stay the source of the planned time.

**When it fails**, each of these leaves the planned time to fire the Brief:
- **The Watch syncs late.** When Watch sleep reaches the iPhone is not documented [unverified]. One developer reports a delay of "many minutes" ([forum thread 763329](https://developer.apple.com/forums/thread/763329)). The signal comes late.
- **No Watch, or a ring or WHOOP only.** WHOOP and Oura come in through provider sync (`owner-do.ts:1676`) on the same recompute path. Their nights arrive when the provider posts them.
- **Phone off, Low Power Mode, or Background App Refresh off.** Low Power Mode pauses background activity ([backgroundRefreshStatus](https://developer.apple.com/documentation/uikit/uiapplication/backgroundrefreshstatus)). Whether it also stops HealthKit delivery is [unverified].
- **The app was force-quit.** It is not relaunched for HealthKit; an Apple DTS engineer says so on [forum thread 775325](https://developer.apple.com/forums/thread/775325), not in the docs.

**Android (Health Connect).**
- There is no push. The app polls the Changes API from an hourly `WorkManager` job, with `READ_HEALTH_DATA_IN_BACKGROUND` ([sync data](https://developer.android.com/health-and-fitness/guides/health-connect/develop/sync-data), [read data](https://developer.android.com/health-and-fitness/guides/health-connect/develop/read-data)).
- A wake signal on Android is at best hourly. The planned time carries most mornings.

## 2. Backend half

### Where "the night is in" is decided (ADR-0081)

- **Computed in the health plane.** The decision is a health computation, so it lives there, in the recompute that already runs after every ingest (`health/recompute.ts:69-76`, debounced to one run a minute).
  - The producer already picks the night: the newest asleep reading for the waking day (`health/producer.ts:150-156`).
  - It adds one field to today's derived row: `night_rev`, an integer that goes up each time the waking day's chosen night changes (its source, its session or its end). The row holds no time; the counter is not a reading.
- **Detected from stored rows.** `detectHealthWakes` (`health/wakes.ts:99-105`) compares stored rows only, never the samples. It gains one reason: `night_recorded`, raised when today's `night_rev` is newer than before the run.
- **What leaves the plane:** the reason code plus the local `day`, exactly what `woken(day, reasons)` carries today (`recompute.ts:29`). No start, end, duration or clock time reaches the owner object, its SQLite, memory, traces, logs or the outbox.
- **Re-firing.** Unlike today's reasons, which are noted once per reason per day (`trigger.ts:98` `markOnce`), `night_recorded` fires each time the night changes. A 03:00 fragment followed by the real night must not use up the morning. The "one per day" rule belongs to the Brief, not to the signal.
- **Consent gates.** The wake is subject to the same gates as today's wakes. It is skipped when the owner withdrew model-use consent, and backfilled rows never wake it (ADR-0081 §5, `:355`).

### What the owner object does with it

`night_recorded` for today leads to the day-card path. It does not go to the health trigger, which proposes health actions and stays as it is.

1. **Code checks the safety bounds.** These are hard limits, not judgment. Otherwise nothing happens:
   - today's Brief is still pending, which excludes cards that are sent, held, waiting on the model, or skipped (`movableCards`, `day-cards.ts:201-212`);
   - the owner did not pin it or set it for today;
   - it is not past the Brief's freshness (local midday, `cardFreshUntil`);
   - the owner has `daily_brief` on;
   - at most three wake turns a morning, coalesced like S8c-1's re-plans (`coalesced`, at most one running and one waiting).
2. **The model judges.** It runs as a S8c-1 re-plan turn with the reason "the owner's wearable shows their night is in". The context is digit-free: local now, quiet hours, today's calendar, the planned time, and whether it is a weekend.
   - The model judges whether this is the morning or a nap or mid-night wake.
   - It chooses send now, keep the planned time, or move it to a later time.
   - "Send now" is the new choice. It schedules the Brief at `now`, the way `retryDayCard` schedules a stuck card (`day-cards.ts:317-334`). S8c-1's rule against past times still holds; "now" is not in the past.
3. **The Brief turn runs as usual.** It writes the content and can still decide to send nothing. Quiet hours still hold it (`plans.held`). The push follows delivery on the app, as today.

**Fallback.** With no signal, the planned time fires the Brief exactly as it does today. The nightly plan can keep a "latest by" time, so a Brief that waits for the wake still has a deadline. A signal after the Brief went out does nothing.

**One Brief a day.** This is unchanged:
- `day_plan.sent` and `save … WHERE sent = 0` (`day-cards.ts:97-103`);
- on surfaces where a send can wait, the outbox key `day-card:{day}:{card}` (`telegram-final-outbox.ts:13`).
A wake turn only moves a pending card. It never writes a second one.

**Naps and mid-night wakes** are the model's call, given the context above. Code only bounds when the model is asked: Brief pending, before midday, three turns at most.

**Travel or a zone change.** `waking_day` is the owner's local day from the sample's `utc_offset_minutes`. The DO reads "today" on the owner's current zone (`clock.timezone`). A night that ends on a different local day than the DO's today does not wake today's Brief [to test].

## 3. WhatsApp and the 24-hour window

- A wake-time Brief on WhatsApp is a business-initiated message.
- **Inside the window,** it goes out as today.
- **Outside the window, it waits.** Today's path keeps the card pending in the outbox and sends the variable-free re-engage template (`whatsappWindowRoute`, `whatsapp-window.ts:164-185`). The Brief then goes when the owner replies, or expires at the next card or day end (`cardExpiry`).
- **We do not put the Brief in a template.** Agent text never rides in a template (`whatsapp-api.ts:123-126`).
- For most owners the app push is the wake-time surface anyway; WhatsApp is the fallback.

## 4. Health-data review: ADR-0081 needs an amendment

**Yes.**
- **The current rule.** ADR-0081's matrix keeps raw samples, timestamps included, out of the owner object (§3, `:84`).
- **What is new.** A derived "night recorded" event crossing into the owner object, and a turn told that the owner's night is in.
- **Nearest precedent.** The 2026-10-27 amendment (§5) let energy windows carry a clock time, because "a clock time is a time of day, not a reading" (`:349`). This amendment allows less:
  - a digit-free reason code and a local date;
  - a monotone integer `night_rev` on the derived row;
  - and in the Brief's turn context, the sentence "the owner's wearable shows their night is in", with no time.
- **What a Brief does not newly gain.** It may say "good morning" sooner; it gains no new readings. Owner-channel replies may already carry the owner's own readings (owner ruling for beta).

The amendment is drafted as a waldo-brain PR, marked **Proposed**: see the link in this PR's description.

## 5. Flags, tests and evals

**Flags** (all default `0`):
- `WAKE_BRIEF` in the backend. It needs `WALDO_DAY_STATE=1`, because it reuses S8c-1's re-plan.
- `health_background_delivery` in the app build.
- The owner's setting "Brief when I wake", default on once shipped. Owner settings win: a pinned Brief time is never moved by a wake.

**Tests** (backend, time-mocked):
- **Golden.** Planned 08:00; at 07:05 the night's ingest arrives. `night_recorded` leads to a wake turn, the model says "send now", and the Brief is scheduled at 07:05. The trace carries codes only; no sleep time appears anywhere in DO storage or the trace.
- **No Watch / no signal.** The Brief fires at 08:00, as today.
- **Late sync.** The night arrives at 08:20, after the 08:00 Brief went out: nothing happens.
- **A 03:00 fragment, then the real night at 07:10.** The first wake turn says keep (the model, with quiet hours in context). The second, triggered by the new `night_rev`, sends. Three turns at most.
- **Travel or zone change.** A night whose `waking_day` is not the owner's local today does not wake today's Brief. DST end and start are covered.
- **Weekend lie-in.** A night at 10:30 Saturday, with an 09:00 plan: the plan fires first, and the late night does nothing. With "Brief when I wake" and a "latest by" of 11:00, it waits and sends at 10:30.
- **Owner settings.** A pin, "Set for today", `daily_brief` off or quiet hours each keep their effect; the wake only asks.
- **Consent.** With model-use consent withdrawn, or a backfill, there is no wake.
- **One a day.** Two wake turns plus the planned time still give one Brief: the `day_plan` row and the outbox key.

**Evals.** These are judged scenarios for the wake turn's choice:
- a weekday 07:05 wake gives send;
- a 03:10 wake on a quiet night gives keep;
- a 14:00 nap gives no turn (past freshness);
- a 06:00 wake during quiet hours until 07:00 gives "send at 07:00" or keep;
- a Saturday 10:30 wake with no plans gives send.

## 6. Size, order and contract

| Wave | Repo | What | Size |
|---|---|---|---|
| W0 | waldo-brain | ADR-0081 amendment accepted (blocks W1) | S |
| W1 | waldo-backend | `night_rev` in the derived row (Supabase migration + producer), `night_recorded` reason, re-firing semantics | M |
| W2 | waldo-backend | Wake turn: the safety bounds, the "send now" choice in the re-plan turn, `WAKE_BRIEF` flag, tests and evals | M |
| W3 | waldo-app | HKObserverQuery and background delivery for sleep, steps and heart rate, registered natively at launch; on-device check of delivery after unlock | M |
| W4 | both | The owner setting "Brief when I wake" (controls 11, additive) | S |

**Contract (app.v1, additive only; the app lane gets a heads-up first):**
- **health 6**, optional: the ingest envelope may carry `trigger: 'background_delivery' | 'foreground' | 'refresh'`. It tells the backend that a sync came from a background delivery just after unlock, which is useful for traces and evals. Old builds omit it. The trigger in §2 does not depend on it.
- **controls 11**, optional: the day controls gain a `brief.wake` setting and its action. Old builds ignore it.

**Relation to S8c-2 (patterns).** The owner's usual wake time could become a plan input as an `HH:MM` clock time under the energy-window exception. That stays with S8c-2 and the owner's pending ruling on its scope.
