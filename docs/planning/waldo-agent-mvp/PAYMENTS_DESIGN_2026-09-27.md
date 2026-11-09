# Waldo Payments & E-commerce - Design (owner verification draft)

Status: DRAFT for owner verification. No code in this PR. Nothing here grants spending capability; every wallet-bearing action stays owner-confirmed at every stage.
Origin: owner ask 2026-09-27 ("for e commerce and payment things how are we handling this and the required automations around it? Like muse and instinct"). Health-first steer (same morning) is unaffected; this doc sequences the commerce lane.

## Grounded reference points (fetched 2026-09-27)

- Meta Muse (meta.com help page): "Muse can help you make purchases online. It will always ask for your approval prior to completing a purchase." Stripe newsroom: at 1M+ Link merchants Muse checks out with the consumer's saved Link payment method; at other merchants Link issues Muse a single-use virtual card number. PCWorld hands-on: owner hands over a card, Muse scours and rings up "on your say-so."
- Instinct (this platform, firsthand): card details live in a vault (entered via a single-use vault link, never in chat or model context); every wallet-bearing action - payment, booking, anything spending money or credits - gets explicit owner confirmation of the final state (item, total, delivery address) before committing; every attempt leaves a receipt (merchant, total, outcome, obstacle).
- Waldo today: nothing. No card handling, no checkout, no order tracking. This doc defines the lane.

## Invariants (same discipline as the sandbox spec)

1. Card data never enters model context, traces, episodes, or logs. Collection via vault-link style single-use entry; storage worker-side only.
2. Every spend is owner-confirmed at the final state: item summary, total, delivery address, and undo cost, presented before commit. No standing "spend freely" grant exists; per-shape earned grants are possible only by explicit owner words, one shape at a time.
3. Single-use or merchant-locked virtual card numbers where the rail allows (Muse/Link pattern) - a compromised or overreaching flow cannot reuse the number elsewhere.
4. Every attempt receipts: merchant, total, outcome, obstacle tag. No receipt, no claim.
5. Declines and verification challenges surface honestly - retry once with rechecked totals, alternate saved card, or hand the checkout to the owner. Never route around a decline through another wallet.

## Stages

P1 - Track without spending (no rails needed):
- Order tracking: gmail order-confirmation/shipping mails parsed into tracked orders (background runs + day-card surface); delivery ETA nudges via the standing-orders lane.
- Price watches: scheduled probes on owner-named items; alert with price history, never auto-buy.
- Reorder lists: consumables the owner logs; "time to reorder?" nudges.
- Receipt capture: owner forwards receipts; waldo files and summarizes spend.

P2 - Guided checkout (owner's own card, owner completes):
- Waldo builds the cart (browser lane), applies known preferences (size, address, delivery slot), and hands the payment step to the owner. Zero card handling by waldo.

P3 - Agentic checkout (the Muse/Instinct shape):
- Vault-held card or single-use virtual numbers via an issuing partner (external dependency: a card-issuing API such as Stripe Issuing / Link-style rail - selection is an owner decision with cost/KYC implications, flagged not guessed).
- Owner-confirm gate on the final state per invariant 2; per-shape earned grants only by his explicit words.
- Hard ceilings: per-transaction and per-day caps set by the owner, enforced worker-side (fail-closed), receipted.

## Automations summary

Order tracking (P1), price watches (P1), reorder nudges (P1), receipt filing (P1), cart building (P2), checkout execution under confirmation (P3). Each stage ships behind its own issue+branch+PR with the standing gates.

## Open owner decisions

1. Rail for P3: Stripe Issuing-style single-use cards vs vault-held personal card vs P2-only (no agentic spend). Cost/KYC per rail needs a live pricing check at build time.
2. Spending ceilings and which shapes (if any) ever earn standing grants.
3. Priority vs the health lane (health-first is the stated direction; this doc's P1 is cheap and composes with day cards).
