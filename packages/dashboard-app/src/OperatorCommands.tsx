import { useEffect, useState, type FormEvent } from 'react';
import { fetchControls } from './controls-model';
import { SignInRequired } from './model';

export const HARNESS_URL = '/console/dashboard/api/v1/harness';

const REFUSED: Record<number, string> = {
  404: 'Operator commands are off on this Waldo.',
  400: 'Waldo doesn’t know that command.',
  403: 'Your console session changed. Reload the page and try again.',
  429: 'Too many commands just now. Wait a minute and try again.',
};
const FAILED = 'The command didn’t finish. Try again.';

type Result = { kind: 'idle' } | { kind: 'running' } | { kind: 'output'; text: string } | { kind: 'refused'; message: string };

export async function runOperatorCommand(csrf: string, command: string): Promise<Result> {
  const response = await fetch(HARNESS_URL, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, body: new URLSearchParams({ csrf, command }) });
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) return { kind: 'refused', message: REFUSED[response.status] ?? FAILED };
  const body: unknown = await response.json().catch(() => null);
  const output = body && typeof body === 'object' ? (body as { output?: unknown }).output : undefined;
  return typeof output === 'string' ? { kind: 'output', text: output } : { kind: 'refused', message: FAILED };
}

// The operator commands Telegram took (/trace, /e2e, /usage, /langfuse, /heldrows, /fire, /ledger), run as the signed-in owner.
// Like every console action, the form appears only once the signed-in read has given this session's token.
export function OperatorCommandsPanel() {
  const [csrf, setCsrf] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  useEffect(() => {
    const abort = new AbortController();
    fetchControls('activity', abort.signal).then(read => { if (!abort.signal.aborted) setCsrf(read.csrf); }, () => undefined);
    return () => abort.abort();
  }, []);
  if (csrf === null) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!command.trim() || result.kind === 'running') return;
    setResult({ kind: 'running' });
    runOperatorCommand(csrf, command.trim()).then(setResult, (error: unknown) => setResult({ kind: 'refused', message: error instanceof SignInRequired ? error.message : FAILED }));
  };
  return <section className="panel operator-panel" aria-labelledby="operator-commands-title">
    <h2 id="operator-commands-title">Operator commands</h2>
    <p>The commands Telegram took: <code>/trace</code>, <code>/e2e</code>, <code>/usage</code>, <code>/langfuse</code>, <code>/heldrows</code>, <code>/fire &lt;job&gt;</code> and <code>/ledger</code>. A fire runs the job now, as it would on schedule.</p>
    <form className="operator-commands" onSubmit={submit}>
      <input name="operator-command" aria-label="Command" placeholder="/trace" value={command} onChange={event => setCommand(event.target.value)} autoComplete="off" spellCheck={false}/>
      <button type="submit" disabled={result.kind === 'running'}>{result.kind === 'running' ? 'Running…' : 'Run'}</button>
    </form>
    {result.kind === 'output' && <pre className="operator-output">{result.text}</pre>}
    {result.kind === 'refused' && <p role="alert">{result.message}</p>}
  </section>;
}
