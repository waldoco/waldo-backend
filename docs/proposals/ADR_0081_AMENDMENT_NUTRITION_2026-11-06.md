# ADR-0081 amendment: nutrition from the phone's health store (health contract revision 7)

Status: written with the A5 PR for waldoco/waldo-backend#1980. Under the Wave 2 rule, a bounded, product-first amendment is
pre-accepted, and the gate confirms it at review. Once confirmed, waldo-brain's ADR-0081 carries it as a dated amendment.

## The problem

Most food and fitness apps already write to Apple Health or Health Connect, which Waldo reads. Workouts arrive today with
their type, minutes, heart rate, zones and effort (revision 5), and mindful minutes arrive as `mindful_duration`. Food
arrives as nothing, because no nutrition signal exists. An owner who logs meals in their food app gets Brief and Close
plans that cannot see a day of under-eating before a long run, or a late heavy dinner before a short night.

## Decision

### 1. Input accepted (health contract revision 7)

`nutrition` is one food entry as the phone's store holds it, written by the owner's own food app. It is a point record keyed by
its store record id, so re-sending it is idempotent, as for every other point record.

| Field | Meaning | Bounds (unit-mistake catches, not dietary thresholds) |
|---|---|---|
| `value`, `unit: kilocalories` | the entry's energy | 0 to 10,000 |
| `protein_g`, `carbohydrate_g`, `fat_g` | grams, each optional | 0 to 1,000 |
| `meal` | `breakfast`, `lunch`, `dinner`, `snack` or `unknown`, optional | |

- **A food's name never travels.** It is another app's text, so leaving it out means nothing needs Scribe at ingress. Both
  the Worker (strict contract) and the database (key allowlist) refuse an entry that carries it, or any key not listed above,
  including the night context other signals take, whose free-text references would otherwise ride along.
- **No micronutrients, water or caffeine.** Each would be its own signal, under its own amendment.

### 2. Storage and readers

- **Storage:** the §3 matrix row for raw samples. That means `waldo.health_samples` on the Supabase health plane, with RLS
  forced, signed router calls, the 90-day raw retention, the withdrawal purge and account deletion. No new store,
  destination or retention period is created.
- **Never stored or logged elsewhere:** not in a prompt, the owner's Durable Object, R2, memory, a log or a trace.
- **Reader:** the model reads nutrition only through the consented `get_health` reader. Each of four read signals is a day's
  sum: `food_energy` in kcal, and `protein`, `carbs` and `fat` in grams. The output is turn-only, as for every `get_health`
  result.
  - A macro is given for a day only when every entry that day carries it, so a partial sum never reads as the day's total.
  - The onboarding (welcome) read of the owner's health leaves nutrition out. Its output becomes what Waldo knows, and food
    is never compiled into memory.
- **The numeric health floor** recognises a food reading said of the owner or of a day ("you logged 1,202 kcal", "your
  protein was 61 g", "protein intake 120 g", "61 g protein yesterday"). A relayed reading is withheld from traces, and a
  stored summary that holds one is dropped, like any other reading.
  - Grams on a label, in a recipe or in someone else's meal ("25 g protein per serving", "the dog ate 200 calories") are
    not a reading. The floor favours precision: a false match drops a whole task result.
  - A bare macro with no owner or day framing ("61 g protein") is not caught.
- **No derived use:** no score, driver, Load or trigger reads nutrition.
- **Tone:** the reader's description tells the model that food is context for a plan, never a judgement of what the owner ate.

### 3. Sources

Nutrition arrives from the phone transports Waldo already reads (HealthKit, Health Connect, Samsung Health), under their
existing consent. The 27 October rule still holds: Health Connect is a transport, and a writer other than Samsung Health is
`candidate_unaccepted` for scores. Nutrition feeds no score, so the rule changes nothing here.

### 4. Older builds and older backends

- A build below revision 7 never sends a food entry.
- A backend that does not know the signal rejects the reading alone, from revision 3 onwards (per-sample).

## Rollback

Revert the PR, and remove the stored entries before restoring the earlier signal check. The old check is validated, so it
fails while any `nutrition` row exists. A rollback migration deletes `signal = 'nutrition'` from `waldo.health_samples` first,
then re-creates `health_ingest` and `health_series_read` from `20261031120000`.

## Not covered

- Direct food-app APIs. MyFitnessPal accepts no new API developers (`docs/research/HEALTH_IMPORT_SOURCES_2026-11-06.md`).
- Blood glucose with meal context, which stays in the 31 October amendment's §5 (sensitive readings).
- The phone app's HealthKit and Health Connect mapping, which ships in waldo-app against this contract.
