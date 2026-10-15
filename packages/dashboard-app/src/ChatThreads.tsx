import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChatPanel } from './Chat';
import type { ChatThread } from './chat-model';
import { chatStore, threadsStore, type ThreadsStore } from './chat-store';
import { Icon, WaldoMark } from './icons';
import { relativeTime } from './time';

export const isThreadRoute = (value: string) => /^chat\/thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const titleOf = (thread: ChatThread | null) => thread?.title ?? 'New chat';
// The preview is the newest message's text; its Markdown marks would only read as noise in one line.
const plain = (text: string) => text.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
const go = (thread: string | null) => { window.location.hash = thread ? `#/chat/${thread}` : '#/chat'; };

function ThreadItem({ thread, current, now }: { thread: ChatThread; current: boolean; now: Date }) {
  return <a className="thread-item" href={`#/chat/${thread.thread_id}`} aria-current={current ? 'page' : undefined}>
    <span className="thread-line"><span className="thread-title">{titleOf(thread)}</span><span className="thread-time">{relativeTime(new Date(thread.last_activity_at).toISOString(), now)}</span></span>
    {thread.preview && <span className="thread-preview">{plain(thread.preview)}</span>}
  </a>;
}

// A thread's heading: its title, renamed in place, and the changes the owner can make to it.
function ThreadHead({ thread, id, threads, onMenu }: { thread: ChatThread | null; id: string; threads: ThreadsStore; onMenu: () => void }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy } = useSyncExternalStore(threads.subscribe, threads.get, threads.get);
  useEffect(() => { setRenaming(null); setError(null); setMore(false); }, [id]);
  const act = async (work: Promise<string | Error>, after?: () => void) => { const result = await work; if (result instanceof Error) setError(result.message); else { setError(null); after?.(); } };
  return <div className="chat-head thread-head reveal">
    <button type="button" className="quiet chat-menu" onClick={onMenu} aria-label="Show your chats"><Icon name="chat"/>Chats</button>
    {renaming === null
      ? <div className="thread-heading"><h1>{titleOf(thread)}</h1>{thread?.state === 'archived' && <span className="access-label">Archived</span>}</div>
      : <form className="thread-rename" onSubmit={event => { event.preventDefault(); if (thread && renaming.trim()) void act(threads.rename(thread, renaming.trim()), () => setRenaming(null)); }}>
        <label className="visually-hidden" htmlFor="thread-title">Chat title</label>
        <input id="thread-title" autoFocus maxLength={200} value={renaming} disabled={busy} onChange={event => setRenaming(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(null); }}/>
        <button className="primary" disabled={busy || !renaming.trim()}>Save</button><button type="button" className="quiet" onClick={() => setRenaming(null)}>Cancel</button>
      </form>}
    {thread && renaming === null && <button type="button" className="quiet thread-more" aria-expanded={more} aria-controls="thread-actions" onClick={() => setMore(value => !value)}>More</button>}
    {thread && renaming === null && <div id="thread-actions" className={`thread-actions${more ? ' open' : ''}`}>
      <button type="button" className="quiet" disabled={busy} onClick={() => setRenaming(thread.title ?? '')}>Rename</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(threads.archive(thread, thread.state !== 'archived'))}>{thread.state === 'archived' ? 'Unarchive' : 'Archive'}</button>
      <button type="button" className="quiet danger" disabled={busy} onClick={() => { if (window.confirm('Delete this chat? Its messages are erased. What Waldo learned here stays in memory, where you can correct it.')) void act(threads.remove(thread), () => go(null)); }}>Delete</button>
    </div>}
    {error && <p className="chat-notice" role="alert">{error}</p>}
  </div>;
}

// Chat with its threads: main, where Waldo also reaches you, and the owner's chats beside it, each with its own transcript
// and the same memory.
export function ChatWorkspace({ thread, zone, threads = threadsStore() }: { thread: string | null; zone?: string; threads?: ThreadsStore }) {
  const list = useSyncExternalStore(threads.subscribe, threads.get, threads.get);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { void threads.load(); const timer = window.setInterval(() => { setNow(new Date()); if (document.visibilityState !== 'hidden') void threads.load(); }, 30_000); return () => window.clearInterval(timer); }, [threads]);
  useEffect(() => { setOpen(false); }, [thread]);
  useEffect(() => { if (!open) return; const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [open]);
  const current = thread === null ? null : list.threads.find(item => item.thread_id === thread) ?? null;
  const active = list.threads.filter(item => item.state === 'active'), archived = list.threads.filter(item => item.state === 'archived');
  const start = async () => { const created = await threads.create(); if (created instanceof Error) setError(created.message); else { setError(null); go(created); } };
  const head = thread === null
    ? <div className="chat-head reveal"><button type="button" className="quiet chat-menu" onClick={() => setOpen(value => !value)} aria-label="Show your chats"><Icon name="chat"/>Chats</button><h1>Main chat</h1><p className="label">Same conversation as your Waldo app. Waldo reaches you here too.</p></div>
    : <ThreadHead thread={current} id={thread} threads={threads} onMenu={() => setOpen(value => !value)}/>;
  const locked = current?.state === 'archived'
    ? <div className="chat-locked" role="status"><p>This chat is archived. Unarchive it to keep talking here.</p><button type="button" className="primary" disabled={list.busy} onClick={() => void threads.archive(current, false)}>Unarchive</button></div>
    : undefined;
  return <div className="chat-workspace">
    <aside className={`chat-rail${open ? ' open' : ''}`} aria-label="Your chats">
      <div className="chat-rail-top"><button type="button" className="chat-new" disabled={list.busy} onClick={() => void start()}><Icon name="chat"/>New chat</button><button type="button" className="quiet chat-rail-close" onClick={() => setOpen(false)}>Close</button></div>
      {error && <p className="chat-notice" role="alert">{error}</p>}
      <nav aria-label="Chats">
        <a className="thread-item main" href="#/chat" aria-current={thread === null ? 'page' : undefined}>
          <span className="thread-line"><span className="thread-title"><WaldoMark size={12}/>Main chat</span></span>
          <span className="thread-preview">Where Waldo reaches you</span>
        </a>
        {list.phase === 'loading' && <i className="sk thread-sk" aria-hidden="true"/>}
        {active.map(item => <ThreadItem key={item.thread_id} thread={item} current={item.thread_id === thread} now={now}/>)}
      </nav>
      {list.phase === 'error' && <p className="meta">{list.error} <button type="button" className="quiet-link" onClick={() => void threads.load()}>Try again</button></p>}
      {archived.length > 0 && <details className="chat-archived" open={current?.state === 'archived' || undefined}><summary>Archived <span className="count">{archived.length}</span></summary>
        <nav aria-label="Archived chats">{archived.map(item => <ThreadItem key={item.thread_id} thread={item} current={item.thread_id === thread} now={now}/>)}</nav></details>}
    </aside>
    <ChatPanel key={thread ?? 'main'} zone={zone} thread={thread} store={chatStore(thread)} head={head} locked={locked}/>
  </div>;
}
