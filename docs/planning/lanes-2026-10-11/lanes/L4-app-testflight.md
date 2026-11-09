# L4: the app, a TestFlight build for real-device testing

**Owner:** the existing session "Take over waldo-app PR #16 in slices". Repo: `waldoco/waldo-app`. It is the only writer of `src/agent/**`.

## Target (owner, 11 Oct)

One iOS build, handed to Suyash, who has an iPhone and an Apple Watch. He runs the real-device tests and evolves the design and screens.

- **Every website promise is present and working at a basic level**, on a basic, consistent design language.
- **Where the backend does not serve something yet, show an honest "not yet" state.** No fake data, as the lane already does.
- **Signing and the TestFlight upload are owner actions.**

## Queue

1. **A device-ready build now**, with what already works: sign-in, chat, history, the schedule settings, the Watch app.
   - Prepare the 17-step iPhone checklist from waldo-app #21 for Suyash. That checklist is the ledger's Wave 0 exit.
2. **Health:**
   - the consent screen (two separate agreements, `storage_compute` and `model_processing`; the owner decides whether the first screen asks for both);
   - the native hourly reader;
   - an ingest client against H3, once L1 has deployed it;
   - backfill upload;
   - the Recovery screen.
   - Then sleep debt, Form, Weight and history, as L1 serves them.
3. **Connections:** the Google connect screen through the backend route (L3 G1). Remove the legacy `oauth-google` path in `src/agent/agentClient.ts`.
4. **Approvals screen** once L3's piece A is served, with the full review and approvable in the app.
5. **"Deliver to" setting** (L3), and push registration once L2's S7 is served.
6. **Threads UI** (app and console only) once L3's contract lands.
7. **Replace each `UnavailableFeature` placeholder** with a basic real screen as its backend route becomes available: brief, patrol, spots, constellations, connectors, gallery, health, health-data.

## Rules

- **Build only on served contracts.** Re-pin the six contract files from L3's merges, byte for byte.
- **Prove on a device, not only in Node or the Simulator.** The Node harness hid the controls 400 that #37 fixed.
- **Tell the backend lanes on #116** what the app needs next. Peer messages get dropped.
