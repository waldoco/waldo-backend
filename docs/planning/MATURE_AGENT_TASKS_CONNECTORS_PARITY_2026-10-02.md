# Scheduled tasks and connectors parity against ChatGPT (second slice)

Layer: vendor facts from help pages fetched 2026-10-02 (cited). Waldo column is a SOURCE read of beta-mvp and merged-PR knowledge, not a staging result. "verify" = no staging receipt yet. Memory slice: MATURE_AGENT_MEMORY_PARITY_2026-10-02.md.

Sources:
- Scheduled Tasks in ChatGPT: https://help.openai.com/en/articles/10291617
- Google Drive app in ChatGPT: https://help.openai.com/en/articles/10929079-google-drive-app-and-setup-in-chatgpt

## Scheduled tasks and change alerts

| # | ChatGPT does (per page) | Waldo today | Gap / next |
|---|---|---|---|
| T1 | Create a task by asking ("Let me know when my package gets delivered"), one-off or recurring | `set_reminder`, standing orders, `open_loop` tools exist | verify create-by-asking on staging |
| T2 | Page says "you'll be provided with the following confirmation" and shows a reminder card image (the card's exact content is an image, not text; UNVERIFIED beyond that) | reply is meant to rest on the tool receipt | verify the reply names time and what will happen, from the receipt |
| T3 | Exact lines (current en wording per the reviewer): "Select the task title in its conversation. Use the task panel to edit, pause, manage, or delete the task." (my own fetch showed an older "click the task pill" wording; the page changes) | `list_reminders`, `cancel_reminder` exist | no pause or edit seen in the tool list; decide if needed (merit: cancel and recreate covers edit; pause is small) |
| T4 | "Check for changes and notify when there is a meaningful update" | proactivity harness is Dalda's; quiet-vs-action staging proof absent | first-wedge gap in the owner's sheet; needs resumable task state |
| T5 | Notifications on the channels the user chose; per-channel opt-out | Telegram is the channel | verify one notification, and pause/stop honored |
| T6 | Exact line: "Active task limits vary by plan: Go users can have up to 3 active tasks, Plus users up to 5, Business and Edu users up to 10, and Pro and Enterprise users up to 15." (plan-specific; Waldo has no plans, so the cap is our own choice) | none | set a small cap and say it in plain words when hit (no spend involved) |

## Drive / connectors

| # | ChatGPT does (per page) | Waldo today | Gap / next |
|---|---|---|---|
| C1 | Connect Drive, review requested Google permissions, authorise | Reconnect button path exists; stored grant lacks the Drive scope | Google consent for Drive scope still needed (Drive-only consent design #553); owner action |
| C2 | Search files, reference Docs/Sheets/Slides | `read_mcp_tool` list/search/metadata behind `readIntents` (default off); `read_file_content` refused until the edge stops storing results | edge skip-store (#583 spec, Dalda's edge PR) then flag on, then staging proof |
| C3 | Different permissions for read vs metadata vs write | scopes designed read-only first | keep write off until a read-draft-approved-effect proof |
| C4 | Cannot use files the account cannot open | follows from the provider grant | verify a denied file returns a clean refusal, not a retry |
| C5 | Exact lines: "Actions that change a file ... require the corresponding Google permissions" and "ChatGPT may ask you to confirm an action before carrying it out." ("may": not always) | effect tools go through the owner approval button | consistent; keep |
| C6 | Clear authorisation errors (blocked scope) | typed `auth_failed` with reason enums and reconnect button; 401/403 kept (#587); refusal and intent errors are `rejected` (#592, #594, #600) | verify the owner sees one clear reconnect message on staging |

## Order for today (no spend)
1. Staging flows: T1/T2 (create by asking), T5 (one notification), C6 (no-grant Drive read).
2. T6 as a small cap if a staging run shows unbounded task creation; otherwise skip (no stated Waldo reason yet).
3. C2 after the edge change is live and a release SHA exists.
4. T4 stays Dalda's harness; Core reviews.
