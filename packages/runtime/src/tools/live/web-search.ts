import {
  TOOL_PERMISSIONS, triggerTypeSchema, webSearchArgsSchema,
  type ToolHandler, type ToolName, type WebSearchArgs,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../dispatcher';

export type SearchHit = Readonly<{ title: string; url: string; snippet: string }>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const webSearchHandler = (
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): ToolHandler<WebSearchArgs, Readonly<{ query: string; hits: readonly SearchHit[] }>, ToolDispatcherContext> => ({
  name: 'web_search',
  description: 'Search the public web. Use for current facts, places, prices, documentation or news - anything you do not already know.',
  schema: webSearchArgsSchema,
  trigger_allowlist: allowlist('web_search'),
  autonomy_gated: false,
  async handle({ query, limit }: WebSearchArgs, ctx) {
    if (!apiKey) return { ok: false, code: 'auth_failed', source_taint: 'external', error: 'Web search is not set up on this Waldo yet.' };
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    let response: Response;
    try {
      await ctx?.assertTaskSourceCurrent?.();
      response = await fetcher(url, { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } });
    } catch (error) {
      return { ok: false, code: 'transient', source_taint: 'external', error: error instanceof Error ? error.message : String(error) };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'auth_failed', source_taint: 'external', error: `The web search key was rejected (HTTP ${response.status}) - it needs replacing.` };
    }
    if (!response.ok) return { ok: false, code: 'transient', source_taint: 'external', error: `Brave search returned HTTP ${response.status}` };
    const body = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    await ctx?.assertTaskSourceCurrent?.();
    const hits = (body.web?.results ?? [])
      .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }))
      .filter((hit) => hit.url !== '')
      .slice(0, limit);
    return { ok: true, data: { query, hits }, source_taint: 'external' };
  },
});
