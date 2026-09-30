import {
  PROVIDER_OF, TOOL_PERMISSIONS, triggerTypeSchema, browseActArgsSchema, browsePageArgsSchema, WALDO_CHAT_MODEL,
  type ToolHandler, type ToolName, type BrowsePageArgs, type BrowseActArgs,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../dispatcher';
import type { BrowserSubmitProposal } from '../../channels/approvals';

// Stagehand v3 hosted HTTP API (openapi v3.1.0, browserbase/stagehand packages/server-v3).
// Plain fetch - no SDK, no Node host. Keys stay server-side; session ids never reach model text.
const BASE = 'https://api.stagehand.browserbase.com';
const MODEL = `${PROVIDER_OF[WALDO_CHAT_MODEL]}/${WALDO_CHAT_MODEL}`;


// Failure bodies from the browser service carry the actionable reason (e.g. schema rejections).
// Surface a short sanitized slice - never keys, project ids or session ids.
const failDetail = async (res: Response, secrets: readonly (string | undefined | null)[]): Promise<string> => {
  try {
    const text = await res.text();
    let msg = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
      const m = parsed.message ?? parsed.error;
      if (typeof m === 'string') msg = m;
      else if (m !== undefined) msg = JSON.stringify(m);
    } catch { /* plain text body */ }
    let clean = msg.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    for (const s of secrets) {
      if (s && s.length > 3) clean = clean.split(s).join('[redacted]');
    }
    clean = clean.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[session]');
    if (clean.length > 200) clean = `${clean.slice(0, 200)}...`;
    return clean ? ` - ${clean}` : '';
  } catch {
    return '';
  }
};

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
      if (!started.ok) return { ok: false, code: 'transient', error: `Browser session start failed (HTTP ${started.status})${await failDetail(started, [apiKey, projectId])}` };
      const startBody = (await started.json()) as { success?: boolean; data?: { sessionId?: string } };
      session = startBody.data?.sessionId ?? null;
      if (!startBody.success || !session) return { ok: false, code: 'transient', error: 'Browser session start returned no session.' };

      const navigated = await call(`/v1/sessions/${session}/navigate`, { url });
      if (!navigated.ok) return { ok: false, code: 'transient', error: `The page did not load (HTTP ${navigated.status})${await failDetail(navigated, [apiKey, projectId, session])}` };

      const model = modelApiKey ? { modelName: MODEL, apiKey: modelApiKey } : MODEL;
      const extracted = await call(`/v1/sessions/${session}/extract`, { instruction, options: { model, timeout: 30000 } });
      if (extracted.status === 401 || extracted.status === 403) return { ok: false, code: 'auth_failed', error: `The browser key was rejected (HTTP ${extracted.status}) - it needs replacing.` };
      if (!extracted.ok) return { ok: false, code: 'transient', error: `Extraction failed (HTTP ${extracted.status})${await failDetail(extracted, [apiKey, projectId, session])}` };
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

// Binding extraction is evidence, not a default. Empty or malformed evidence must
// never turn into an approval that commits an unbound external action.
const pageBinding = (body: unknown): Record<string, string> | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const envelope = body as { success?: unknown; data?: { result?: unknown } };
  if (envelope.success !== true) return null;
  const value = envelope.data?.result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key, item]) => !key.trim() || typeof item !== 'string' || !item.trim())) return null;
  return Object.fromEntries(entries) as Record<string, string>;
};

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
  stopped: 'task_done' | 'cap_reached' | 'irreversible_blocked' | 'approval_pending' | 'no_action_found';
  blocked_action?: string;
  proposal_id?: string;
  data: unknown;
}>;

