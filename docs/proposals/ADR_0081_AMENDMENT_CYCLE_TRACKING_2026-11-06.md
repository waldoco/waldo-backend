# ADR-0081 amendment (draft): opt-in cycle tracking, as model context only

Status: **proposed**, 6 November 2026. Nothing here is accepted. It is a draft for the owner to rule on and, once ruled, for
waldo-brain's ADR-0081 to carry as a dated amendment, like the medicines amendment (Pin4sf/waldo-brain#53). Until then no
code reads cycle data, and the switch it names does not exist.

It narrows one item of the accepted 31 October amendment's §5, "Proposed, not accepted: sensitive readings behind their own
consent purpose", to cycle tracking alone, and states what the build may do once its conditions are met. Blood pressure,
blood glucose and State of Mind stay where §5 left them.

Owner gap list: waldoco/waldo-backend#1939, item 5. Base: `beta-mvp` `5088bb73`.

## The problem

An owner who tracks their cycle on the phone gets plans that ignore it. Energy, sleep and how a hard workout feels change
across a cycle, and for some owners a heavy-flow day changes what a day can hold. Waldo already plans around the day's
zones and drivers; it has no way to know that today is a period day, so it may push a hard session or a packed day on one,
or explain a low day with a cause it cannot see.

What the owner wants is small: when they choose to share it, Waldo knows the phase of their cycle and can take it into
account when they ask for a plan, in the same words a friend who knew would use. Nothing more.

## Decision (proposed)

### 1. What is read, and from where

Only the owner's own logged periods. Nothing that predicts fertility or describes sexual or reproductive activity.

