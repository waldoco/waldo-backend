# Competitor deep dive: minimi (Shram Intelligence) vs Waldo (2026-09-24)

Owner ask: reverse-engineer projectminimi.com, map against Waldo, and connect to the Kennel plugin model + a transportable memory layer. Sources inline; everything not from a public artifact is labeled INFERENCE.

## 1. What it is (verified)

minimi is a Mac-only background app by Shram Intelligence, Inc. (Delaware). Three Product Hunt launches: Shram (Jul 2024), Shram 2.0 (Feb 2025), minimi (Jun 5, 2026 - #2 of the day, ~494 upvotes, 118 comments, 7 reviews at 5.0). Sources: producthunt.com/products/shram, projectminimi.com.

Product shape:
- **Passive capture**: reads what's on screen via Apple's accessibility infrastructure - explicitly no screenshots - plus what you hear/say. "Works out of the box, no integrations" - WhatsApp, Gmail, Calendar captured by watching the apps, not by API.
- **On-device memory**: memories stored as embeddings in a local vector database on the Mac; "no cloud database", "we don't retain your data or train on it" (their marketing claim, not audited).
- **minimi MCP**: "a digital pendrive" - copy an MCP link into any LLM's custom connector (ChatGPT, Claude, Gemini) or harness (they name OpenClaw, Hermes) and the model queries your memory. This is their transportable-memory play.
- **Cats as the interface**: Cotton (captures context), Melody (finds and closes open loops automatically - "traces your decisions, resolves closed loops without manual effort"). More cats "up for adoption". The site frames the whole product as "AI cat that closes your open loops".
- **Team brain** (/brain page): add teammates' MCP links and Claude answers across everyone's work - "who's blocked", "who talked to a customer today".
- **Benchmark claim**: 54% on BEAM ("ICLR 2026 benchmark for long-term memory") vs LIGHT at 36% - "50% more accurate than previous SOTA". Self-reported, on their marketing page.

## 2. How it likely works (INFERENCE - labeled)

- **Capture pipeline**: accessibility APIs yield a text/element stream; that gets chunked, embedded on-device, and stored in a local vector DB. The "see, hear or speak" claim implies mic/audio transcription too (INFERENCE: likely on-device Whisper-class STT given the privacy posture; unverified).
- **Structuring**: raw embeddings alone can't answer "what did I promise to send by Friday" well. INFERENCE: an LLM pass distills captured chunks into structured memories (promises, decisions, tasks) - which means either a local model or cloud LLM calls, which sits in tension with "nothing leaves the Mac" unless distillation is on-device. Their docs don't say; treat as unknown.
- **MCP link**: "copy the MCP link and paste it in your LLM's custom connector" implies a hosted MCP endpoint per user (local MCP servers don't have shareable links). INFERENCE: a relay that forwards MCP tool calls to the Mac app, with a per-user token. That means query text transits their servers even if storage doesn't - a privacy nuance their marketing glosses.
- **Melody's loop-closing**: "resolves closed loops without manual effort" - INFERENCE: periodic agent pass over open loops + recent context, marking loops closed when evidence appears (e.g. the promised email got sent). Whether it *acts* (sends, books) or only *tracks* is unclear; the site demos read as tracking + nudging, not actuation.
- **Cats**: personas over the same memory store - Cotton is the capture/query layer, Melody the loop-closure agent. Packaging, not separate systems (INFERENCE).

## 3. Minimi vs Waldo

| Axis | minimi | Waldo |
|---|---|---|
| Capture | Ambient, zero-setup, screen+audio on Mac | Explicit: chat, Telegram/WhatsApp, Google APIs, web fetch |
| Memory | Opaque embeddings, vector search | Typed claims with provenance (stated/confirmed/inferred), correctable, forgettable |
| Transport | MCP link into any LLM (their strongest idea) | None yet - this is the gap the owner named |
| Action | Tracks/nudges loops (appears not to act) | Acts: reminders, calendar, mail, cards, open loops with handoffs |
| Surface | Mac tray + your LLM of choice | The messaging apps people already live in |
| Privacy | On-device storage (marketing claim) | Vault-only tokens, no-token-to-model hard line, owner-controlled |
| Team | Shared MCP links ("company brain") | Single-owner beta by design |
| Proof | Public BEAM number (self-reported) | W7 eval suite, private |

## 4. Where we're ahead, what to adopt

**Ahead**: actuation (we do things, they recall things); memory you can interrogate and correct (a claim says why it believes something; an embedding can't); channel-native (no install, works from a phone); the consent/vault model; health-domain depth; safety evals.

**Adopt**:
1. **Memory as an MCP server** - their one genuinely better idea, and exactly the owner's "canal + plugin + transportable memory" ask. Waldo's memory exposed as an MCP endpoint means any LLM/harness can plug into the owner's memory, and it positions memory as our portable asset. Design in section 5.
2. **Public benchmark discipline** - run our memory layer on BEAM (or LoCoMo) and publish a number. It turns "our memory is principled" into a comparable claim.
3. **The packaging lesson** - "adopt a cat" is a simpler mental model than our current vocabulary. Not a copy; a reminder that the interface metaphor sells the architecture.
4. **Zero-setup framing** - their capture requires no integrations because it watches the screen. We can't and shouldn't do that server-side; our equivalent is meeting users inside WhatsApp with no app install. Already the plan.

**Deliberately skip**: ambient screen/audio capture (wrong platform and wrong privacy posture for us), Mac-only surface, team-brain multi-tenant memory (post-beta question).

## 5. Kennel connection: plugin model + transportable memory

Kennel (waldoco/Waldo-Kennel, K0 map in KENNEL_K0_SOURCE_MAP.md) is where this lands. Proposal:

- **Memory-MCP plugin**: a Kennel plugin that serves Waldo's claims memory over MCP - tools: search_claims, open_loops, recent_context; resources scoped per-owner; auth via vault-issued tokens. Because claims are typed and provenance-graded (stated/confirmed/inferred), the MCP surface can filter: an external LLM gets stated+confirmed by default, inferred only marked as such. That is a *better* transportable memory than minimi's embeddings - it travels with its reasons.
- **Channels as plugins**: telegram today, whatsapp next, console after - each a Kennel plugin against one runtime, so memory and loops follow the owner across surfaces (the session/cross-verification design already in CACHE_SESSION_CONTEXT_DESIGN_2026-09-24.md).
- **Tools as plugins**: search (Brave), voice (Smallest AI), google connector - already seams in code; Kennel formalizes them.
- Sequencing: keys land -> combined e2e -> model pick -> eval fixes -> then memory-MCP as the first Kennel-built plugin, because it is both the owner's ask and the clearest competitive counter.

## 6. Landscape: who's live, and our edge (competitive read)

Live in adjacent space: **minimi** (ambient Mac memory + MCP), **Limitless** (rewind pendant + app), **Screenpipe** (open-source screen/pipe memory), **Pieces** (developer workflow memory), **Granola** (meeting memory), plus memory-infra players (**mem0**, **Letta**, **supermemory**) selling the layer itself. Everyone is racing to own "memory for AI"; almost nobody closes the loop with action in the owner's real life.

Our edge: Waldo is not a recall layer with a chat window - it's an agent that remembers *and then does*: holds commitments, fires reminders, books, drafts, and reports back, inside the messaging apps the owner already uses, with a memory that knows why it believes what it believes. The defensible pairing is provenance-graded memory + actuation. minimi validates the demand and the memory-as-platform thesis; it doesn't touch actuation.

Sources: projectminimi.com (+/mcp, /brain), producthunt.com/products/shram, linkedin launch posts by the Shram team, huntscreens.com/products/minimi. All traffic/product claims are their marketing numbers, unverified.
