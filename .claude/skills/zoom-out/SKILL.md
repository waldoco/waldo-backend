---
name: zoom-out
description: Tell the agent to zoom out and give broader context or a higher-level perspective. Use when you're unfamiliar with a section of code or need to understand how it fits into the bigger picture.
disable-model-invocation: true
---

# Zoom Out

I don't know this area of code well. Go up a layer of abstraction. Give me a map of all relevant modules and callers, using vocabulary from `Docs/CONTEXT.md` (Waldo's ubiquitous language).

Include:
- Which build phase the code belongs to (A-H, Phase 2/3)
- Which adapter or core module it lives in (CRS engine, agent loop, ChannelAdapter, etc.)
- Which memory tier it touches (working/semantic/episodic/procedural/archival)
- Which Edge Function or DO method invokes it
- Where data flows in (Wearable → HealthKit → op-sqlite → Supabase → DO) and out (DO → ChannelAdapter → user)

Don't propose changes. Just map.
