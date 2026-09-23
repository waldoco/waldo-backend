# Spots, Constellations, Fetch and score derivations (2026-09-23)

Owner direction, 2026-09-23 17:49 IST (WhatsApp). This doc turns it into a design and a derivation worksheet for his reading pass. Nothing here is built yet.

## 1. The concept, in the owner's words

- **Spots** are the short-term layer. They cover small pattern recognition, recent events and understandings, short-term memories, and goals Waldo optimizes around and reasons with. They accumulate continuously. Brand root: Waldo is a Dalmatian, and spots are observations (waldo-brain vocabulary: "Promote recurring spots → patterns").
- **Constellations** are the long-term layer. They hold patterns and behavior Waldo keeps mapping, matching and updating across every part of the user's life, personal and health. They are the proper long-term memory about the user.
- **Why both are visible:** the user and the agent see the same data. That shared view is what builds trust and keeps privacy honest. Constellations are drawn as a directed graph (nodes and edges). Spots are drawn as small learnings and memories.
- **Fetch** is Waldo's proactive signal, branded. Waldo sweeps everything connected across work and personal life, reasons over what it finds, and speaks up when it matters.

## 2. What exists today (beta-mvp runtime)

| Piece | Today | Role in the new model |
|---|---|---|
| Episode index (FTS5, `search_episodes`) | Every turn indexed; nightly consolidation | Raw evidence that Spots cite |
| Core memory files (`MEMORY_CORE`, `MEMORY_GOALS`, `MEMORY_FOLLOWUPS`, `intelligence-summary`) | Model-edited, revisioned, never records an inferred diagnosis | These become typed Spots and Constellation nodes. `intelligence-summary` is the seed of the constellation layer |
| Ledger (approvals, reminders, actions) | Shown in cards and `/ledger` | Activity; a source of spots ("you moved 3 meetings this week") |
| Update cards (7e958f5) | Calendar and mail change sweep; the model decides whether to send | **First Fetch mechanism.** Rename them to Fetch when the app surface lands |
| Day plan (91cad99) | Model-planned card times | Uses routine Spots and Constellations as input |

## 3. Proposed data model (new Supabase, per the owner's ruling)

**Spot** (short-term, many per week)
- `id`, `user_id`, `kind` (observation / pattern / goal / event / preference / health), `text` (one plain sentence)
- `evidence[]`: references to episodes, calendar events, mail ids, health windows
- `confidence`, `created_at`, `last_seen_at`, `seen_count`
- `status`: active / promoted / dismissed / corrected / forgotten
- `source`: agent-inferred or user-stated. Only user-stated spots count as facts about the user; inferred ones are labeled as inference.

**Constellation node** (long-term)
- `id`, `user_id`, `domain` (sleep, energy, work rhythm, relationships, stress, training, food, …), `label`, `summary`
- `strength`, `first_seen`, `last_confirmed`, `supporting_spots[]`

**Constellation edge**
- `from`, `to`, `relation` (tends to precede / worsens / improves / co-occurs with), `evidence_count`, `strength`
- Example: "late calls → short sleep → low-energy mornings".

### Lifecycle
1. **Spot creation.** On each turn (the memory updater already runs) and on every Fetch sweep, the model may emit spots with evidence. It works under bounded judgment: instructions, criteria and boundaries.
2. **Nightly promotion.** The 03:00 run already exists. The model reviews recent spots:
   - a spot seen repeatedly and consistently becomes a node, or strengthens one;
   - co-occurring nodes become an edge;
   - a contradicted spot weakens a node.
3. **Decay.** Nodes nobody has confirmed lately fade. They are never silently deleted; they are marked stale.
4. **User control.** The user can see every spot and node, and can correct, dismiss or forget it. "Forget" purges it along with its derived edges. This is the trust and privacy half of the concept.

### Surfaces
- **App:** a Spots feed (small learnings, newest first, each with a "why I think this" evidence link), a Constellation graph view (nodes by domain, edges with strength; tap for evidence), and a correct/forget control on both.
- **Chat:** "What have you spotted this week?" and "Why do you think that?" answered from the same records.
- **Agent use:** the planner, cards and Fetch read active spots and strong nodes as context, instead of free-text memory only.

## 4. Fetch (the proactive layer)
- Mechanism today: the update-card sweep (calendar changes and mail) every 10 minutes, with model judgment and the Brief-to-Close window as the only hard limit. There is no push cap (owner ruling).
- Next sources, in order: health signals from the app (daytime HRV and recovery shifts), reminders and follow-ups coming due, then deferred connectors.
- A Fetch is always recorded, even when it isn't pushed, and folds into the next main card.
- A Fetch can create a Spot, and repeated Fetch patterns feed Constellations.

## 5. Made-up scores: derivation worksheet (for the owner)
Rule: a score ships only when every input is real and named, and the UI can show its drivers. Otherwise it degrades to "not enough data".

| Score | Honest inputs available | Candidate derivation | Open questions |
|---|---|---|---|
| **Form** (daily capacity) | Overnight HRV (RMSSD from iOS 27, else SDNN) vs personal baseline; resting HR vs baseline; sleep duration, consistency and interruptions; recent training load (workouts, zones) | Weighted z-scores against a 14-30 day personal baseline. ADR-0081 weights Sleep; the app's `canonical.ts` weights Recovery, and this mismatch needs fixing | Weights per ADR-0081; minimum days before showing; how to treat SDNN to RMSSD switch |
| **Recovery** | Overnight RMSSD/SDNN, resting HR, respiratory rate, wrist temperature deviation | Baseline-relative composite; shows drivers | Whether Recovery is a separate score or a Form driver |
| **Sleep** | Sleep stages, duration, bedtime/wake consistency, awake periods | Own 0-100, using Apple's documented inputs (duration, consistency, interruptions) since Apple's sleep score isn't readable | Chronotype adjustment from onboarding |
| **Signal Pressure** | Calendar density (meeting hours, back-to-back runs, no-gap blocks), unread primary mail needing reply, overdue follow-ups | Load today vs the user's typical load, from their own history | Is this "work load" or "all incoming demand"? Name may change |
| **Task Pileup** | Open follow-ups, overdue reminders, Google Tasks (scope granted), mail threads awaiting the user | Count and age of open loops, weighted by due date | Needs Tasks/mail read in the sweep; which loops count |
| **Mind State** | User's own check-ins ("how do you actually feel"), language in chat, daytime HRV shifts | **Do not score it without a self-report.** Show as a labeled read ("you said you're stretched; HRV agrees") | Ethics and consent; stays a ghost until self-report exists |
| **Weight** | HealthKit body mass | A trend only (7-day smoothed), shown as context, never a goal | Whether to show it at all by default |

## 6. Clinical questions (owner ruling: advise and redirect, don't hard-block)
- Waldo answers basic health and clinical questions with general information. It adds a clear notice ("I'm not a doctor; this is general information") and recommends seeing a physician. It points out when something sounds urgent.
- Current runtime: `scribe/medical-gate.ts` halts any reply containing a medication or dose instruction (pattern matching). To change it:
  - replace the halt with advise-and-redirect: the reply goes out with the notice and a physician redirect;
  - keep the model's instructions: never give a personal dose or tell the user to start, stop or change a medication; explain options generally instead.
  - This change is queued in the build (see the gap doc, section 9).

## 7. Wearables priority (owner)
Get these right first:
1. Apple HealthKit (Apple Watch)
2. Android Health Connect
3. Samsung wearables (through Health Connect or the Samsung Health Data SDK)
4. WHOOP (its own API)

Oura, Ultrahuman and others come later.
