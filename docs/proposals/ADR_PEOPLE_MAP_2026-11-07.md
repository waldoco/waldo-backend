# ADR: the people map, a person record in correctable memory

Status: **accepted under the Wave 2 rule** (owner ruling, 7 Nov 2026, on waldoco/waldo-backend#1980, item B2). It is industry-grade and product-first, and the gate confirms it at review. It is written for B2 and builds it.

It also stands as the short ADR that design §13.6 and waldoco/waldo-backend#1717 (memory slice S9) ask for: the store, the writer, forget and visibility of entities. waldo-brain records it under the next free number.

It extends:
- `WALDO_MEMORY_REDESIGN_2026-10-30.md` §13: entities, with claims as the edges. The owner approved it on 30 Oct.
- What Waldo knows (#1904, controls revision 15), whose claim actions it reuses.
- The forget rules in force: topic forgets, barriers, custody, the purge job, and ADR-0055's partial erasure.

Base: `beta-mvp` `a479cf93`. Every claim below is tagged **[verified]** (read at that SHA), **[inference]** or **[proposed]**.

## The problem

The owner asked for a people map (#1980, B2): rings of people from mail, calendar and chats, with birthdays and last contact. Each person can be confirmed, corrected or forgotten. The relationship-upkeep skill uses the map.

**What exists today [verified]:**
- **No person record anywhere.** A person exists only as words inside claim text, evidence and aliases (`memory/claims.ts:401-423`), filed under the `people` life area (`contracts/src/memory/area.ts:6`).
  - Nothing says that "Priya" in one claim is the Priya of another.
  - "Who do I know at Acme" works only by word overlap.
- **Live reads only:**
  - Google contacts are a live search returning a name and up to 3 addresses (`search_contacts`, `contracts/src/tools/schemas/reads.ts:277-289`).
  - Calendar reads carry attendee names and addresses (`connectors/google.ts:1247-1259`).
  - Mail carries the From header.
  - None of it is kept.
- **No last contact:** no code counts interactions or computes last contact.
- **The nightly source pass** already learns from mail and calendar changes (O9). It may add a claim for "a person or place they deal with regularly". Every claim it adds is origin `untrusted`, so it stays out of turns until the owner confirms it (`memory/claims.ts:1418-1422`, `channels/nightly-sources.ts:36-81`).
- **The relationship-upkeep skill** reads memory, the calendar and mail threads, raises at most 3 people, and never guesses a birthday (`skills/relationship-upkeep/SKILL.md`).
- **Chats:** third parties' chats never reach Waldo. iMessage admits only the owner's direct chat, and WhatsApp is the owner talking to Waldo's number. "Chats" here means what the owner tells Waldo and what they import (B1).

So the map needs a person as one thing, and that is new persistence. Per the repository rules it gets an ADR, not just a commit.

## Decision

### 1. A person is a memory entity, and claims carry everything said about them

There is **no separate people store.** A person is an S9 entity of kind `person`, in the owner's Durable Object, written only by `ClaimStore`, the one writer of claims, nodes, entities and links (§11 of the design). What the map shows is assembled from that entity and the claims linked to it.

| What | Lives in | Written by | Why there |
|---|---|---|---|
| Who the person is: name, other names, area | `entities` row (S9 shape) | `ClaimStore`, from the model's link or the owner's correction | One identity that claims point at; the model decides which entity a name means |
| How close they are: ring `inner`, `close` or `wider` | `entities.ring`, plus `ring_by` (`model` or `owner`) | The owner, in the app (`person.ring`); the owner's choice stands. The chat tool's link does not carry a ring: the owner's tool definitions are at their per-round budget, and the ring is the owner's own call. A later slice may let the model propose one | How close someone is, is the owner's call. A fixed vocabulary of three keeps the map drawable |
| The addresses Waldo knows them by | `entities.addresses`: at most 5 email addresses | The source pass, from an address it saw in mail or the calendar (slice 3). Not a field of the chat tool, which keeps the owner's tool definitions inside their budget | The key for last contact (§3). Identity, not a fact about their life |
| Last contact: when and how | `entities.last_contact_at` and `last_contact_via` (`mail` or `meeting`) | `ClaimStore`, as bookkeeping (§3) | Derived from what the source pass already sees. Not a fact anyone stated |
| Everything said about them: "my sister", "works at Acme", "loves jazz", their birthday | Claims linked through `claim_links` (S9) | Every existing claim writer, unchanged, plus an optional `entities` link | Confirm, correct, forget, origin and validity already work on claims |
| A date that comes round each year: a birthday, an anniversary | `claims.on_date`, `--MM-DD` or `YYYY-MM-DD`, on a claim linked to the person | The claim writer, from a stated or observed date | The app can say "in 5 days" and sort by it. The rule "never guess a birthday" holds: a date is written only with the claim that grounds it |

[proposed] Three additive changes to DO tables and no Supabase migration:
- `entities` and `claim_links`, in S9's shape;
- the people columns on `entities`: `ring`, `ring_by`, `name_by`, `addresses`, `last_contact_at`, `last_contact_via`;
- `claims.on_date`.

Old code ignores all three.

### 2. Where people come from

| Source | How a person is written | Claim origin | Visible in turns | On the map |
|---|---|---|---|---|
| The owner, in chat ("my sister Priya…") | `remember` with `people: [{ ref or name, role, relation? }]`, and `on_date` for a dated claim | `owner` | Yes | Yes, as **yours** |
| An import from another assistant (B1) | `import_memories` carries the same optional `people` (a later change, once B1 merges) | as B1 stores them (`agent`, from the owner's own quotes) | As B1's claims are | Yes, as **Waldo thinks** until confirmed |
| Mail and calendar, via the nightly and daytime source pass | The source pass may link people and their addresses on the claims it adds | `untrusted` | **No**, until the owner confirms (the #1650 fence; S9's rule that an entity is visible only through a visible claim) | Yes, as **Waldo thinks**, with Confirm and Forget |
| Google contacts | **Not ingested.** Looked up live, when the owner asks about someone (`search_contacts`) | — | — | Only once the owner says to keep it |
| Other people's chats | Not available (see the problem) | — | — | — |

**Judgment stays with the model.** It decides who is worth a person record, which ring they belong in, and whether "P." is the Priya already known. Code checks only that:
- a referenced entity exists for this owner;
- the link's claim was admitted;
- a ring is one of the three;
- an address is an address;
- a date is a date.

There is no frequency rule ("emailed 5 times, so inner ring") and no fuzzy name matching.

### 3. Last contact is bookkeeping over what Waldo already sees

The source pass already reads the owner's recorded mail and calendar changes (`update_cards`).

When the source pass applies a batch, `ClaimStore` sets a person's `last_contact_at` to the time of the newest new mail whose From address is one of that person's addresses (`last_contact_via: mail`). The match is the exact address, lower-cased, and nothing else is inferred. An older time never replaces a newer one. Built in slice 3.

[verified] Two limits shape what v1 can say:
- Sent mail is not among the changes: `SENT` is excluded from the mail the update cards record (`connectors/google.ts:1280`).
- Calendar changes keep attendee names and counts, not addresses.

So v1's last contact means **last heard from by mail**, and the app and the model say it that way. Meetings, and mail the owner sent, are later changes to what the cards record, each with its own review. The contract already admits `meeting` for when they come.

### 4. Confirm, correct and forget, per person

The person is the unit the owner acts on. Each action reuses the claim machinery.

- **Confirm** (`person.confirm`) writes one owner-origin claim stating the person as the owner now sees them ("Priya Shah, my sister"), linked as subject.
  - That makes the person visible in turns.
  - It does not ground the untrusted claims behind it one by one.
  - It mirrors `node.confirm` (D5-b, resolved 30 Oct).
- **Correct:**
  - `person.rename` sets `entities.name` with `name_by = owner`; later model writes do not overwrite it.
  - `person.ring` sets the ring with `ring_by = owner`.
  - A relation or a birthday is a claim, so the owner corrects it with the existing `claim.edit` on that claim in the person's detail. It is stored as an owner claim superseding the earlier one, so history keeps what it replaced, as every correction does today.
  - Each runs on the app session's authority, like `node.correct`.
- **Forget** (`person.forget`) removes the person.
  - **What it bars:** every address, and each of their names that no other living person's name contains or is contained in. Forgetting one Priya never bars another Priya, or a "Priya Patel". Such a shared name is not barred: the person's claims still go by id.
  - **What it deletes:** every claim linked to the person, by id and with lineage, as a forget by `claim_ids` does now; then the entity.
  - **A topic forget** takes a person's claims only when the topic is exactly one of their names or addresses. "Acme" never takes the claims about someone with an @acme.com address, and a surname never takes everyone who carries it.
  - **The receipt is honest:** the person's mail and events stay in Gmail and Google Calendar; another person who shares a first name is untouched; backups expire per retention.
  - This keeps forget topic-based (the 25 Oct ruling): the topics are the person's name and addresses, and the claims are selected by their links.
- **Merging two records, or splitting one:** in chat for v1 ("these are the same Priya"). The model re-links through the claim operations; an app action can follow.

### 5. Who sees a person

- **In turns:** S9's rule applies unchanged. A person is in a turn's view only if at least one linked claim is visible there.
  - A person known only from mail is absent until confirmed.
  - In a turn that read outside content, a person linked only through `body` or `mind` claims is hidden.
  - A turn that read outside content may link people to Waldo's own reads, but never to the owner's own claims, and never sets a ring.
- **On the map:** the app shows the owner everyone, each marked **yours** or **Waldo thinks**, with the source behind each claim. Showing the owner what Waldo holds about their own contacts is the point of the map.
- **In background summaries:** the Patrol summary line stays counts-only ("1 new person"). It never shows a name.

### 6. How the model reads people

`read_memory` gains two selectors (built in slice 1):
- `{ person }`: one person's live claims, with relation phrases and validity. This is S9's `{ entity }` for a person;
- `{ people: true }`: person cards, each with name, other names, ring, relations (how claims name them, newest first, at most 3), next date, last contact and claim count. A `query` narrows them by name or claim text.

The relationship-upkeep skill reads the cards and judges who is worth raising. No threshold in code decides that someone is neglected; "silence alone is not neglect" stays in the skill. The skill keeps its rule: never guess a birthday, a relationship or a feeling.

### 7. The app view (additive app.v1)

[proposed] A new controls view, `people`, at a controls revision the gate allocates. This PR asks it as a `Gate question:` on #1980.
- **List:** one item per person, with:
  - `id` (`memory:person:<n>`), `name`, `ring`, `ring_by`;
  - the relations (as in the person cards);
  - `next_date` (the soonest dated claim, with its claim's text);
  - `last_contact` (`at` and `via`);
  - `held_as` (`yours` or `waldo_thinks`), a source count, and `actions`.
- **Detail:** the linked claims as `memoryClaim` items, with their existing actions, so one claim can be confirmed, edited or forgotten without touching the person.
- **Actions:** `person.confirm`, `person.rename` (the new name in `value`), `person.ring` (`inner`, `close` or `wider` in `value`) and `person.forget`, on `POST /app/v1/actions`. Each names one person, `memory:person:<n>`. The claim actions keep working on the claims in the detail.
- **Older builds:** below the revision, the view answers `invalid_query` and its actions `invalid_action`, as `days` and `agent_mail` do. Nothing is hidden: every claim about a person is still in What Waldo knows, where older builds already show it.
- **Constellation:** entity nodes and relation edges (design §13.5, app brief item 15) are a separate revision and a separate slice.

### 8. Egress and privacy

Names and email addresses are normal owner context within the owner's own authority (CLAUDE.md). The people map is the owner's notes about their own relationships, not a profile of anyone.

| Destination | Gets | Never gets |
|---|---|---|
| The model, in the owner's turns | Visible people and their claims (§5) | People known only from outside content, until confirmed |
| The owner's app | Every person, marked by how Waldo knows them | — |
| Logs, traces, metrics | Counts and ids | Names, addresses, relation lines, dates |
| The Patrol summary | Counts | Names |
| Third-party sends and drafts | Only what the owner asks to share, one item at a time | The map, or a person's record |
| Web look-ups | Only when the owner asks about a person, and never kept unless the owner says to remember | Background look-ups of anyone other than the owner (owner-profile-noticing §4.4) |

- **Another person's health:** not kept unless the owner asks (`HEALTH_MEMORY_RULES`), and never from outside content.
- **No profile of other people:** the record holds only name, other names, ring, at most 5 addresses, last contact, and the owner's own claims. Contacts are not bulk-ingested, and nothing is scraped.
- **The privacy notice** gains one sentence, which the owner writes: "Waldo keeps the people you deal with (names, email addresses, when you last heard from them) so it can help you keep in touch; you can correct or remove anyone."

### 9. Retention and deletion

- **Lifetime:** a person lives while a live claim links to them.
  - When the last linked claim is forgotten, retired or purged, the entity is deleted: it is derived.
  - `last_contact_*` goes with it.
- **The forget inventory:** `entities` (`name`, `aliases`, `addresses`) and `claim_links` join the forget inventory and ADR-0055's store registry. The purge job's text sweep covers them.
- **Account deletion:** deleting the account deletes the Durable Object, as today.

## Considered options

| Option | Verdict |
|---|---|
| **A. A person is an S9 entity; claims carry the facts** (chosen) | One writer and one forget. Confirm, correct and origin are reused, and it matches the approved design |
| B. A separate people table, with birthday, relationship and notes as columns | Rejected. It would be a second home for facts, with a second forget, a second confirm and a second trust model: the duplication §13.3 rejected for edge stores |
| C. A people table in Supabase | Rejected. The Durable Object is the memory authority; Supabase holds the health plane and auth. Nothing about people needs cross-device SQL |
| D. Build the map live on each read from mail, calendar and contacts | Rejected. It would mean a provider call on every view, and no place to keep the owner's corrections, confirmations or forgets |
| E. Ingest Google contacts in bulk | Rejected. "No full address-book ingestion" (`IMPLEMENTATION_CONTRACTS.md` People-1). It would profile non-users and enrol Contacts silently |
| F. Code ranks rings by how often someone appears | Rejected. Closeness is a judgment; the model makes it and the owner overrides it |
| G. A birthday column on the entity | Rejected for `claims.on_date`. A birthday is a fact someone stated or observed, so it belongs on a claim, with the claim's origin, correction and forget |

## Consequences

- People become one thing across chat, imports and mail. "Who do I know at Acme" and "when is Priya's birthday" stop depending on shared words.
- The S9 store lands with the people map, not as a separate memory slice. #1717's evals m15-m18 become this lane's acceptance tests.
- Last contact is honest about its reach: heard from or met, not written to.
- A forgotten person stays forgotten. Their name and addresses are barred, so the source pass cannot bring them back from the next mail.
- The app ships the view only at the gate's revision. Until then, people stay visible as claims.

## Verification (for the build slices)

**Falsifiers** (each is a test):
- a person known only from mail appears in a turn before the owner confirms;
- a forgotten person's name, alias or address survives in any store after the purge settles, or comes back through the next source pass;
- forgetting "Priya Shah" stops Waldo learning about another Priya;
- two people with one first name are merged (eval m17);
- a body or mind person reaches a turn that read outside content;
- a name or address appears in a log line, a trace or a Patrol summary;
- an owner's ring or name correction is overwritten by a later model pass;
- a birthday the owner never stated, and no source showed, appears.

**Acceptance:** #1717's m15-m18, plus:
- "who do I know at Acme";
- "when did I last hear from Sam";
- "what's coming up for my people this month";
- the app `people` view, with its old-build refusal.

**Slices, in this lane:**
1. **People store and reads:**
   - the S9 tables plus the people columns, with `ClaimStore` as the writer;
   - the `entities` link on `remember` and `import_memories`;
   - `read_memory` `{entity}` and `{people}`;
   - forgetting a person.
   - Behind `PEOPLE_MAP` (production `0`).
2. **The app view:** `people` and its actions, at the gate's controls revision.
3. **Source pass and skill:** people and addresses from the source pass (it is shown the people it may name by id, never one known only through body or mind), last contact from mail, and the relationship-upkeep skill reading the cards.

**Rollback:** with `PEOPLE_MAP` `0`, the new fields stay in the tool schemas but nothing is linked, dated or read: the handlers refuse them and say so. The tables stay, and old code ignores them. A revert leaves claims as they are.
