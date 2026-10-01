import { searchEpisodesArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type SearchEpisodesArgs, type ToolHandler } from '@waldo/contracts';
import type { EpisodeHit, EpisodeIndex } from '../../channels/episodes';
import type { ToolDispatcherContext } from '../dispatcher';

export const searchEpisodesHandler = (index: EpisodeIndex): ToolHandler<SearchEpisodesArgs, Readonly<{ hits: readonly EpisodeHit[] }>, ToolDispatcherContext> => ({
  name: 'search_episodes',
  description: 'Search past conversations with the owner by keywords. Returns snippets ranked by keyword relevance, not by recency, each with who said it, when, and the entry_id of the stored turn. A snippet is only a fragment of that turn, so compare the timestamps before treating a hit as the latest.',
  schema: searchEpisodesArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('search_episodes')),
  autonomy_gated: false,
  async handle({ query, limit, date_range }) {
    const hits = index.search(query, limit, date_range ? Date.parse(date_range.from) : undefined, date_range ? Date.parse(date_range.to) : undefined);
    return { ok: true, data: { hits }, source_taint: null };
  },
});
