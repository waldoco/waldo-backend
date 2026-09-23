---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up a **background agent** to do the research, so you keep working while it reads. Give the agent a clear source-routing contract, not just a topic.

Its job:

1. Classify the source type first: local repo/vault history, official docs/source code, paper/API, public web, community sentiment, difficult retrieval, or identity-sensitive.
2. Investigate against **primary sources** — official docs, source code, specs, first-party APIs, papers, or local source files — not a secondary write-up of them. Follow every claim back to the source that owns it.
3. Verify every citation by content. A URL that merely loads is not evidence; the fetched source must support the claim.
4. Separate observed facts, inferences, conflicts, rejected/uncertain claims, and confidence level.
5. Escalate by least power: local files and official APIs before browser automation, scraping, proxies, or paid retrieval. Ask before paid/proxy/auth-wall escalation.
6. Apply privacy gates before retrieval: no secrets, no raw health/private personal data, no doxxing, and no contact enrichment.
7. Write the findings to a single Markdown file, citing each claim's source.
8. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
