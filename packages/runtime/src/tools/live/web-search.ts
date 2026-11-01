import {
  OPENAI_PROVIDER, TOOL_PERMISSIONS, triggerTypeSchema, webSearchArgsSchema,
  type ModelProvider, type ToolHandler, type ToolName, type WebSearchArgs,
} from '@waldo/contracts';
import { searchLocation } from './search-location';
import { testSiteHost } from '../../security/test-site';
import type { ToolDispatcherContext } from '../dispatcher';
import { effectSignal } from '../../channels/run-effect-scope';

const SEARCH_CEILING_MS = 15_000;

export type SearchHit = Readonly<{ title: string; url: string; snippet: string }>;

// The owner path offers this tool when its search key is deployed, and otherwise only where OpenAI runs the path, whose
// hosted search stands in. A Claude turn without the key has no web search, so it is not offered one that cannot run.
export const webSearchOffered = (apiKey: string | undefined, provider: ModelProvider): boolean => Boolean(apiKey) || provider === OPENAI_PROVIDER;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const webSearchHandler = (
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
  ownerTimezone?: () => string,
): ToolHandler<WebSearchArgs, Readonly<{ query: string; hits: readonly SearchHit[] }>, ToolDispatcherContext> => ({
  name: 'web_search',
  description: 'Search the public web. Use for current facts, places, prices, documentation or news - anything you do not already know.',
  schema: webSearchArgsSchema,
  trigger_allowlist: allowlist('web_search'),
  autonomy_gated: false,
  async handle({ query, limit }: WebSearchArgs, ctx) {
    if (!apiKey) return { ok: false, code: 'auth_failed', source_taint: 'external', error: 'Web search is not set up on this Waldo yet.' };
    const country = ownerTimezone ? searchLocation(ownerTimezone()).country : undefined;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}${country ? `&country=${country}` : ''}`;
    let response: Response;
    try {
      await ctx?.assertTaskSourceCurrent?.();
      response = await fetcher(url, { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' }, signal: effectSignal(ctx?.runScope, SEARCH_CEILING_MS) });
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { ok: false, code: 'transient', source_taint: 'external', error: 'Web search did not answer in the time this turn had left.' };
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
      .filter((hit) => hit.url !== '' && testSiteHost(hit.url) === null)
      .slice(0, limit);
    return { ok: true, data: { query, hits }, source_taint: 'external' };
  },
});
