# Waldo's design system, the agent, and generative UI

Status: **proposed**, for the owner's review. It is a companion to
[PROACTIVE_AGENT_RUNTIME_2026-11-03.md](PROACTIVE_AGENT_RUNTIME_2026-11-03.md).

Sources:
- the Waldo design system artifact (https://claude.ai/artifact/7wKJuF255GspDEBR643qNS, version 1793685261-fdce), sections
  B01, B04, B12, B13 and B14 and the README;
- source at `beta-mvp` 270d9740.

Claims are tagged [verified], [inference] or [proposed].

## 1. What the design system says Waldo is

- **He acts, and every action is legible.** "Waldo's value is that he acts. His trust comes from making every action legible:
  what he's allowed to do, what he wants to do, what he did, and how to undo it." (B14)
- **Permission in three steps:**
  - "Just tell me things";
  - "Suggest, and let me approve" (the default);
  - "Handle routine changes": reversible changes to the person's own things, within limits, with a receipt.

  This is #1630's grant model, in the words the app should show.
- **Needs You explains before it asks.** The card gives, in order: the exact operation, the exact change, why now, what
  happens if you approve, what happens if you don't (the safe default), what it is based on, when it expires, then the
  actions.
- **Receipts have an Undo window.** "Waldo did a thing." plus the change.
- **States are never collapsed:** proposed, scheduled, sent, acknowledged, confirmed, verified, accepted, plus unconfirmed.
- **Home is an authored sequence:** the Brief, then "Waldo is carrying" (Outcomes), then Needs you, then open loops, then
  capture. A section with nothing real to say disappears.
- **Data explains a decision; it is not a dashboard.** (B12)
  - Three depths: meaning, explanation, evidence.
  - Personal baselines only. Missing is absence, never zero.
  - Honest scales. Name the window. Freshness on every derived number. No confidence numbers.
  - A fixed chart catalogue: MetricTile, Sparkline with band, BarsOverTime, SleepStages, ContributionBar; Form is shown as
    rings (B5-16).
- **Voice: warm, then quiet authority, then a dry line once.** (B13)
  - The reason is always given. No self-congratulation. The way out is always offered. Silence is the default.
  - The Brief is the one thing that matters, with one proposal.

## 2. Where the agent and backend differ today

| Design system | Today | Tag | Who decides or builds |
|---|---|---|---|
| Greeting "Good morning", not "Morning" (B13 rule 5) | The prompt says the opposite: "the greeting is 'Morning.' Never 'Good morning'" (`prompt/messaging-behavior.ts:22`). This morning's Brief opened "Morning, Shivansh." | verified | **Owner** |
| "The Brief never pushes"; at most three pushes a day | The runtime sends an Expo push for the Brief (`channels/owner-do.ts`, day cards). The site promises one 6:30 notification | verified | **Owner** (a conflict already noted on 11 Oct) |
| Needs You anatomy: why now, if you approve, if you don't, based on, expiry | The approval part carries `review`, `question`, `labels` and `expires_at` (`contracts/src/app/parts.ts`). There are no structured why-now, consequence or safe-default fields. "Based on" arrives with #1846's `why` | verified | Backend, then app |
| Seven lifecycle words, plus unconfirmed | The receipt part's `outcome` is `accepted`, `failed` or `unconfirmed` only | verified | Backend (additive), then app |
| "Waldo is carrying": Outcomes with who moves next and when Waldo checks | No Outcome model in the runtime or the contracts | verified | Runtime doc §4.6, then this |
| Charts from the catalogue, explaining a decision | A generic `chart_series` part exists in `parts.ts`, but nothing in the runtime emits it. The site promises "Charts in replies" | verified | Backend, then app (§3) |
| Three permission levels in the person's words | #1630 grants; the app has no level control yet | verified | Autonomy lane plus app A1–A3 |
| Android font | The system lists only SF Pro Rounded. The owner ruled on 3 Nov for a Nunito-like open font on Android, which is not recorded in the system | verified | waldo-brain design PR (Suyash) |
| Dark only (A-25) | Not checked in waldo-app for this note | unverified | App |

## 3. Generative UI [proposed]

The goal is the flexibility of Claude's chat: charts, rich cards and images in a reply, and a live working state, without
breaking the design system or the privacy rules.

### 3.1 Declarative components, rendered natively

- **The agent emits data that names a component from Waldo's catalogue,** and the client renders it with its own native
  component. It never emits HTML or JavaScript for the app.
  - This is the approach of Google's A2UI ("UI as data, not code", Dec 2025). It keeps the client in control of rendering and
    avoids executing model output (security checklist: no model output into `innerHTML`).
- **A new additive reply part, `component`:**
  - `{ type: 'component', component, props, fallback_text }`;
  - `component` is a closed enum;
  - `props` is a Zod schema per component in `packages/contracts`.
  - Every part keeps `fallback_text`, as today, so WhatsApp, iMessage and email show a sentence instead.
- **First catalogue:** MetricTile, Sparkline, BarsOverTime, SleepStages, ContributionBar, FormRings, ChangePreview,
  SourceCard, ScheduleRow and ChoiceChips. These already exist in the design system's component set, so the app has a
  spec for each.

### 3.2 Health charts are filled by the server, not typed by the model

- **The model names the metric, the window and the comparison;** for example, "HRV, last 14 nights, against your usual".
- **The runtime fills the rest** from the Supabase health plane: the points, the baseline band, the gaps for missing nights,
  and the freshness.
- **This enforces B12's rules by construction:**
  - no invented values;
  - missing stays absence;
  - honest scales;
  - the window is named;
  - the client renders and never computes.
- **Privacy:** the readings never pass through model output, so they stay out of trace text on this path.
  - The owner's 22 Oct ruling already allows the owner's health on the owner's own screens.
  - The chart reaches only the owner's app and console. Its fallback for other surfaces is a derived sentence.

### 3.3 One `show` tool, offered on every turn

- Showing something is harmless, so the tool is core and offered on every turn, owner and job alike: the "propose
  everywhere" principle.
- The model decides when a chart helps a decision, per B12. There is no rule like "always show a chart for health".

### 3.4 AG-UI as the live transport for app and console

- **Map the runtime's turn onto AG-UI's event types:**
  - `RunStarted`, `RunFinished` and `RunError` for the turn;
  - `TextMessageStart`, `TextMessageContent` and `TextMessageEnd` for streaming, which replaces the custom
    `WALDO_STREAM_REPLIES` draft;
  - `ToolCallStart` and `ToolCallEnd` for the design system's working line ("Checking your last 7 nights…" beside the
    SpotLoader, B5-11);
  - `ActivitySnapshot` and `ActivityDelta` for background task progress (the runtime doc's §4.5 task surface);
  - `StateSnapshot` and `StateDelta` (RFC 6902 JSON Patch) for Home's sections, so the Brief, Needs you and carrying
    update live;
  - `Custom` for components and approval cards. A2UI lists AG-UI as a transport.
- **Contracts:**
  - This is a new additive released contract at the app edge; `app.v1` keeps its semantics.
  - WhatsApp and iMessage keep taking the whole reply.
  - React Native client support for AG-UI is unverified; check it before committing the app half.

### 3.5 Images

- An `image` tool makes an image with an image model and returns it as a file part.
- **Style follows the design system's imagery:** halftone spots, which is beta (A01).
- **Egress:**
  - the provider must meet the consent, DPA and no-retention policy;
  - the image prompt carries no health values or third-party names unless the owner asks for that image.
- **Lowest priority.** It needs the owner's choice of provider and budget.

## 4. Order

1. **Owner decisions:**
   - the greeting;
   - the Brief push against the site's 6:30 notification;
   - whether to build images, and with which provider.
2. **Backend:**
   - the `component` part and catalogue contract, with health data bound by the server, plus the `show` tool;
   - structured Needs You fields on proposals (why now, if you approve, if you don't);
   - the lifecycle words on receipts.

   The gate allocates the revisions (next free: approvals 9, controls 15).
3. **App:**
   - render the catalogue natively;
   - the Needs You anatomy and Home's order;
   - the AG-UI client;
   - the permission-level control from #1630.
4. **waldo-brain design system PR** (Suyash's review):
   - record the Android font;
   - the three levels mapped onto grants;
   - the `component` part and the AG-UI states.
