# Errands parity set

These are twenty everyday tasks that Waldo's general-assistant waves are judged on. They come from three sources:

- the [agent build plan](https://claude.ai/artifact/MGDBPSqzWQibPfCVvCqzY3)'s ten core jobs and India pack;
- the [health wedge](https://claude.ai/artifact/V5cYvfv58wZfFB4EcmDExm)'s care loop;
- the bar Instinct and Muse set, including the 14 October hotel test.

The source of truth is `packages/runtime/evals/nightly/errands.ts`. The table below is generated from it by `errandsTable()`, and `test/nightly-eval-errands.test.ts` fails if this doc drifts. To change the table, edit the code and paste the new output.

## What each errand carries

- **Inputs:** what the owner says and what the synthetic world holds.
- **Expected trace:** the tools a good run calls, in a plausible order, and what any approval card must show. The trace is a guide for reading a run, not a pass criterion, because the model may take another sensible path.
- **Pass criteria:** these are read from receipts, meaning the effect log, the final state and each message's surface. Each runnable errand's receipts are code (`receipts.ts`) and must hold on every graded trial, alongside the outcome judge's rubric. Criteria marked "Judge:" are checked by the rubric, not by code.
- **Competitor columns:** filled by hand from a manual run of the same input on Instinct and on Muse. Every cell reads "not run" until someone runs it.

## Runs

Thirteen errands run nightly in the isolated world. They are `x01` to `x13` in the catalogue. The recorded gate's floor rises from 36 to 49 to cover them.

The other seven need something the isolated world cannot provide: a browser, a booking or commerce partner, a per-market payment hand-off, or a live account. They are listed below as "later" with the reason. Each one becomes a nightly case when its rung exists. `x14`, the live half of the hotel test, is the browser rung's first case.

The 14 October hotel test failed because Waldo asked for what it could look up and did not finish the comparison. `x11` is its runnable half: three search listings, one of which meets every constraint. Its rubric fails any question about details the owner already gave.

## Running a competitor manually

1. Use a fresh test account on the competitor, never the owner's.
2. Recreate the inputs with the same synthetic mail, calendar or listings. Forwarding synthetic mail to the test account is fine.
3. Send the owner line exactly as written.
4. Grade the result against the "Pass from receipts" column, using what the product actually did: drafts, sends, calendar entries, bookings. What it said it did does not count.
5. Record `pass`, `partial`, `fail` or `not offered` in `errands.ts`, then regenerate this table. Put the date and product version in the PR that records it.

## The set

| Id | Errand | Source | Runs | Expected trace | Pass from receipts | Instinct | Muse |
| --- | --- | --- | --- | --- | --- | --- | --- |
| x01-inbox-triage | What needs a reply | Core job 3: inbox triage | nightly | get_communication, read_thread | No draft, no send card; Judge: names Arjun (clause 7, by tomorrow) and Sara (offsite numbers, by Friday) and nothing else as needing a reply | not run | not run |
| x02-triage-and-draft | Draft the replies | Core jobs 3 and 4: triage, then drafts that send on approval | nightly | get_communication, read_thread, draft_email, draft_email | Exactly two drafts, one to arjun@kestrel.example and one to sara@northwind.example; No send card | not run | not run |
| x03-reschedule-short-night | Reschedule around a short night | Core jobs 2 and 5; health wedge: replan a depleted day | nightly | query_calendar, query_availability, propose_calendar_change. Card: Move "Deep work: strategy doc" (dw-deep) to a free 90 minutes later today; reason in a few words; waits for approval | One move card for dw-deep, later today, overlapping no other event | not run | not run |
| x04-meeting-prep | Meeting prep | Core job 6: meeting prep from calendar and threads | nightly | query_calendar, search_communication, read_thread | No draft, no send, no calendar change; Judge: the three agenda items and the open ask, from the thread | not run | not run |
| x05-follow-up-chase | Chase a quiet thread | Core job 7: follow-ups from email commitments | nightly | search_communication, read_thread, draft_email. Card: A reply in the same thread to sales@vendor.example, if it raises a send card instead | A draft or send card to sales@vendor.example, and nothing to anyone else | not run | not run |
| x06-promises-this-week | Don't let me drop a promise | Core job 7: reminders from email commitments | nightly | search_communication, read_thread, set_reminder | A reminder or open loop due on or before 1 October; No mail sent or drafted | not run | not run |
| x07-bill-radar | Bills coming up | Core job 8: bill radar; India pack 1: dues radar | nightly | search_communication, read_thread | No draft, send or payment; Judge: both unpaid bills with due dates and amounts; the paid one left out or marked paid | not run | not run |
| x08-renewal-radar | An auto-renewal about to bite | Core job 8: subscription radar; India pack 2: mandate audit | nightly | search_communication, read_thread | Any reminder it sets is before 29 September; No mail | not run | not run |
| x09-refill-from-mail | When to reorder a prescription | Core job 10: health-admin radar; India pack 3; health wedge care loop | nightly | search_communication, read_thread, set_reminder | One reminder between 26 September and 3 October; No dose or tablet count in any reply; No mail | not run | not run |
| x10-appointment-admin | An appointment and its fasting note | Core job 10: appointment confirmations; health wedge: fasting tests in the day plan | nightly | search_communication, read_thread, propose_calendar_change, set_reminder. Card: Create "Blood test" 29 September 08:30, owner time; waits for approval | One create card starting 29 September 08:30; One reminder on 28 September before 22:00 | not run | not run |
| x11-hotel-research | Hotel research, the 14 October test | Instinct and Muse bar; the 14 October hotel test Waldo failed | nightly | web_search | No booking, no mail, no card; Judge: recommends the one listing that meets all three constraints, names the source, says the rate is unchecked on the booking page | not run | not run |
| x12-deliveries-and-returns | What is arriving or due back | Core job 9: package tracking and return windows; India pack 6 | nightly | search_communication, read_thread | No mail, no card; Judge: the delivery today and the 30 September return deadline | not run | not run |
| x13-offer-times | Offer someone two times | Core job 5: scheduling by free/busy and email | nightly | search_communication, query_availability, draft_email. Card: If a send card: to arjun@kestrel.example, two specific free hours next week | A draft or send card to arjun@kestrel.example; No calendar event before Arjun picks | not run | not run |
| x14-hotel-live-rate | Hotel rate checked on the booking page | The 14 October hotel test: the live half | later: Needs the browser rung and live pages; browser work is on hold while the team redrafts. | web_search, browse_page | Every quoted rate traces to a page read in the trace; No booking | not run | not run |
| x15-cancel-subscription | Cancel a subscription | Core job 8: cancellation as a guided handoff; Instinct and Muse bar | later: Needs a browser and a live merchant account; the build plan defers cancellation execution until the browser rung or a partner. | search_communication, browse_page. Card: The cancellation step, the merchant, the date and what is lost; waits for approval | A cancellation confirmation from the merchant in the receipts, or an honest handoff with the exact link and steps | not run | not run |
| x16-restaurant-booking | Book a table | Instinct and Muse bar; India pack 8 (Dineout) | later: Partner-gated: needs a booking partner (Dineout MCP, OpenTable) or a browser; t12 covers the honest no-booking answer today. | web_search, call_mcp_tool. Card: Restaurant, party size, time and any deposit; waits for approval | A booking reference from the partner in the receipts | not run | not run |
| x17-pay-a-bill | Pay a bill by hand-off | India pack 1: dues radar with a UPI hand-off | later: Needs the per-market UPI hand-off adapter, which is not built. | search_communication. Card: A UPI intent or the biller's deep link with payee and amount; the owner's PIN is the gate | A hand-off link with the biller and the amount from the bill; nothing paid by Waldo | not run | not run |
| x18-grocery-reorder | Reorder groceries | India pack 8: Instamart reorders | later: Needs the Swiggy Instamart MCP connector with OAuth (C-1 to C-5) and a live account. | call_mcp_tool. Card: Items, total and delivery slot; waits for approval | An order confirmation from the partner after approval | not run | not run |
| x19-doctor-booking | Book a doctor's appointment | Core job 10 deferred half: doctor booking; health wedge care loop | later: Booking is partner-gated or by phone; a drafted request is runnable, but the clinic directory is not in the isolated world. | web_search, draft_email. Card: An appointment request to the clinic, in the owner's voice; waits for approval | A drafted request to a real clinic address found by search, or a booking reference | not run | not run |
| x20-form-fill | Fill a form | Instinct and Muse bar: form filling | later: Needs a browser and a live form; form filling is deferred in the build plan. | browse_page. Card: Every field it will submit; waits for approval | The submitted fields match what the owner approved, with the site's confirmation in the receipts | not run | not run |
