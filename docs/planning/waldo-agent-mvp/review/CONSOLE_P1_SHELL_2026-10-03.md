# P1 navigation and settings shell

Issue: https://github.com/waldoco/waldo-backend/issues/659
Base: eb919e97498f221a9332c0e5d477b071e552ccca

Primary navigation: Today, Waiting, Memory, Patrol. Secondary: Files and Connections. Settings and Invite someone live in the footer; restricted invite management stays separate. Existing controls remain at /console/legacy.

Settings contains Day & notifications, Sessions, Usage, Account & privacy, and Setup. Old day/usage/account/setup hash routes render the corresponding Settings section. Session rendering reuses the existing connections read, without inventing an individual session list. Connections no longer renders browser sessions. Reads/mutations and owner auth semantics are unchanged.

Verification: 16 dashboard test files / 161 tests; dashboard TypeScript/Vite build and verify:assets pass. Mounted tests exercise grouped routes, old links, history and GET-only entry reads. Synthetic local screenshots inspect seven routes at 1440, 390 and 320px. No page-wide overflow; Usage retains an intentional horizontal table scroll at narrow widths. Connections heading was reduced at 320px after inspecting an awkward word break. Mobile drawer opens using Enter, Escape closes it and restores focus to Menu. This is a local UI review, not hosted behavior proof or a usability study.

Not included: signup/phone flow, API/auth/DO changes, Memory redesign, notice custody, forget retries, individual-session inventory, legacy retirement, staging promotion or production deploy. Core owns publication/review of this isolated slice.
