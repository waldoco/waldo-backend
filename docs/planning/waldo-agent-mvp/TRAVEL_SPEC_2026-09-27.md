# Waldo Travel Lane - Flights Trio Spec (owner verification draft)

From the muse tier-1 adoption list (owner feed 2026-09-27 9:56am: shopping + plaid first - folded into PAYMENTS_DESIGN_2026-09-27.md; "travel trio second"; voice cluster per the post-alpha plan). The trio: **travel-planning workflow** + **Duffel** (flight search/booking) + **FlightAware AeroAPI** (live status + alerts). This is the flights lane end to end, in the house stage pattern (P1/T1 read-only before any spend).

## Grounded reference points (fetched 2026-09-27)

- Duffel API docs: https://duffel.com/docs/api/overview - airline offer search, orders, seat maps; has a test mode. Shape: offer request -> offers -> order creation.
- FlightAware AeroAPI: https://www.flightaware.com/commercial/aeroapi/ - 60+ REST endpoints for flight status/tracks, usage-based pricing, real-time flight alerts (departure, arrival, cancel, divert, holds), tiers Personal vs Standard (Personal restricts storage/distribution of derivative works to personal/academic use - the tier choice is an owner decision, flagged not guessed).

## Invariants (same discipline as the payments spec)

1. Booking is wallet-bearing. Every booking is owner-confirmed at the final state: itinerary (carrier, flight numbers, times, layovers), passenger details, total, fare conditions (refund/change cost = the undo cost), presented before commit. Per-shape earned grants only by explicit owner words, one shape at a time.
2. Card data never enters model context, traces, episodes, or logs. Payment rides the payments lane's rail decision (P2 owner-completes first; P3 vault-held/single-use numbers when that lands) - the travel lane does not invent its own card handling.
3. Provider data is external content: schedules, prices, seat maps and alert payloads are quoted, capped, and never fed back as authority. Alert webhooks verify before they route (A8 event-ingress shape).
4. Every search/booking attempt receipts: route, dates, carrier count, price at quote time, outcome, obstacle tag. No receipt, no claim. A quoted fare is a point-in-time offer - copy says so, and the confirmation step re-prices.
5. User-facing error copy never names a provider or model. "Flight search is having trouble" not "Duffel 502".

## Stages

T1 - Search and track, no spend (no keys beyond status data):
- Flight search: owner says "Blr to Goa next weekend, morning" -> offer request -> 3-5 honest options (times, layovers, total, fare brand), cheapest-passing presentation with no ranking games.
- Trip capture: a booked flight (forwarded confirmation mail or owner-stated) becomes a tracked trip with the usual open-loop treatment.
- Live status: AeroAPI status/track lookups for tracked flights; day-card line on travel days ("AI 504 on time, gate closes 8:40").
- Alerts: AeroAPI alert webhook -> /events/flightaware (A8 ingress, token verification) -> background run + Telegram note for departure/arrival/cancel/divert on tracked flights. Notify only what matters; no alert storms.

T2 - Booking under confirmation:
- Duffel order creation behind the invariant-1 confirmation gate. Passenger profile (name, DOB, known-traveler details) held as vault-style owner data, confirmed per booking.
- Seat selection and add-ons presented as priced options, never bundled silently.
- Payment follows the payments lane: owner-completes (P2) until the agentic rail (P3) exists.

T3 - Disruption and planning intelligence:
- Cancel/delay alerts become proposals: "your 6pm is cancelled - earliest rebook is 8:15pm (+Rs 2,300) or tomorrow 6am. Do it / Modify / Not now."
- Travel-planning workflow: multi-leg trips assembled as one plan (flights + ground buffers + calendar holds), checked against Load and the schedule slope from the dashboard ontology - a packed week gets an honest "this is a heavy trip on a heavy week" aside, not cheerleading.
- Check-in windows tracked with reminders at the right moment; boarding-pass capture when the airline mails it.

## Where it lands in the product

Day cards (travel-day line), the brief (upcoming trips), open loops/handoffs (a search the owner asked Waldo to run, a rebook proposal waiting on him), console (tracked trips list, receipts).

## Ops asks (owner decisions)

- DUFFEL_ACCESS_TOKEN (worker secret; test mode first, live when booking ships). Duffel account creation is an owner action.
- FLIGHTAWARE_API_KEY (worker secret) + AeroAPI tier pick (Personal vs Standard - storage/distribution terms differ; product use argues Standard, cost says start Personal and upgrade before beta users).
- WALDO_EVENT_SOURCES gains a "flightaware" source entry (token verify) when T1 alerts ship.
- Booking authority: per-booking confirmation always; any earned-grant shape (e.g. "rebook same-day under Rs 5k without asking") only by his explicit words, enforced worker-side fail-closed.

## Open owner decisions

1. Duffel account + token (test now, live at T2).
2. AeroAPI tier: Personal to start vs Standard from day one.
3. Passenger profile fields Waldo may hold (name/DOB/KTN) and where (vault-style store, worker-side only).
4. Earned-grant appetite for rebooking under a cap (default: never without asking).
5. India-first carriers/fares: any preferred airlines, fare brands, or home airports to seed the profile (BLR home base assumed from context - confirm).
