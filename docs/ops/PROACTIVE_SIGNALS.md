# Proactive signals

Waldo acts on moments in the owner's day, not on fixed times. Devices and apps report a moment to `POST /signals`. Waldo then runs a proactive turn and decides whether a Telegram message would help. It can also schedule its own check-back for later. Why and how this behaves: [SPONTANEITY.md](../behavior/SPONTANEITY.md).

Source: `packages/runtime/src/channels/owner-signals.ts`, `proactive-owner.ts` and `telegram-owner-do.ts`. The contract is `packages/contracts/src/runtime/owner-signal.ts`.

## Signal format

JSON body, with the header `X-Waldo-Signal-Secret: <secret>`.

**Any moment:**

```json
{
  "source": "calendar",
  "event": "meeting_moved",
  "detail": "Investor call moved from 15:00 to 17:00",
  "id": "evt_123",
  "context": { "calendar": "10:00 Design review\n17:00 Investor call", "weather": "Rain" }
}
```

- `source` and `event` are short lowercase names you choose, such as `location`/`arrived`, `mail`/`received`, `granola`/`note_ready` or `shift`/`handover_done`.
- `detail` is optional free text, up to 100k characters.
- `id` is optional. Moments with the same `source` and `id` are handled once.
- `context` is optional: up to 12 named texts.

**Body moments**, from a closed list with no free text or numbers:

```json
{ "source": "health", "event": "workout_ended", "activity": "Run", "context": { "calendar": "..." } }
```

The `event` is one of `woke_up`, `wind_down`, `workout_started` or `workout_ended`. `activity` is an optional label, letters only. Any reading (calories, heart rate, sleep length) is rejected.

Responses:

| Status | Meaning |
|---|---|
| `202` | Accepted |
| `400` | Malformed |
| `403` | Wrong secret |
| `413` | Body over 256 KB |
| `404` | Route not configured |

## Behaviour

- **Waldo may stay silent.** The model replies `NO_MESSAGE` when nothing is worth saying, and nothing is sent.
- **Check-backs.** The model may add `CHECK_BACK HH:MM <reason>` (owner's local time, within 24 hours). Waldo stores it, removes that line from the message, and runs another proactive turn when it comes due. Up to 6 can be pending, and they need `WALDO_OWNER_TIMEZONE`.
- **Morning safety net.** If no `health`/`woke_up` arrives by the morning deadline, Waldo sends the morning message anyway. A later wake-up that day stays quiet.
- **Dedupe.**
  - Wake-up and wind-down: once per local day.
  - Moments with an `id`: once per `source` and `id`.
  - Other moments: identical content is handled once within the hour.
- **Budget.** At most 12 proactive model calls a day, failures and check-backs included.
- **Privacy.**
  - Your local time goes to the model for that turn only. The saved conversation records that you woke up, not when.
  - `detail` and `context` are ordinary conversation context and are saved with the chat.

## Worker configuration

| Name | Kind | Meaning |
|---|---|---|
| `WALDO_SIGNAL_SECRET` | secret, required | At least 16 characters. Without it, `/signals` answers 404. |
| `WALDO_OWNER_TIMEZONE` | var | IANA zone such as `Asia/Kolkata`. Required for the morning safety net and for check-backs. |
| `WALDO_MORNING_DEADLINE` | var | Local `HH:MM` for the safety net, default `09:30`. Set `off` for shift work or irregular sleep. |

From `packages/runtime`:

```sh
openssl rand -hex 24 | npx wrangler secret put WALDO_SIGNAL_SECRET --name waldo-runtime-staging
```

The alarm arms itself on the first Telegram message or signal after deploy.

## iPhone setup (Shortcuts app)

Each automation ends with **Get Contents of URL**:

- URL: `https://<staging worker host>/signals`
- Method: `POST`
- Headers: `X-Waldo-Signal-Secret`
- Request Body: `JSON`

Set each automation to **Run Immediately**. Add **Get Current Weather** or **Find Calendar Events** first, and pass their results in `context`, when the moment benefits from them.

| Automation trigger | Body |
|---|---|
| Focus → Sleep → When Turning Off | `source` `health`, `event` `woke_up`, `context` with today's calendar and weather |
| Sleep → Wind Down Begins | `source` `health`, `event` `wind_down`, `context` with tomorrow's calendar |
| Apple Watch Workout → Ends | `source` `health`, `event` `workout_ended`, optional `activity` |
| Arrive / Leave a location | `source` `location`, `event` `arrived` or `left`, `detail` with the place name |
| CarPlay → Connects | `source` `car`, `event` `connected`, `context` with the next calendar events |
| Email or Message from a chosen sender | `source` `mail` or `message`, `event` `received`, `detail` with the sender and subject |
| Focus (Work, Driving…) turning on or off | `source` `focus`, `event` `<name>_on` or `<name>_off` |
| Share Sheet shortcut "Send to Waldo" | `source` `share`, `event` `note`, `detail` with the Shortcut Input. Use it for meeting notes, recordings and documents. |

Any service that can send a web request can send the same body.

## Not built yet

- No connectors produce moments on their own (Google Calendar change watching, Gmail, Granola). Granola's public API is read-only and returns a note only once its summary is ready.
- The Waldo app's HealthKit background delivery (ADR-0010) isn't wired to `/signals`. Its delivery can lag by up to 120 minutes.
- None of this has been exercised on a real device against the deployed Worker.