export const browseActHandler = (
  apiKey: string | undefined,
  projectId: string | undefined,
  modelApiKey: string | undefined,
  record: (kind: string, summary: string, payload: unknown) => void = () => undefined,
  proposeSubmit?: (payload: BrowserSubmitProposal) => Promise<string>,
  fetcher: typeof fetch = fetch,
): ToolHandler<BrowseActArgs, BrowseActResult, ToolDispatcherContext> => ({
  name: 'browse_act',
  description: 'Open a public web page in a real browser and take a few small in-page actions (click, type, scroll) toward a task, then report what the page shows. Capped steps. It will never submit, pay, send, book, delete or log in - it stops and reports instead.',
  schema: browseActArgsSchema,
  trigger_allowlist: allowlist('browse_act'),
  autonomy_gated: false,
  mutates_state: true,
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
      if (!started.ok) return { ok: false, code: 'transient', error: `Browser session start failed (HTTP ${started.status})${await failDetail(started, [apiKey, projectId])}` };
      const startBody = (await started.json()) as { success?: boolean; data?: { sessionId?: string } };
      session = startBody.data?.sessionId ?? null;
      if (!startBody.success || !session) return { ok: false, code: 'transient', error: 'Browser session start returned no session.' };

      const navigated = await call(`/v1/sessions/${session}/navigate`, { url });
      if (!navigated.ok) return { ok: false, code: 'transient', error: `The page did not load (HTTP ${navigated.status})${await failDetail(navigated, [apiKey, projectId, session])}` };

      let stopped: BrowseActResult['stopped'] = 'cap_reached';
      let blocked: string | undefined;
      for (let step = 0; step < max_actions; step += 1) {
        const observed = await call(`/v1/sessions/${session}/observe`, { instruction: task, options: { model, timeout: 30000 } });
        if (!observed.ok) return { ok: false, code: 'transient', error: `Observe failed (HTTP ${observed.status})${await failDetail(observed, [apiKey, projectId, session])}` };
        const observeBody = (await observed.json()) as { success?: boolean; data?: { result?: BrowserAction[] } };
        const action = observeBody.data?.result?.[0];
        if (!observeBody.success || !action) { stopped = step === 0 ? 'no_action_found' : 'task_done'; break; }
        if (isIrreversible(action)) {
          if (proposeSubmit) {
            // Capture the exact binding from the page NOW; the executor re-reads and compares before acting.
            const bind = await call(`/v1/sessions/${session}/extract`, {
              instruction: 'Extract the facts this action would commit, as flat key/value JSON: total price, items, recipient, destination, dates - whatever this page shows that the action commits. Empty object if none.',
              options: { model, timeout: 30000 },
            });
            const binding = bind.ok ? pageBinding(await bind.json()) : null;
            if (binding === null) return { ok: false, code: 'rejected', error: 'The page facts could not be verified, so no approval was proposed. Ask me to look again.', source_taint: 'external' };
            const proposal = await proposeSubmit({ url, action, binding, steps: taken });
            record('browser_submit_proposed', `Approval needed: ${action.description}`, { url, proposal });
            return { ok: true, data: { url, actions_taken: taken, stopped: 'approval_pending', blocked_action: action.description, proposal_id: proposal, data: null }, source_taint: 'external' };
          }
          stopped = 'irreversible_blocked'; blocked = action.description; break;
        }
        const acted = await call(`/v1/sessions/${session}/act`, { input: action, options: { model, timeout: 30000 } });
        if (!acted.ok) return { ok: false, code: 'transient', error: `Act failed (HTTP ${acted.status})${await failDetail(acted, [apiKey, projectId, session])}` };
        const actBody = (await acted.json()) as { success?: boolean };
        if (!actBody.success) { stopped = 'no_action_found'; break; }
        taken.push(action.description);
        record('browser_action', `Browse step ${step + 1}: ${action.description}`, { url, selector: action.selector, method: action.method ?? null });
      }

      const extracted = await call(`/v1/sessions/${session}/extract`, { instruction: 'Summarise what this page now shows, relative to the task.', options: { model, timeout: 30000 } });
      if (!extracted.ok) return { ok: false, code: 'transient', error: `Extraction failed (HTTP ${extracted.status})${await failDetail(extracted, [apiKey, projectId, session])}` };
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

export type BrowserSubmitOutcome =
  | Readonly<{ status: 'rejected'; message: string }>
  | Readonly<{ status: 'acknowledged_unverified'; message: string }>
  | Readonly<{ status: 'uncertain'; message: string }>
  | Readonly<{ status: 'verified_with_receipt'; message: string; receipt: Readonly<{
      id: string; observed_at: string; source: 'provider' | 'controlled_fixture';
      action_digest: string; binding_digest: string;
    }> }>;

// B-tool-3 executor: runs ONLY after the owner's explicit approval, in a fresh session.
// Re-resolves the action on the live page, re-reads the binding, and acts only when the
// page still shows exactly what was approved. Any drift aborts.
export const executeBrowserSubmit = async (
  apiKey: string | undefined,
  projectId: string | undefined,
  modelApiKey: string | undefined,
  proposal: BrowserSubmitProposal,
  fetcher: typeof fetch = fetch,
): Promise<BrowserSubmitOutcome> => {
  const rejected = (message: string): BrowserSubmitOutcome => ({ status: 'rejected', message });
  const uncertain = (message: string): BrowserSubmitOutcome => ({ status: 'uncertain', message });
  let actAttempted = false;
  if (!apiKey || !projectId) return rejected('Browsing is not set up on this Waldo yet, so nothing happened.');
  const headers = { 'x-bb-api-key': apiKey, 'x-bb-project-id': projectId, 'content-type': 'application/json' };
  const call = (path: string, body: object) => fetcher(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const model = modelApiKey ? { modelName: MODEL, apiKey: modelApiKey } : MODEL;
  let session: string | null = null;
  const end = () => (session ? call(`/v1/sessions/${session}/end`, {}).catch(() => undefined) : Promise.resolve());
  try {
    const started = await call('/v1/sessions/start', { modelName: MODEL, verbose: 0 });
    if (!started.ok) return rejected(`The browser session could not start (HTTP ${started.status}), so nothing happened.`);
    const startBody = (await started.json()) as { success?: boolean; data?: { sessionId?: string } };
    session = startBody.data?.sessionId ?? null;
    if (!startBody.success || !session) return rejected('The browser session could not start, so nothing happened.');

    const navigated = await call(`/v1/sessions/${session}/navigate`, { url: proposal.url });
    if (!navigated.ok) return rejected(`The page did not load (HTTP ${navigated.status}), so nothing happened.`);

    const observed = await call(`/v1/sessions/${session}/observe`, { instruction: proposal.action.description, options: { model, timeout: 30000 } });
    if (!observed.ok) return rejected(`The action could not be found again (HTTP ${observed.status}), so nothing happened.`);
    const observeBody = (await observed.json()) as { success?: boolean; data?: { result?: BrowserAction[] } };
    // An approval is for a particular observed action, never whichever action is first
    // on a changed page. Re-observe to locate it, but refuse a changed target/method.
    const found = observeBody.data?.result?.find((a) =>
      a.description === proposal.action.description && a.selector === proposal.action.selector &&
      a.method === proposal.action.method && JSON.stringify(a.arguments ?? []) === JSON.stringify(proposal.action.arguments ?? []));
    if (!observeBody.success || !found) return rejected('That action is no longer on the page, so nothing happened. Ask me to look again.');

    const extracted = await call(`/v1/sessions/${session}/extract`, {
      instruction: 'Extract the facts this action would commit, as flat key/value JSON: total price, items, recipient, destination, dates - whatever this page shows that the action commits. Empty object if none.',
      options: { model, timeout: 30000 },
    });
    if (!extracted.ok) return rejected(`The page state could not be re-read (HTTP ${extracted.status}), so nothing happened.`);
    const current = pageBinding(await extracted.json());
    const approved = pageBinding({ success: true, data: { result: proposal.binding } });
    if (current === null || approved === null) return rejected('The page facts could not be verified, so nothing happened. Ask me to look again.');
    // Values can be recipients, item codes or case-sensitive paths. Compare the
    // complete set exactly; key order alone carries no meaning.
    const keys = new Set([...Object.keys(approved), ...Object.keys(current)]);
    const drift = [...keys].filter((key) => approved[key] !== current[key]);
    if (drift.length > 0) {
      const changed = drift.map((key) => `${key}: approved "${approved[key] ?? 'nothing'}" but page now shows "${current[key] ?? 'nothing'}"`).join('; ');
      return rejected(`I did NOT do it - the page changed since you approved: ${changed}. Ask me to set it up again if you still want it.`);
    }

    actAttempted = true;
    const acted = await call(`/v1/sessions/${session}/act`, { input: found, options: { model, timeout: 30000 } });
    if (!acted.ok) return uncertain(`The final action failed (HTTP ${acted.status}). It may or may not have happened - check the page before retrying.`);
    const actBody = (await acted.json()) as { success?: boolean };
    if (actBody.success !== true) return uncertain('The final action was not acknowledged by the browser. It may or may not have happened - check the page before retrying.');
    return { status: 'acknowledged_unverified', message: 'The browser accepted the action, but the final outcome is not verified. Do not retry the action until the result has been checked on the page.' };
  } catch {
    return actAttempted
      ? uncertain('The browser response was lost. The outcome is unknown - check the page before retrying.')
      : rejected('The browser could not verify the page, so nothing happened. Ask me to look again.');
  } finally {
    await end();
  }
};
