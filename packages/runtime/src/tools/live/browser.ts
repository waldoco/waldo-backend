import {
  PROVIDER_OF, TOOL_PERMISSIONS, triggerTypeSchema, browsePageArgsSchema, WALDO_CHAT_MODEL,
  type ToolHandler, type ToolName, type BrowsePageArgs,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../dispatcher';

// Stagehand v3 hosted HTTP API (openapi v3.1.0, browserbase/stagehand packages/server-v3).
// Plain fetch - no SDK, no Node host. Keys stay server-side; session ids never reach model text.
const BASE = 'https://api.stagehand.browserbase.com';
const MODEL = `${PROVIDER_OF[WALDO_CHAT_MODEL]}/${WALDO_CHAT_MODEL}`;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

export const browsePageHandler = (
  apiKey: string | undefined,
  projectId: string | undefined,
  modelApiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): ToolHandler<BrowsePageArgs, Readonly<{ url: string; data: unknown }>, ToolDispatcherContext> => ({
  name: 'browse_page',
  description: 'Open a public web page in a real browser and extract information from it. Use when web_search snippets are not enough - the page is dynamic or needs reading in full. Read-only: it never clicks, fills or submits.',
  schema: browsePageArgsSchema,
  trigger_allowlist: allowlist('browse_page'),
  autonomy_gated: false,
  async handle({ url, instruction }: BrowsePageArgs) {
    if (!apiKey || !projectId) return { ok: false, code: 'auth_failed', error: 'Browsing is not set up on this Waldo yet.' };
    const headers = { 'x-bb-api-key': apiKey, 'x-bb-project-id': projectId, 'content-type': 'application/json' };
    const call = (path: string, body: object) => fetcher(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    let session: string | null = null;
    const end = () => (session ? call(`/v1/sessions/${session}/end`, {}).catch(() => undefined) : Promise.resolve());
    try {
      const started = await call('/v1/sessions/start', { modelName: MODEL, verbose: 0 });
      if (started.status === 401 || started.status === 403) return { ok: false, code: 'auth_failed', error: `The browser key was rejected (HTTP ${started.status}) - it needs replacing.` };
      if (!started.ok) return { ok: false, code: 'transient', error: `Browser session start failed (HTTP ${started.status})` };
      const startBody = (await started.json()) as { success?: boolean; data?: { sessionId?: string } };
      session = startBody.data?.sessionId ?? null;
      if (!startBody.success || !session) return { ok: false, code: 'transient', error: 'Browser session start returned no session.' };

      const navigated = await call(`/v1/sessions/${session}/navigate`, { url });
      if (!navigated.ok) return { ok: false, code: 'transient', error: `The page did not load (HTTP ${navigated.status})` };

      const model = modelApiKey ? { modelName: MODEL, apiKey: modelApiKey } : MODEL;
      const extracted = await call(`/v1/sessions/${session}/extract`, { instruction, options: { model, timeout: 30000 } });
      if (extracted.status === 401 || extracted.status === 403) return { ok: false, code: 'auth_failed', error: `The browser key was rejected (HTTP ${extracted.status}) - it needs replacing.` };
      if (!extracted.ok) return { ok: false, code: 'transient', error: `Extraction failed (HTTP ${extracted.status})` };
      const extractBody = (await extracted.json()) as { success?: boolean; data?: { result?: unknown } };
      if (!extractBody.success) return { ok: false, code: 'transient', error: 'Extraction was rejected by the browser service.' };
      return { ok: true, data: { url, data: extractBody.data?.result ?? null }, source_taint: 'external' };
    } catch (error) {
      return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error) };
    } finally {
      await end();
    }
  },
});
