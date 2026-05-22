---
name: new-adapter
description: Scaffold a new adapter implementation (any of the 10 adapter types)
user-invocable: true
model: sonnet
allowed-tools: ["Read", "Write", "Edit", "Grep", "Glob"]
---

Scaffold a new adapter implementation for $ARGUMENTS.

**Available adapter types (10 total):**

Core (MVP):
- `ChannelAdapter` — messaging delivery (WhatsApp, Discord, Slack, In-App)
- `LLMProvider` — AI model calls (DeepSeek, GPT-4o, Qwen, Gemini)
- `HealthDataSource` — wearable data (Oura, Fitbit, WHOOP, Samsung, Garmin)
- `StorageAdapter` — local persistence (cloud sync, cross-device)
- `WeatherProvider` — environmental context (OpenWeather)

Phase 2 (Life Context):
- `CalendarProvider` — schedule intelligence (Google Calendar, Outlook, Apple Calendar)
- `EmailProvider` — communication load (Gmail, Outlook — metadata only, never body)
- `TaskProvider` — work queue (Todoist, Notion, Linear, Google Tasks, Microsoft To Do)
- `MusicProvider` — mood inference (Spotify, YouTube Music, Apple Music)
- `ScreenTimeProvider` — digital hygiene (RescueTime)

**Steps:**
1. Read the adapter ecosystem spec from `Docs/WALDO_ADAPTER_ECOSYSTEM.md`
2. Read the architecture rules from `.claude/rules/architecture.md` (Adapter Pattern section)
3. Create the new adapter implementation file in the correct directory:
   - `src/adapters/channels/` for ChannelAdapter
   - `src/adapters/llm/` for LLMProvider
   - `src/adapters/health/` for HealthDataSource
   - `src/adapters/storage/` for StorageAdapter
   - `src/adapters/calendar/` for CalendarProvider
   - `src/adapters/email/` for EmailProvider
   - `src/adapters/tasks/` for TaskProvider
   - `src/adapters/music/` for MusicProvider
   - `src/adapters/screen/` for ScreenTimeProvider
   - `src/adapters/weather/` for WeatherProvider
4. Implement the full interface with proper TypeScript types
5. Add a factory/registry entry so the adapter can be selected by config
6. Create a test file with at least: happy path, error handling, timeout behavior

**Rules:**
- Agent logic NEVER references the new provider directly — only through the adapter interface
- Follow naming conventions from `.claude/rules/coding-standards.md`
- For EmailProvider: NEVER access email body content. Headers/metadata only.
- For MusicProvider: audio features (valence, energy) only. Never track specific song titles in logs.
- All new adapters must have a Mock implementation for testing.
- Update `Docs/WALDO_ADAPTER_ECOSYSTEM.md` with the new provider.
