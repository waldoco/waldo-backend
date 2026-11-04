# Waldo design language: show what became true

September 29, 2026. A design brief from visual inspection of the founder's 22-page August 2026 deck, especially pages 2, 7-15 and 22, with the current console CSS and [product philosophy](WALDO_PHILOSOPHY.md). This translates visual intent; it is not a claim that the pictured app, health feed, actions or channels ship today. The console is the current implementation, not a pixel match to the deck.

## Visual grammar

The deck alternates warm off-white editorial pages with nearly black product pages. Large serif headlines explain the idea; compact sans-serif labels and short body text carry facts. A small uppercase section label and generous margins establish hierarchy. Stacked, slightly offset cards use vivid blue, green, purple, yellow and coral to make ideas distinct (pp7-9); the Dalmatian mark gives a human-scale pause, not a substitute for status. Dark screens show the actual product flow in smaller, quieter panels (pp10-15). The final slide uses the Dalmatian photo with open white space and a short line (p22).

Translate the pattern, not the pitch layout: a calm canvas, strong editorial headline for the day's answer, compact status rows below, one restrained accent for action and explicit text for consequences. Never rely on color alone. Avoid a wall of dashboards, decorative graphs or scores that imply precision the data cannot support. A small view should preserve the same reading order, not squeeze a desktop three-pane layout onto a phone.

The existing server-rendered console uses `Instrument Serif`/Georgia for display type and `Inter`/system sans for body, with ink `#251f21`, sand `#f4efec`, rule `#eae9ea` and teal action accents (`packages/runtime/src/channels/console.ts`, inspected at beta-mvp `41c8ac3`). These are **current implementation tokens**, not extracted deck hex values. The deck's bright stacked-card colors are an illustration palette, not a requirement to recolor each status. Preserve contrast, readable type and accessible focus states before chasing color fidelity.

## The information hierarchy

1. **What needs attention now.** The home/Brief should say what changed, what matters, and what is waiting for the owner. The deck's p10 phone mockup and p12 timeline imply one living day, not ten competing widgets.
2. **The actual state of work.** A Handoff/Adjustment card separates proposed, approved, executing, verified, failed and still open. Keep owner decision controls next to the exact effect they govern, not a blanket "Sync it" over several unseen calendar/email actions.
3. **Why Waldo believes this.** A Spot, constellation edge, update or health card needs source, timestamp, trust/uncertainty and correction/forget affordance. Deck p12's "Waldo spotted this at 11:42 am" is the provenance cue. A graph is secondary to the exact claim and the user's control.
4. **What can be checked later.** Activity should show a truthful per-action receipt and failure state. A model hop is not a sent message, and a saved proposal is not a changed calendar. An empty state should explain what has not happened without implying a monitor failed when no event was due.

Onboarding should get to one useful task quickly, then reveal connections and controls at the point of need. Never present a checked consent box or an autonomy slider as permission to send to anyone or spend. A member's email, phone, connected account and owner DO must remain correctly bound; the visual story is secondary to the sign-in and revocation path.

## Component and review checklist

- Cards: one purpose per card; visible status word and timestamp, with the action it permits. Distinguish tentative patterns from confirmed owner facts without using only color.
- Decisions: exact recipient, account, time, location and effect in the review surface; separate modification and decline; describe undo accurately. Keep CSRF/session state and actual result in the backend, never assume a button click succeeded.
- Health: show missing data as missing. Do not render the deck's Form 78, sleep chart or biological insight unless that owner has a validated source and consented interpretation.
- Memory: show provenance and a specific correct/forget route; acknowledge that literal purge does not ensure semantic paraphrase erasure.
- Responsive checks: render real desktop and phone widths, inspect pixels for wrapping, truncation, contrast, focus, card order and forms. Test long names, timestamps, failure copy and no-data states; dark mode is a separate verified design, not a side effect of inverting colors.

Before a design is called ready, compare the implemented page with the source-of-record data it represents and capture desktop/mobile screenshots. These docs do not replace that visual or functional test. Production readiness further requires invite-gate, two-owner routing, session, OAuth and effect recovery receipts.
