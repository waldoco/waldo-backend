# Wake-driven Brief

Status: **Accepted**, 1 November 2026. Design only, no code; the build follows the W-1 spike. Code references are pinned to `beta-mvp` at `b80f0f1a`; ADR-0081 references to waldo-brain `7faba7e`. The owner asked for it ("Yes, design it"). It builds on S8c-1 (#1780).

## The ask

The owner's words: when the owner wears their wearable and wakes up, "Waldo should automatically understand that now they have woken up… start creating the brief and then send those notifications when the user wakes up and starts their phone".

Today the Brief's time is planned the night before (`planToday`, nightly at 03:00 and at boot). S8c-1 re-plans it when today's calendar changes. Waking up is not used anywhere: nothing in the backend stores or emits a "woke" signal [verified at `b80f0f1a`; the only wake logic is `scores/energy-windows.ts:56`, inside the health-plane recompute].

## Shape in one paragraph

The phone syncs the night's sleep as soon as iOS lets it, which is usually just after the first unlock. The health plane decides from that sleep record that today's night is in, and tells the owner object with a bare signal. The signal carries no time and no value. A Brief that is still pending then gets one model turn, which may send it now or keep it. In wake mode the planned time is a "latest by": the Brief goes at the wake or at that time, whichever comes first. "One Brief a day" stays where it is, on the Brief's own row.

**Go/no-go first.** The feature rests on one thing not yet seen on a device: whether the night's sleep reaches the backend within minutes of the first unlock. A short on-device spike checks it before any backend work starts (wave W-1 below). If it doesn't hold, most mornings fall back to the planned time, and the feature isn't worth building in this form.

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
- **Handling a delivery while locked.** An observer that fires while the phone is locked gets `errorDatabaseInaccessible` on its read. The app still calls the completion handler, so HealthKit does not back off. It then relies on the next delivery after unlock, or on `protectedDataDidBecomeAvailable` if the app happens to be running.
- **The assumption under the whole feature** [inference]: the journal merge on unlock triggers a fresh observer delivery. The W-1 spike checks exactly this.

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
- **No Watch, or a ring or WHOOP only.** WHOOP and Oura come in through provider sync (`owner-do.ts:1677`) on the same recompute path. Their nights arrive when the provider posts them.
- **Phone off, Low Power Mode, or Background App Refresh off.** Low Power Mode pauses background activity ([backgroundRefreshStatus](https://developer.apple.com/documentation/uikit/uiapplication/backgroundrefreshstatus)). Whether it also stops HealthKit delivery is [unverified].
- **The app was force-quit.** It is not relaunched for HealthKit; an Apple DTS engineer says so on [forum thread 775325](https://developer.apple.com/forums/thread/775325), not in the docs.

**Android (Health Connect).**
- There is no push. The app polls the Changes API from an hourly `WorkManager` job, with `READ_HEALTH_DATA_IN_BACKGROUND` ([sync data](https://developer.android.com/health-and-fitness/guides/health-connect/develop/sync-data), [read data](https://developer.android.com/health-and-fitness/guides/health-connect/develop/read-data)).
- A wake signal on Android is at best hourly. The planned time carries most mornings.

## 2. Backend half

### Where "the night is in" is decided (ADR-0081)

- **Computed in the health plane.** The decision is a health computation, so it lives there, in the recompute that already runs after every ingest (`health/recompute.ts:69-76`, debounced to one run a minute).
  - The producer already picks the night: the newest asleep reading for the waking day (`health/producer.ts:153-159`).
- **How the producer knows the night changed.** It must remember which night it chose last time; a counter alone can't tell it that.
  - The derived row in the health plane (Supabase) keeps a `night_ref`: a digest of the chosen night's source, session and end.
  - On each run the producer compares the new digest with the stored one, writes the new one, and returns `nightChanged: true` with its outcome.
  - `night_ref` stays in the health plane. It is **not** returned by `health_context_read`, whose output also feeds prompts, so that RPC's matrix entry and fixtures are unchanged.
- **Not routed through today's wake gate.** Today's wakes run only while the owner has health proposals on (`owner-do.ts:4833`, `wakes.enabled`), and every reason goes to the health trigger (`healthWoken` → `armHealthTrigger`).
  - The night signal gets its own callback: `nightRecorded(day)`, called when a run returns `nightChanged` for today.
  - It is gated on `WAKE_BRIEF`, the owner's `daily_brief` and model-use consent, not on `health_proposals`.
  - Backfilled rows never call it (ADR-0081 §5, `:355`).
- **What leaves the plane:** the call itself and the local `day`. No start, end, duration or clock time from the sample reaches the owner object, its SQLite, memory, traces, logs or the outbox.
- **What the owner object does learn.** The signal arrives a few minutes after the wake. The moment Waldo acts on it, and the Brief's send time, are system event times: they land in the schedule row, `day_plan` and the trace row's `at`, like any card's send time. Together they roughly show when the owner woke. The amendment says this outright and allows it. The sample's own `end_at` never crosses.
- **Re-firing.** Unlike today's reasons, which are noted once per reason per day (`trigger.ts:98` `markOnce`), the night signal fires each time the chosen night changes. A 03:00 fragment followed by the real night must not use up the morning. The "one per day" rule belongs to the Brief, not to the signal.

### What the owner object does with it

`nightRecorded(day)` for today leads to the day-card path. It does not go to the health trigger, which proposes health actions and stays as it is.

**In wake mode the planned time is a "latest by".** The nightly plan sets the Brief's time after the owner's usual wake, as the latest it should go. The wake turn can only send the Brief now or keep that time; it never moves it later.

1. **Code checks the safety bounds.** These are hard limits, not judgment. Otherwise nothing happens:
   - today's Brief is still pending, which excludes cards that are sent, held, waiting on the model, or skipped (S8c-1's `movableCards`);
   - the owner did not pin it or set it for today;
   - it is not past the Brief's freshness (local midday, `cardFreshUntil`);
   - the owner has `daily_brief` on;
   - at most three wake turns a morning. That is a cost backstop, like `PROACTIVE_PUSH_DAILY_LIMIT`, not a product rule.
2. **Its own queue.** The wake turn uses its own `coalesced` queue (at most one running and one waiting), not S8c-1's calendar re-plan queue. Otherwise a wake that arrived while a calendar re-plan waited would be absorbed into a prompt that doesn't know the night is in. Neither queue keeps a "night in" flag: the request itself carries it, volatile.
3. **The model judges.** The prompt says "the owner's wearable shows their night is in". The context is digit-free: local now, quiet hours, today's calendar, the "latest by" time, and whether it is a weekend.
   - The model judges whether this is the morning, a nap or a mid-night wake.
   - It chooses send now or keep.
   - "Send now" schedules the Brief at `now`, the way `retryDayCard` schedules a stuck card. S8c-1's rule against past times still holds; "now" is not in the past.
4. **The Brief turn runs as usual.** It writes the content and can still decide to send nothing. Quiet hours still hold it (`plans.held`). The push follows delivery on the app, as today.

**Fallback.** With no signal, the "latest by" time fires the Brief exactly as the planned time does today. A signal after the Brief went out does nothing.

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
- **What is new.** A derived "night recorded" signal crossing into the owner object, and a turn told that the owner's night is in.
- **Nearest precedent.** The 2026-10-27 amendment (§5) let energy windows carry a clock time, because "a clock time is a time of day, not a reading" (`:349`). This amendment allows less:
  - the signal itself, with the local date and nothing else;
  - a `night_ref` digest on the derived row, which stays in the health plane and is not returned to prompts;
  - in the Brief's turn context, the sentence "the owner's wearable shows their night is in", with no time;
  - and, said outright: the time Waldo acts on the signal, and the Brief's send time, are system event times kept like any card's. They roughly show when the owner woke. The sample's own times never cross.
- **What a Brief does not newly gain.** It may say "good morning" sooner; it gains no new readings. Owner-channel replies may already carry the owner's own readings (owner ruling for beta).

The amendment is a waldo-brain PR, marked **Accepted** on 1 November 2026: see the link in this PR's description.

## 5. Flags, tests and evals

**Flags** (all default `0`):
- `WAKE_BRIEF` in the backend. It needs `WALDO_DAY_STATE=1`, because it reuses S8c-1's re-plan.
- `health_background_delivery` in the app build.
- The owner's setting "Brief when I wake", default on once shipped. Owner settings win: a pinned Brief time is never moved by a wake.

**Tests** (backend, time-mocked):
- **Golden.** "Latest by" 08:00. The night ends at 06:52, and its ingest arrives at 07:05. The night signal leads to a wake turn, the model says "send now", and the Brief is scheduled at 07:05. "06:52" appears nowhere in DO storage, the outbox or the trace. The trace carries codes and counts only.
- **No Watch / no signal.** The Brief fires at 08:00, as today.
- **Late sync.** The night arrives at 08:20, after the 08:00 Brief went out: nothing happens.
- **A 03:00 fragment, then the real night at 07:10.** The first wake turn says keep (the model, with quiet hours in context). The second, triggered because the chosen night changed, sends. Three turns at most.
- **A calendar re-plan and a wake together.** A wake that arrives while S8c-1's calendar re-plan is queued still gets its own turn with the night in its prompt.
- **Travel or zone change.** A night whose `waking_day` is not the owner's local today does not wake today's Brief. DST end and start are covered.
- **Weekend lie-in.** Saturday's "latest by" is set after a usual weekend wake, say 11:00. The night ends at 10:30: the wake turn sends at 10:30. With no night by 11:00, the Brief goes at 11:00.
- **Owner settings.** A pin, "Set for today", `daily_brief` off or quiet hours each keep their effect; the wake only asks.
- **Gates.** With model-use consent withdrawn, `WAKE_BRIEF` off, or a backfill, there is no wake. With `health_proposals` off and the Brief on, the wake still works.
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
| W-1 | waldo-app | **Go/no-go spike** on a device: does the night's sleep reach the backend within minutes of the first unlock? | S |
| W0 | waldo-brain | ADR-0081 amendment accepted (blocks W1) | S |
| W1 | waldo-backend | `night_ref` in the derived row (Supabase migration; the gate allocates its timestamp), the producer's `nightChanged`, the `nightRecorded` callback and its gates, re-firing | M |
| W2 | waldo-backend | Wake turn: the safety bounds, its own queue, "send now", wake mode's "latest by", `WAKE_BRIEF` flag, tests and evals | M |
| W3 | waldo-app | HKObserverQuery and background delivery for sleep, steps and heart rate, registered natively at launch, with the locked-store handling | M |
| W4 | both | The owner setting "Brief when I wake" (additive controls revision) | S |

**Contract (app.v1, additive only; the app lane gets a heads-up first):**
- **The ingest contract is unchanged.** Sleep already arrives with what the producer needs.
- **One additive controls revision**, allocated by the gate: the day controls gain a `brief.wake` setting and its action. Old builds ignore it.

**Relation to S8c-2 (patterns).** The owner's usual wake time could become a plan input as an `HH:MM` clock time under the energy-window exception. That stays with S8c-2 and the owner's pending ruling on its scope.
