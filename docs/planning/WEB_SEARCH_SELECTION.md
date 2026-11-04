# Web search provider selection

Status: recommendation. The owner picks. Researched 23 Sep 2026.

## What other agents use

- **OpenClaw** ships 13+ search providers behind one `web_search` tool. With no provider set, it auto-detects the first configured API-backed provider in a fixed order: Brave (first), MiniMax, Gemini, Grok, Kimi, Perplexity, Firecrawl, Exa, Tavily, Parallel. Key-free providers (DuckDuckGo HTML, Parallel free, Codex hosted search) never win auto-detection. They run only when chosen explicitly. Provider text is re-wrapped once at the core boundary as untrusted content. Source: https://docs.openclaw.ai/tools/web
- **Hermes Agent** exposes two tools, `web_search` (ranked results) and `web_extract` (readable page content), served by provider plugins: Firecrawl, SearXNG, Tavily, Perplexity, Exa, Parallel, Brave (free tier), xAI and DDGS. Sources: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search and https://hermes-agent.nousresearch.com/docs/developer-guide/web-search-provider-plugin
- Two patterns are common to both:
  - search and page read are separate tools
  - the provider sits behind a seam chosen by config

## Options for Waldo

| Provider | Returns | Price | Fits our contract |
|---|---|---|---|
| Brave Search API | Ranked title/url/snippet from its own independent index | $5 per 1k requests (https://brave.com/search/api/) | Yes. `webSearchHitSchema` is title + url + snippet, with page content only through an explicit read (ADR-0025 wall) |
| Tavily | Ranked results plus an extract endpoint | 1,000 free credits/month, then $0.008/credit (https://docs.tavily.com/documentation/api-credits) | Yes. The free tier covers owner-only use |
| Exa | Neural/keyword search with optional content | $7 per 1k requests (https://exa.ai/pricing?tab=api) | Yes. Strongest for research-style queries |
| OpenAI hosted web search | A model-written answer with citations, inside the model call | $10 per 1k calls plus search content tokens (https://developers.openai.com/api/docs/pricing) | Weak. It skips our dispatcher (no ACL, taint stamp or Scribe pass on results), ties search to one model vendor, and is disabled on our org today |

## Recommendation

**Brave as the default, with Tavily as a configured alternative behind the same seam.** Selection follows the STT pattern: the first configured key wins, and `WALDO_SEARCH_PROVIDER` pins one.

Why Brave:
- It's the industry default (OpenClaw's first choice).
- It has its own index.
- Its results are plain hits that go through our dispatcher's checks.
- Cost is predictable.

Tavily costs nothing while only the owner uses Waldo. Page reading (`web_fetch`-style) is a separate tool, matching both reference agents.

Secret names: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`.
