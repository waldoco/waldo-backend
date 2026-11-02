# Proactive signals

Waldo messages the owner on Telegram when something happens, not at fixed times:

| Moment | Signal | What Waldo does |
|---|---|---|
| You wake up (Sleep Focus ends) | `woke_up` | Good-morning message: the shape of the day, what to get ready for, open follow-ups |
| No wake-up signal by the morning deadline | none (Waldo's own alarm) | The same morning message, as a fallback |
| Wind Down starts | `winding_down` | A light end-of-day close |
| An Apple Watch workout ends | `workout_ended` | A practical food and recovery suggestion that fits your next commitments |
| A meeting note is ready | `meeting_notes` | A few bullet action items, and a note if the meeting seems to have moved |

For every signal the model decides whether a message would actually help. It can reply `NO_MESSAGE`, and then nothing is sent. Code handles only the hard limits:

- Each morning and evening moment is handled once per local day. A late wake-up after the deadline message doesn't produce a second one.
- A meeting note is handled once, keyed by its `id` or, without one, by its content.
- At most 12 proactive model calls per day, failed ones included.

Source: `packages/runtime/src/channels/owner-signals.ts`, `proactive-owner.ts` and `telegram-owner-do.ts`. The contract is `packages/contracts/src/runtime/owner-signal.ts`.

## Privacy

- Signals carry no health readings. The contract rejects unknown fields, and a workout `activity` label can't contain digits, so calories, heart rate and sleep length are refused at the door.
- Your local time goes to the model for that one turn only. The saved conversation records that you woke up, not when.
- Weather, calendar text and meeting notes you send are ordinary conversation context. They're saved with the chat like any message.

## Worker configuration

| Name | Kind | Meaning |
|---|---|---|
| `WALDO_SIGNAL_SECRET` | secret, required | Shared secret the iPhone sends in the `X-Waldo-Signal-Secret` header. At least 16 characters. Without it, `/signals` answers 404. |
| `WALDO_OWNER_TIMEZONE` | var | IANA zone such as `Asia/Kolkata`. Without it, signals still work, but there's no morning deadline. |
| `WALDO_MORNING_DEADLINE` | var | Local `HH:MM` for the fallback morning message. Default `09:30`. |

From `packages/runtime`:

```sh
openssl rand -hex 24 | npx wrangler secret put WALDO_SIGNAL_SECRET --name waldo-runtime-staging
```

The deadline alarm arms itself on the first Telegram message or signal after deploy.

## iPhone setup (Shortcuts app)

Each automation ends with the same action: **Get Contents of URL**.

- URL: `https://<staging worker host>/signals`
- Method: `POST`
- Headers: `X-Waldo-Signal-Secret` = your secret
- Request Body: `JSON`, with the fields below

Set each automation to **Run Immediately**, so it doesn't ask first.

1. **Wake-up.** Automation → **Focus** → **Sleep** → **When Turning Off**. This is the same moment the Watch shows its good-morning screen. Optional actions before the request:
   - **Get Current Weather**.
   - **Find Calendar Events** where Start Date is today.

   Body: `kind` = `woke_up`, plus a `context` dictionary with `weather` and `calendar` as text from those actions. The **Sleep** → **Waking Up** trigger also works, but only if you use a sleep schedule.
2. **Wind-down.** Automation → **Sleep** → **Wind Down Begins**. Body: `kind` = `winding_down`. Add a `context` with tomorrow's calendar if you like.
3. **Workout.** Automation → **Apple Watch Workout** → **Ends**. Body: `kind` = `workout_ended`. You can add `activity` as a word such as `Run` (letters only), and a `context` with the rest of today's calendar.
4. **Meeting notes.** Make a shortcut that accepts text from the Share Sheet. Body: `kind` = `meeting_notes`, `notes` = Shortcut Input, and optionally `title`. Share a finished note to it from your notes app. Any automation tool that can send a web request can send the same body.

## Not built yet

- Waldo can't see that a meeting recording has started. Granola's public API is read-only and returns a note only once its summary is ready, so the earliest automatic moment is when the note finishes. Automatic Granola polling needs a reviewed connector and access to Granola's docs.
- The signals come from iPhone automations, not the Waldo app. The planned app path is HealthKit background delivery (ADR-0010), whose delivery can lag by up to 120 minutes.
- Google Calendar isn't connected. Calendar context arrives only as text from the iPhone.
