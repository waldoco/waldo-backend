import { useEffect, useState, type FormEvent } from 'react';
import { SignInRequired } from './model';

export const HARNESS_URL = '/console/dashboard/api/v1/harness';

const REFUSED: Record<number, string> = {
  404: 'Diagnostics are off on this Waldo.',
  400: 'Waldo doesn’t know that command.',
  403: 'Your console session changed. Reload the page and try again.',
};
const ADMIN_ONLY = 'That command is for Waldo admins.';
// A fire is spaced and capped per owner, so the wait can be minutes or hours: say how long, from the answer's retry-after.
const tooMany = (retryAfter: string | null): string => {
  const minutes = Math.ceil(Number(retryAfter) / 60);
  if (!Number.isFinite(minutes) || minutes <= 1) return 'Too many commands just now. Wait a minute and try again.';
  return `Too many just now. Try again in ${minutes <= 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`}.`;
};
const FAILED = 'The command didn’t finish. Try again.';

type Result = { kind: 'idle' } | { kind: 'running' } | { kind: 'output'; text: string } | { kind: 'refused'; message: string };

type Offer = { csrf: string; commands: readonly string[] };
// Whether this Waldo takes diagnostics, which this owner may run, and this session's token for them. Null when it does not (404).
export async function readOperatorCommands(signal?: AbortSignal): Promise<Offer | null> {
  const response = await fetch(HARNESS_URL, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal });
  if (response.status === 404) return null;
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error(FAILED);
  const body: unknown = await response.json().catch(() => null);
  const offer = body as { version?: unknown; csrf?: unknown; commands?: unknown } | null;
  if (!offer || offer.version !== 1 || typeof offer.csrf !== 'string' || !offer.csrf || !Array.isArray(offer.commands) || !offer.commands.every(c => typeof c === 'string')) throw new Error(FAILED);
  return { csrf: offer.csrf, commands: offer.commands as string[] };
}

export async function runOperatorCommand(csrf: string, command: string): Promise<Result> {
  const response = await fetch(HARNESS_URL, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, body: new URLSearchParams({ csrf, command }) });
  if (response.status === 401) throw new SignInRequired();
  const body: unknown = await response.json().catch(() => null);
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (response.status === 429) return { kind: 'refused', message: tooMany(response.headers.get('retry-after')) };
  if (response.status === 403 && error === 'admin_only') return { kind: 'refused', message: ADMIN_ONLY };
  if (!response.ok) return { kind: 'refused', message: REFUSED[response.status] ?? FAILED };
  const output = body && typeof body === 'object' ? (body as { output?: unknown }).output : undefined;
  return typeof output === 'string' ? { kind: 'output', text: output } : { kind: 'refused', message: FAILED };
}

// Diagnostics (/trace, /e2e, /usage, /heldrows, /ledger, and for admins /langfuse and /fire), run as the signed-in owner on
// their own Waldo. The panel shows only on a Waldo that takes them, and, like every console action, only once the signed-in
// read gave this session's token. It lists the commands the read offered.
export function OperatorCommandsPanel() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [command, setCommand] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  useEffect(() => {
    const abort = new AbortController();
    readOperatorCommands(abort.signal).then(read => { if (!abort.signal.aborted) setOffer(read); }, () => undefined);
    return () => abort.abort();
  }, []);
  if (offer === null) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!command.trim() || result.kind === 'running') return;
    setResult({ kind: 'running' });
    runOperatorCommand(offer.csrf, command.trim()).then(setResult, (error: unknown) => setResult({ kind: 'refused', message: error instanceof SignInRequired ? error.message : FAILED }));
  };
  return <section className="panel operator-panel" aria-labelledby="operator-commands-title">
    <h2 id="operator-commands-title">Diagnostics</h2>
    <p>{offer.commands.map((name, index) => <span key={name}>{index ? ', ' : ''}<code>{name}</code></span>)}.{offer.commands.includes('/fire') && <> <code>/fire &lt;job&gt;</code> runs the job now, as it would on schedule.</>}</p>
    <form className="operator-commands" onSubmit={submit}>
      <input name="operator-command" aria-label="Command" placeholder="/trace" value={command} onChange={event => setCommand(event.target.value)} autoComplete="off" spellCheck={false}/>
      <button type="submit" disabled={result.kind === 'running'}>{result.kind === 'running' ? 'Running…' : 'Run'}</button>
    </form>
    {result.kind === 'output' && <pre className="operator-output">{result.text}</pre>}
    {result.kind === 'refused' && <p role="alert">{result.message}</p>}
  </section>;
}
