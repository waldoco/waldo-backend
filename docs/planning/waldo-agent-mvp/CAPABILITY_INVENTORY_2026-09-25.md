# Capability inventory: Hermes, Codex, Claude Code plugins, MCP ecosystem - and Waldo's gaps

Date: 2026-09-25. Owner ask: what tools/capabilities do Hermes agent, Codex, and the plugin
ecosystems have; what do they have that we don't; what to plan to build. Primary sources fetched
today, URLs inline. Hermes verified = NousResearch hermes-agent (hermes-agent.nousresearch.com,
github.com/NousResearch/hermes-agent).

Scope note: Hermes/Codex/Claude Code are operator-facing coding/power-user agents; Waldo is a
proactive personal agent on messaging channels. Gaps below are filtered through the alpha-tester
lens - "missing vs Hermes" only matters when a personal-agent user would feel it.

## Waldo's current surface (beta-mvp, verified from code)

41 typed tools (contracts permissions.ts toolNameSchema). Live with handlers: calendar read +
propose changes, gmail read + draft (5c12ae4), tasks read/write, reminders (set/list/cancel),
open/close loops, proactivity dial, memory read/update, episode search, context, web search,
browse_page/browse_act, connect_service, read_tool_output, search_tools lazy discovery, scheduler
fires (@remind/@prompt/@plan), Telegram channel, console (session auth, sign-out-everywhere),
scenario harness (23 L1), contracts 1657 tests.

Typed but NOT live (no handler in packages/runtime/src/tools/live/): call_mcp_tool and
search_connector (MCP client is contract-complete, dispatchable nowhere), execute_code (zero-ACL
by ADR-0050, deliberate), threading tools (create/delete/restore/archive/update_thread_topics -
ACL'd but no live handler found), draft_document, propose_schedule, write_sheet_cell, execute_action
/ propose_action pair (approval rail exists; execute_action gated).

## Hermes agent inventory (docs user-guide/features + reference/tools-reference)

Toolsets: browser (multi-backend incl. cloud Browserbase/Browser Use and local CDP), terminal
(with Docker/SSH/Singularity/Modal/Vercel sandbox backends, background processes, sudo), file
editing with checkpoints + /rollback, memory (MEMORY.md/USER.md), session_search, skills
(agentskills.io open standard, progressive disclosure), cronjob (natural-language scheduling,
pause/resume/edit, deliver results to any platform), delegation (delegate_task subagents,
3 concurrent default, isolated toolsets), code_execution (write Python that calls Hermes tools
via sandboxed RPC - collapses multi-step flows into one model turn), kanban, project, clarify
(multi-question elicitation), homeassistant, computer_use, desktop_ui, vision, image_gen (9
models), video/video_gen, tts (10 providers), voice mode (incl. Discord voice channels), x_search,
web, discord (+admin), spotify, feishu doc/drive, connections, setup.

Integration layer: MCP client (stdio+HTTP, per-server tool filtering), memory providers
(Honcho, Mem0, Supermemory, ByteRover... 8 named), provider routing with fallback + credential
pools (key rotation on rate limit), cross-session prompt caching, OpenAI-compatible API server,
IDE integration (ACP: VS Code/Zed/JetBrains), batch processing (parallel runs, ShareGPT
trajectories for evals/training).

Plugins: three types - general (tools/hooks), memory providers, context engines - managed via
`hermes plugins`. Event hooks for tool interception/metrics/guardrails.

## Codex CLI inventory (developers.openai.com/codex/cli/reference)

Developer-agent shaped: interactive TUI, `codex exec` non-interactive, cloud tasks
(`codex cloud`), code review (`codex review`), sandbox (macOS seatbelt / Linux Landlock /
Windows), MCP client (`codex mcp`, and Codex itself as `codex mcp-server`), plugins via
marketplaces (`codex plugin marketplace add owner/repo`), execpolicy, app-server mode.
Safety posture: sandbox + approvals, redaction at display/log only (see REDACTION_PRACTICES doc).

## Claude Code plugin ecosystem (code.claude.com/docs/en/plugins, discover-plugins)

Plugin = bundle of commands + skills + subagents + hooks + MCP servers + LSP servers.
Marketplaces are git repos (GitHub shorthand, URL, local). Official Anthropic marketplace:
code-intelligence LSP plugins (gopls, jdtls, pyright...), external integrations that bundle
pre-configured MCP servers: github, gitlab, atlassian, asana, linear, notion, figma, vercel,
firebase, supabase. Team-managed marketplaces via settings.json. Notable UX: "Not used recently"
surfacing so unused plugins' context cost is visible; hot reload with prompt-cache cost warnings.

## MCP ecosystem

Official MCP Registry (preview, Sept 2025) as the single source of truth; community mirrors track
91k+ servers (Glama). The big SaaS all ship official servers: GitHub, Linear, Notion, Atlassian,
Asana, Figma, Vercel, Firebase, Supabase, Slack, Stripe, Sentry.
blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/

## Gap analysis vs Waldo

### They have, we need for alpha (personal-agent lens)
1. **Connector breadth via MCP.** Hermes/Claude get GitHub/Linear/Notion/Slack/Spotify "for free"
   from MCP. We have call_mcp_tool typed but zero live handlers - wiring one MCP server
   (stdio/http) behind the existing contract closes most of the breadth gap at once.
   THIS IS THE LEVERAGE MOVE: one client, N integrations.
2. **Voice in/out.** Messaging-native users send voice notes. Hermes: transcription + 10 TTS
   providers, live voice. Waldo: none. For WhatsApp alpha this is felt immediately.
3. **Vision input.** Photos of receipts, whiteboards, meds labels. Hermes: clipboard vision.
   Waldo: LLMAttachment exists in the contract; no channel wires it.
4. **Multi-user + channel breadth.** Hermes delivers cron results "to any platform". Waldo is
   single-owner Telegram today; WhatsApp + multi-user are already today's plan - confirmed as the
   right critical path.

### They have, we should plan (post-alpha)
5. **Plugin/extension architecture.** Hermes's three plugin types (tools/hooks, memory providers,
   context engines) and Claude's bundle (commands/skills/hooks/MCP) are the two reference shapes.
   Waldo already has skills + search_tools lazy discovery + a contracts-level MCP seam - a
   "connector plugin" = a config-declared MCP server is the natural first extension unit.
