import { useEffect, useRef, useState } from 'react';
import { ChatRequestError } from './chat-model';
import {
  importFailureLine, importMemories, MEMORY_IMPORT_PROMPT, MEMORY_IMPORT_SOURCES, memoryImportAvailable, textRefusal,
  type MemoryImportResult, type MemoryImportSource,
} from './memory-import-model';

type Sent = { key: string; id: string };
const newId = () => `web-${crypto.randomUUID()}`;

// Settings › Setup: copy a prompt into another AI, paste back what it writes, and Waldo keeps what it says about the owner.
// Hidden while this Waldo does not take imports.
export function MemoryImportPanel() {
  const [available, setAvailable] = useState(false);
  const [source, setSource] = useState<MemoryImportSource>('chatgpt');
  const [text, setText] = useState('');
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<MemoryImportResult | null>(null);
  // A retry of the same paste reuses its request id, so a reply lost on the way back is answered from the first read.
  const sent = useRef<Sent | null>(null);

  useEffect(() => {
    let live = true;
    memoryImportAvailable().then(on => { if (live) setAvailable(on); }, () => {});
    return () => { live = false; };
  }, []);
  if (!available) return null;

  const copy = async () => {
    try { await navigator.clipboard.writeText(MEMORY_IMPORT_PROMPT); setCopied('copied'); } catch { setCopied('failed'); }
  };
  const submit = async () => {
    const refused = textRefusal(text);
    if (refused) { setProblem(refused); return; }
    const key = `${source}\n${text.trim()}`;
    if (sent.current?.key !== key) sent.current = { key, id: newId() };
    setBusy(true); setProblem(null); setResult(null);
    try { setResult(await importMemories(source, text, sent.current.id)); setText(''); sent.current = null; }
    catch (error) { setProblem(importFailureLine(error instanceof ChatRequestError ? error.status : 0)); }
    finally { setBusy(false); }
  };

  return <section className="panel memory-import" aria-labelledby="memory-import-title">
    <h2 id="memory-import-title">Bring in memories from another AI</h2>
    <p>If ChatGPT, Claude, Gemini or Grok already knows you, Waldo can start from what it knows. Copy this prompt into that AI, then paste what it writes below.</p>
    <details className="memory-import-prompt"><summary>See the prompt</summary><pre>{MEMORY_IMPORT_PROMPT}</pre></details>
    <div className="memory-import-actions">
      <button type="button" onClick={() => void copy()}>Copy prompt</button>
      <span role="status">{copied === 'copied' ? 'Copied.' : copied === 'failed' ? 'Couldn’t copy. Open “See the prompt” and copy it from there.' : ''}</span>
    </div>
    <label>Where it came from
      <select value={source} onChange={event => setSource(event.target.value as MemoryImportSource)}>
        {MEMORY_IMPORT_SOURCES.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select>
    </label>
    <label>What it wrote
      <textarea value={text} rows={10} placeholder="Paste the whole document here" onChange={event => { setText(event.target.value); setProblem(null); }}/>
    </label>
    <p className="memory-import-note">Waldo keeps what it says about you as “Waldo thinks” until you confirm it in <a href="#/memory">Memory</a>. It never keeps passwords, card numbers or health readings from it, and doesn’t store the document itself.</p>
    <div className="memory-import-actions">
      <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? 'Reading…' : 'Bring them in'}</button>
    </div>
    <p role="status" className={problem ? 'memory-import-problem' : undefined}>{problem ?? (result ? result.message : '')}</p>
  </section>;
}