| Platform | Read | Not read |
|---|---|---|
| HealthKit (iOS) | `HKCategoryTypeIdentifier.menstrualFlow` samples (flow level, and the `HKMetadataKeyMenstrualCycleStart` flag the Health app sets on a cycle's first day) | intermenstrual bleeding, ovulation test results, cervical mucus, basal body temperature, sexual activity, pregnancy, lactation, contraceptive use, progesterone tests |
| Health Connect (Android) | `MenstruationFlowRecord` (flow level) and `MenstruationPeriodRecord` (a period's start and end) | `OvulationTestRecord`, `CervicalMucusRecord`, `IntermenstrualBleedingRecord`, `BasalBodyTemperatureRecord`, `SexualActivityRecord` |

- The phone asks the platform for these types only after the owner opts in (§2), and never as part of the ordinary health
  permission sheet. An owner who never opts in is never asked.
- A wearable app that writes these types to HealthKit or Health Connect is read the same way; nothing is read from a
  wearable vendor's own API.

### 2. Opt-in, per owner, on its own consent purpose

Per §5 of the 31 October amendment: a third consent purpose for each source, beside `storage_compute` and
`model_processing`. This draft names it `cycle_context`.

- **Grant:** on a screen of its own, with its own copy, after the owner turns cycle tracking on in Waldo's settings. Off by
  default. Turning on general health sharing never turns it on.
- **Use needs all three purposes** live for the source the samples came from.
- **Withdrawal:**
  - withdrawing `cycle_context` purges every cycle sample and leaves the owner's other health data;
  - withdrawing `storage_compute` purges everything, as today;
  - re-granting never restores model use, as today, and never restores purged samples.
- **Older builds:** a build below the health contract revision that adds the purpose is never shown its consent rows, since
  it parses the consent list strictly; the phone then never reads the types.

### 3. Storage

- Raw samples only, in the §3 raw-samples row: the Supabase health plane, RLS forced, reached only through signed router
  calls, with that row's 90-day retention, the withdrawal purge (§2) and account deletion.
- **No derived row.** The phase (§4) is computed when the consented reader asks, from the samples in that read, and is
  never stored: not in Supabase, the owner's Durable Object, R2, memory, constellation nodes, logs, metrics or traces.
- Export includes the samples, like other raw samples.

### 4. Cycle phase: what the model may see

The consented reader turns the samples into words, never numbers:

- `period`: flow is logged today or yesterday;
- `after period` and `before period`: the first and second half of the time since the last logged cycle start, measured
  against the owner's own median cycle length over their last three or more logged cycles;
- `irregular or unknown`: fewer than three logged cycles, a cycle outside 21 to 45 days, or no start in the last 60 days.

- **Model context only, owner turns only.** The phase word reaches the model through the consented health reader on a
  turn the owner started, beside the day's zones. It has `turn_only_output`, so the tool-output ledger keeps a content-free
  line.
- **Never a number.** No cycle day, cycle length, days until a period or flow volume reaches a prompt, a reply or a card.
- **Never a prediction about fertility.** No ovulation, fertile window, conception or contraception words, and no
  "you are likely to get your period on" date. The phase words above are the whole vocabulary.
- **Never a cause stated as fact.** Waldo may say a plan takes the phase into account when the owner has shared it; it does
  not say the phase caused a low day.
- **No derived use.** No score, driver, zone, load, Form or capacity input reads cycle data. The health trigger never fires
  on it, and no proactive message (Brief, Check-in, Close, Spot, notification) mentions it unless the owner asked about it
  in that conversation.

### 5. Where a reply about it may go

- **The app chat:** yes, in the owner's own conversation.
- **WhatsApp, Telegram, iMessage, email, push notifications and any connector output:** never by Waldo's choice. If the
  owner asks about it on WhatsApp, the reply says Waldo will answer in the app. *(Open question 2.)*
- **Never** in a calendar title, a draft, a send card, or anything addressed to another person.

### 6. Hard boundaries, enforced in code

- The phase words and the read types are a closed list in the health contract, schema-validated at ingest and at the reader.
- The Scribe treats a cycle sample like any raw reading: refused at persistence and egress destinations.
- No medication, hormone or supplement suggestion, as for every health reading (the existing dosing boundary).
- A turn that has read outside text never reads cycle data: the reader is not offered after outside text in that turn.

### 7. Switch

`HEALTH_CYCLE`, inside `WALDO_SWITCHES`, `"0"` in every environment. It may turn on in staging only after this amendment is
accepted, and in production only after the conditions in §8 are met and the privacy notice carries its line.

### 8. Conditions before acceptance

From §5 of the 31 October amendment, unchanged:

- consent copy for the `cycle_context` screen, and the privacy-notice line: Waldo keeps logged periods for 90 days to take
  the cycle into account in plans, only while the owner has turned it on; turning it off deletes them;
- a legal review of processing reproductive-health data for the launch markets (India's DPDP Act 2023 and GDPR Art. 9 for
  the beta cohort, and any market where reproductive-health data has its own law), including whether the 90-day retention is
  the shortest that serves the purpose;
- an independent privacy review of the reader, the purge and the egress rules above;
- a health contract revision after 5, for the read types, the purpose and the phase words.

## Considered options

1. **Cycle phase as model context only, computed on read (this draft).** Gives the planning benefit; nothing derived is
   stored; the vocabulary is closed. Costs a reader change and a consent purpose.
2. **A stored derived phase on the daily row.** Simpler to read and to show in the app, but it creates a derived
   reproductive-health record with its own retention and export, for no benefit the model needs. Rejected.
3. **Phase as a driver or score input.** Would let the engine adjust Recovery or capacity. Rejected: no validated model for
   it in this engine, and it would make a reproductive-health inference part of every score the owner sees.
4. **Let the owner tell Waldo in chat, with no device read.** Possible today: the owner's words are conversation context.
   It stays possible; it does not replace a read, because owners log periods on the phone, not in chat. Memory keeps no
   cycle facts either way (the memory health rules apply).
5. **Read fertility signals too (ovulation tests, basal temperature).** Rejected: the product does not need them, and they
   carry the highest legal and safety risk.

## Open questions for the owner

1. The consent purpose name and copy (`cycle_context` here).
2. Whether a reply that mentions the phase may go on WhatsApp when the owner asks there (this draft says app only).
3. Whether 90-day retention is wanted, or a shorter one for cycle samples (the phase needs about three cycles).

## Unchanged

Every other §3 row, the single computation authority (§1), the device fallback (§4), and consent, export and deletion (§5).
Blood pressure, blood glucose and State of Mind stay proposed under the 31 October amendment's §5.