6. **Subagent delegation** (delegate_task with restricted toolsets) - our run-loop is single-agent;
   long handoffs would benefit. Design exists in spirit (handoff triggers).
7. **Credential pools / provider failover polish** - we have routing fallback; key rotation pools
   are a cheap add when spend grows.
8. **Checkpoints/rollback** - Hermes snapshots before file changes. Our analog: 10-min undo window
   on calendar mutations. Extend the undo rail to more effect types.
9. **Batch/eval trajectory export** - Hermes exports ShareGPT trajectories. Our harness traces
   are 80% of this; an exporter is small.
10. **execute_code with sandbox RPC** (Hermes's one-turn multi-tool scripting). Deliberately
    deferred by ADR-0050; revisit only with the vault/sandbox story.

### Deliberate non-goals (their surface, not our product)
computer_use/desktop_ui, homeassistant, spotify/discord-native toolsets, IDE integration, image/
video generation, kanban/project toolsets (Waldo is not a coding agent and not a home-automation
hub). If the owner wants any of these, they're connector-shaped (MCP), not core-shaped.

### What we have that they don't (keep the edge)
- Proactive loop with owner-set proactivity dial (set_proactivity), patrol/intervention triggers
- Biology-aware core (CRS, form zones) - no peer has it (Hermes docs confirm: health absent)
- The scenario harness running the real pipeline in-process (HARNESS_COMPARISON_2026-09-25)
- Consent gates + undo rails on mutations as first-class contract (their approvals are UI-level)
- Honest-degradation contract (fail-closed fallbacks with owner-visible honesty)

## Build-plan recommendation (feeds today's ordering)

1. Wire the MCP client (call_mcp_tool live handler + one reference server, e.g. a read-only one)
   - proves the extension seam; then connectors become config, not code.
2. Voice-note transcription + TTS reply on the WhatsApp channel work (bundle; same audio pipeline).
3. Vision attachments on the channel -> LLMAttachment (contract already has the type).
4. Post-alpha: connector plugin format (declared MCP server + ACL entry + scenario), subagent
   delegation, undo-rail widening, trajectory export for the harness.
