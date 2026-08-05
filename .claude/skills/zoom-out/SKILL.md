---
name: zoom-out
description: Tell the agent to zoom out and give broader context or a higher-level perspective. Use when you're unfamiliar with a section of code or need to understand how it fits into the bigger picture.
disable-model-invocation: true
---

# Zoom Out

I don't know this area of code well. Go up a layer of abstraction. Give me a map
of all relevant modules and callers, using vocabulary from `.claude/rules/language.md`,
`docs/foundation`, accepted ADRs, and `packages/contracts`.

Include:
- Which locked workstream, dependency, and proof gate owns the code
- Which adapter, aggregate owner, or core module it belongs to
- Which context, continuity, workspace, artifact, or product-truth store it touches
- Which gateway, Durable Object, connector, or executor call path invokes it
- Where commands, context, execution observations, effects, evidence, and projections enter and leave the owner Durable Object

Don't propose changes. Just map.
