import {
  PROVIDER_OF, TOOL_PERMISSIONS, triggerTypeSchema, browseActArgsSchema, browsePageArgsSchema, WALDO_CHAT_MODEL,
  type ToolHandler, type ToolName, type BrowsePageArgs, type BrowseActArgs,
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

type BrowserAction = Readonly<{ selector: string; description: string; method?: string; arguments?: string[] }>;

// The deterministic irreversible line (owner law: hard safety lines only, judgment stays with
// the model). Anything that looks like it commits something off-page stops the run cold;
// approval-bound submits are B-tool-3, not a guess here.
const IRREVERSIBLE = /\b(submit|pay|payment|purchase|checkout|order|book|buy|send|post|publish|delete|remove|transfer|confirm|sign up|register|log ?in)\b/i;
const isIrreversible = (action: BrowserAction): boolean =>
  action.method === 'submit' || IRREVERSIBLE.test(action.description) || (action.method !== undefined && IRREVERSIBLE.test(action.method));

export type BrowseActResult = Readonly<{
  url: string;
  actions_taken: readonly string[];
  stopped: 'task_done' | 'cap_reached' | 'irreversible_blocked' | 'no_action_found';
  blocked_action?: string;
  data: unknown;
}>;

export const browseActHandler = (
  apiKey: string | undefined,
  projectId: string | undefined,
  modelApiKey: string | undefined,
  record: (kind: string, summary: string, payload: unknown) => void = () => undefined,
  fetcher: typeof fetch = fetch,
): ToolHandler<BrowseActArgs, BrowseActResult, ToolDispatcherContext> => ({
  name: 'browse_act',
  description: 'Open a public web page in a real browser and take a few small in-page actions (click, type, scroll) toward a task, then report what the page shows. Capped steps. It will never submit, pay, send, book, delete or log in - it stops and reports instead.',
  schema: browseActArgsSchema,
  trigger_allowlist: allowlist('browse_act'),
  autonomy_gated: false,
  async handle({ url, task, max_actions }: BrowseActArgs) {
    if (!apiKey || !projectId) return { ok: false, code: 'auth_failed', error: 'Browsing is not set up on this Waldo yet.' };
    const headers = { 'x-bb-api-key': apiKey, 'x-bb-project-id': projectId, 'content-type': 'application/json' };
    const call = (path: string, body: object) => fetcher(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const model = modelApiKey ? { modelName: MODEL, apiKey: modelApiKey } : MODEL;
    let session: string | null = null;
    const end = () => (session ? call(`/v1/sessions/${session}/end`, {}).catch(() => undefined) : Promise.resolve());
    const taken: string[] = [];
    try {
      const started = await call('/v1/sessions/start', { modelName: MODEL, verbose: 0 });
      if (started.status === 401 || started.status === 403) return { ok: false, code: 'auth_failed', error: `The browser key was rejected (HTTP ${started.status}) - it needs replacing.` };
      if (!started.ok) return { ok: false, code: 'transient', error: `Browser session start failed (HTTP ${started.status})` };
      const startBody = (await started.json()) as { success?: boolean; data?: { sessionId?: string } };
      session = startBody.data?.sessionId ?? null;
      if (!startBody.success || !session) return { ok: false, code: 'transient', error: 'Browser session start returned no session.' };

      const navigated = await call(`/v1/sessions/${session}/navigate`, { url });
      if (!navigated.ok) return { ok: false, code: 'transient', error: `The page did not load (HTTP ${navigated.status})` };

      let stopped: BrowseActResult['stopped'] = 'cap_reached';
      let blocked: string | undefined;
      for (let step = 0; step < max_actions; step += 1) {
        const observed = await call(`/v1/sessions/${session}/observe`, { instruction: task, options: { model, timeout: 30000 } });
        if (!observed.ok) return { ok: false, code: 'transient', error: `Observe failed (HTTP ${observed.status})` };
        const observeBody = (await observed.json()) as { success?: boolean; data?: { result?: BrowserAction[] } };
        const action = observeBody.data?.result?.[0];
        if (!observeBody.success || !action) { stopped = step === 0 ? 'no_action_found' : 'task_done'; break; }
        if (isIrreversible(action)) { stopped = 'irreversible_blocked'; blocked = action.description; break; }
        const acted = await call(`/v1/sessions/${session}/act`, { input: action, options: { model, timeout: 30000 } });
        if (!acted.ok) return { ok: false, code: 'transient', error: `Act failed (HTTP ${acted.status})` };
        const actBody = (await acted.json()) as { success?: boolean };
        if (!actBody.success) { stopped = 'no_action_found'; break; }
        taken.push(action.description);
        record('browser_action', `Browse step ${step + 1}: ${action.description}`, { url, selector: action.selector, method: action.method ?? null });
      }

      const extracted = await call(`/v1/sessions/${session}/extract`, { instruction: 'Summarise what this page now shows, relative to the task.', options: { model, timeout: 30000 } });
      if (!extracted.ok) return { ok: false, code: 'transient', error: `Extraction failed (HTTP ${extracted.status})` };
      const extractBody = (await extracted.json()) as { success?: boolean; data?: { result?: unknown } };
      const data: BrowseActResult = {
        url, actions_taken: taken, stopped,
        ...(blocked !== undefined ? { blocked_action: blocked } : {}),
        data: extractBody.data?.result ?? null,
      };
      return { ok: true, data, source_taint: 'external' };
    } catch (error) {
      return { ok: false, code: 'transient', error: error instanceof Error ? error.message : String(error) };
    } finally {
      await end();
    }
  },
});
