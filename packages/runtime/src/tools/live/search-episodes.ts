import { searchEpisodesArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type SearchEpisodesArgs, type ToolHandler } from '@waldo/contracts';
import type { EpisodeHit, EpisodeIndex } from '../../channels/episodes';
import type { ToolDispatcherContext } from '../dispatcher';

export const searchEpisodesHandler = (index: EpisodeIndex): ToolHandler<SearchEpisodesArgs, Readonly<{ hits: readonly EpisodeHit[] }>, ToolDispatcherContext> => ({
  name: 'search_episodes',
  description: 'Search past conversations with the owner by keywords. Returns matching snippets, newest context first by relevance, with who said it and when.',
  schema: searchEpisodesArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('search_episodes')),
  autonomy_gated: false,
  async handle({ query, limit, date_range }) {
    const hits = index.search(query, limit, date_range ? Date.parse(date_range.from) : undefined, date_range ? Date.parse(date_range.to) : undefined);
    return { ok: true, data: { hits }, source_taint: null };
  },
});
