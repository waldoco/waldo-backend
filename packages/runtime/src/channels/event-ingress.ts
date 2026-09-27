import { sameSecret } from './telegram-webhook';

// A8: generic webhook/event ingress. One verified HTTP channel for external services that
// push events (GitHub, uptime monitors, anything that can sign or token a POST), mirroring
// the telegram-webhook shape: verify -> 200 fast -> waitUntil routes to the owning DO.
//
// Sources are configured in WALDO_EVENT_SOURCES (JSON): each names its secret, its
// verification shape, and the owner DO it is pinned to. Owner binding is explicit config,
// not a directory presence: there is no linking UI for event sources in alpha, and a fake
// directory abstraction would be a placeholder. When a real linking flow lands, config
// migrates to presences.
//
// Verification shapes:
//   "hmac-sha256": GitHub/Meta style - hex HMAC of the raw body, sent as `sha256=<hex>`
//                  in x-hub-signature-256.
//   "token":       shared secret in the x-waldo-event-token header (generic sources).
//
// Queue buffer evaluation (owed by the A8 slice, decided here): DEFERRED. The webhook
// returns 200 at once and waitUntil carries the routing, matching both chat channels; the
// providers worth integrating first retry on non-2xx, and alpha event volume is low. A
// Queue buys durable delivery against waitUntil failure and burst absorption - adopt when
// the first high-volume source lands or a provider without retries does. Wrapper cost when
// that day comes: a queues binding + consumer handler + a line in the deploy packet.
//
// Taint posture: envelope text is external content. It is stored (capped) in background_runs
// and shown in the console escaped, and sent to the owner as a plain Telegram note - it is
// NEVER recorded as an episode and NEVER fed to a turn, so a crafted commit message cannot
// ride episode recall into the model's context.

export const EVENT_INGRESS_PREFIX = '/events/';

export type EventSourceConfig = Readonly<{
  secret: string;
  verify: 'hmac-sha256' | 'token';
  owner_do: string;
  timezone?: string;
  notify?: boolean;
}>;

export type EventEnvelope = Readonly<{
  subject: string;
  kind: string;
  title: string;
  detail?: string;
  url?: string;
  occurred_at?: string;
}>;

export type EventIngressEnv = Readonly<{
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
  WALDO_EVENT_SOURCES?: string;
}>;

const cap = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export const parseEventSources = (raw: string | undefined): Readonly<Record<string, EventSourceConfig>> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, EventSourceConfig>;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const hmacSha256Hex = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const verify = async (config: EventSourceConfig, request: Request, body: string): Promise<boolean> => {
  if (config.verify === 'token') return sameSecret(request.headers.get('x-waldo-event-token') ?? '', config.secret);
  const given = request.headers.get('x-hub-signature-256') ?? '';
  return sameSecret(given, `sha256=${await hmacSha256Hex(config.secret, body)}`);
};

// A pre-formatted envelope from a generic source: subject/kind/title required, everything
// capped. Unknown fields are dropped; nothing is trusted beyond shape.
const genericEnvelope = (payload: Record<string, unknown>): EventEnvelope | null => {
  const subject = typeof payload.subject === 'string' ? payload.subject : '';
  const kind = typeof payload.kind === 'string' ? payload.kind : '';
  const title = typeof payload.title === 'string' ? payload.title : '';
  if (!subject || !kind || !title) return null;
  return {
    subject: cap(subject, 120), kind: cap(kind, 60), title: cap(title, 200),
    ...(typeof payload.detail === 'string' ? { detail: cap(payload.detail, 400) } : {}),
    ...(typeof payload.url === 'string' ? { url: cap(payload.url, 300) } : {}),
    ...(typeof payload.occurred_at === 'string' ? { occurred_at: cap(payload.occurred_at, 40) } : {}),
  };
};

// GitHub push + pull_request events, reduced to the generic envelope. Commit messages and PR
// titles are contributor-controlled text - capped here, tainted all the way down.
const githubEnvelope = (event: string, payload: Record<string, unknown>): EventEnvelope | null => {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? 'unknown repo';
  if (event === 'push') {
    const commits = Array.isArray(payload.commits) ? payload.commits as { message?: string }[] : [];
    const head = (payload.head_commit as { message?: string } | undefined)?.message ?? commits[0]?.message ?? '';
    const first = head.split('\n')[0] ?? '';
    const pusher = (payload.pusher as { name?: string } | undefined)?.name ?? 'someone';
    return {
      subject: repo, kind: 'push',
      title: cap(`${pusher} pushed ${commits.length || 1} commit${commits.length === 1 ? '' : 's'}: ${first}`, 200),
      ...(typeof payload.compare === 'string' ? { url: cap(payload.compare, 300) } : {}),
    };
  }
  if (event === 'pull_request') {
    const pr = payload.pull_request as { title?: string; number?: number; html_url?: string } | undefined;
    if (!pr) return null;
    const action = typeof payload.action === 'string' ? payload.action : 'updated';
    return {
      subject: repo, kind: `pull_request.${cap(action, 30)}`,
      title: cap(`PR #${pr.number ?? '?'} ${action}: ${pr.title ?? ''}`, 200),
      ...(typeof pr.html_url === 'string' ? { url: cap(pr.html_url, 300) } : {}),
    };
  }
  return null;
};

export const handleEventIngress = async (
  request: Request,
  env: EventIngressEnv,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response> => {
  const url = new URL(request.url);
  const source = url.pathname.slice(EVENT_INGRESS_PREFIX.length).replace(/\/+$/, '');
  const config = parseEventSources(env.WALDO_EVENT_SOURCES)[source];
  if (request.method !== 'POST' || !config || !env.TELEGRAM_OWNER_DO || !source || source.includes('/')) {
    return new Response('not found', { status: 404 });
  }
  const body = await request.text();
  if (!(await verify(config, request, body))) return new Response('forbidden', { status: 403 });
  let envelope: EventEnvelope | null = null;
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    envelope = source === 'github'
      ? githubEnvelope(request.headers.get('x-github-event') ?? '', payload)
      : genericEnvelope(payload);
  } catch {
    envelope = null;
  }
  // Unknown shapes are acknowledged and dropped: a verified source sending noise must not
  // become a retry storm at the provider.
  if (!envelope) return new Response('ok');
  const owners = env.TELEGRAM_OWNER_DO;
  const origin = url.origin;
  const notify = config.notify !== false;
  waitUntil((async () => {
    const headers: Record<string, string> = {
      'x-waldo-origin': origin,
      'x-waldo-event-source': source,
      'x-waldo-event-notify': notify ? '1' : '0',
    };
    if (config.timezone) headers['x-waldo-timezone'] = config.timezone;
    return owners.get(owners.idFromName(config.owner_do)).fetch('https://telegram-owner/event', { method: 'POST', body: JSON.stringify(envelope), headers });
  })().catch((error: unknown) => console.log(JSON.stringify({ hop: 'event_route', ok: false, error: String(error) }))));
  return new Response('ok');
};
