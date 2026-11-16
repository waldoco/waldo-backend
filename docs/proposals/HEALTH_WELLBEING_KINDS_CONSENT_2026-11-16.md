# Wellbeing kinds: consent copy 5 and privacy notice lines (draft)

Status: draft for the owner and the app. It follows the owner's ruling 9 of 16 Nov 2026: the first batch of new kinds ships, each with its consent line and its privacy notice line. Blood pressure and glucose are held until after the cohort and a legal review.

The app owns the final wording. The backend enforces one rule: a wellbeing reading is stored only under a storage grant on copy 5. A build that still shows copy 2 keeps working and never sends these kinds.

## The kinds

| Kind (contract) | What the phone sends | Grain | Read name in `get_health` |
|---|---|---|---|
| `hydration` | One logged entry of water, in millilitres | per entry | `water` (day sum) |
| `caffeine` | One logged entry, in milligrams | per entry | `caffeine` (day sum) |
| `alcoholic_drinks` | One logged entry, as a count of drinks | per entry | `alcohol` (day sum) |
| `state_of_mind` | One logged emotion or daily mood: pleasantness from -1 to 1, its kind, and the labels and associations from Apple's closed lists (38 labels, 18 associations). No free text exists in it and none is sent. | per entry | `mood` (day mean, plus each entry) |
| `sleep_breathing_disturbances` | The night's disturbances per hour asleep, `events_per_hour`, as the Watch measured them | per night | `breathing_disturbances` |
| `audio_exposure_window` | One local hour's A-weighted sound level, `dba` (the energy average), from the surroundings or from headphones | per hour | `sound_level` (energy mean, one source of sound at a time) |
| `walking_steadiness` | The phone's estimate, 0 to 100 percent | per reading | `walking_steadiness` |

Source: Apple's `HKStateOfMind.Label` and `HKStateOfMind.Association` documentation (developer.apple.com, read 16 Nov 2026). Health Connect offers hydration and nutrition caffeine; the other kinds are Apple's only.

## Consent copy 5: added lines (draft)

Copy 5 is copy 2's words with these lines added under "What Waldo reads":

- **Water:** how much water you log.
- **Caffeine:** how much caffeine you log and when, so Waldo can weigh it against your sleep.
- **Alcohol:** how many alcoholic drinks you log, so Waldo can read your night and the next day with them in mind.
- **State of mind:** the moods and emotions you log in Apple Health, with the words you picked from Apple's list, so Waldo knows how your days have felt.
- **Breathing in sleep:** breathing disturbances your Watch measured while you slept. Waldo reads them beside your sleep. Waldo does not diagnose anything.
- **Sound levels:** how loud your surroundings and your headphones were, hour by hour.
- **Walking steadiness:** your walking steadiness, as your iPhone estimates it.

The consent screen keeps its two separate yeses: store and compute, and let Waldo use it when it talks to you. Each line falls under both.

## Privacy notice: added rows (draft)

| Data | Why | Where it is kept | Who processes it | How long |
|---|---|---|---|---|
| Water, caffeine, alcoholic drinks you log | To plan your day and read your sleep with them in mind | Waldo's health store, under your account only | Waldo; the AI model provider during a conversation, only with your model-use consent. Raw values are never written to logs, memory or traces. | Raw entries 90 days; deleted when you withdraw storage consent or delete your account |
| Moods and emotions you log (pleasantness, Apple's labels and associations) | To know how your days have felt | Same | Same | Same |
| Breathing disturbances in sleep | To read your nights | Same | Same | Same |
| Sound levels by the hour | To read noisy days | Same | Same | Same |
| Walking steadiness | To read changes in how you move | Same | Same | Same |

## Owners already granted on copy 2: DECISION NEEDED

A live grant cannot be granted again: today the grant function answers `epoch_conflict`. An owner granted on copy 2 therefore gets every wellbeing reading back as `consent_required` until they hold a copy-5 grant. The only way there now is to withdraw storage and grant again, and withdrawing storage purges their data.

Options:

1. **Re-affirm (recommended).** A grant that names a newer copy than the live grant writes a new consent row on that copy and moves the scope to it. The epoch is unchanged, because no data changes. The old row stays as history, marked superseded. This needs a `superseded_at` column, and every function that reads live consents must be audited. It is a separate migration and a separate consent-flow screen in the app.
2. **Withdraw and re-grant.** Nothing is built, but the owner loses their stored readings. This is acceptable only for staging test accounts.
3. **Store wellbeing kinds under copy 2.** This is rejected: the owner would never have seen the lines, which goes against ruling 9.

## Reconciled with the phone's proposal (waldoco/waldo-app#257, comment 6927343817)

- **Point records, not hourly sums, for water, caffeine and alcohol.** Each logged entry keeps its own time, which says more than its hour about a late coffee. Each also maps one to one to the store's entry, so a deletion on the phone deletes one reading here, and no hour needs recomputing. `nutrition` already works this way.
- **Units:** the phone's `events_per_hour` and `dba` (A-weighted) are adopted, being clearer than `per_hour` and `decibels`. `millilitres` and `milligrams` stay as written.
- **Copy 5, not 3.** Copies 3 and 4 are WHOOP's wordings, and one copy number names one wording. Device grants are offered and stored on 2 or 5. The phone's count of agreed rows needs to accept copy 5 as well as copy 2.
- **State of mind's labels and associations: DECISION NEEDED (the owner).** The contract takes them as optional closed lists, so either ruling needs no contract change. The phone sends valence and kind only until the owner rules.

## Evidence Trail

- 2026-11-16 · Ansh's session · Drafted copy 5 lines, privacy notice rows and the re-affirm decision (why: ruling 9 ships each kind with its consent line and privacy notice line)
