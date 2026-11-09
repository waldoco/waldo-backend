import { signInHref } from './model';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { CHAT_TEXT_MAX, visibleText, type ChatActivityKind, type ChatMessage, type ChatPart } from './chat-model';
import { anyWorking, chatStore, subscribeAnyChat, type ChatStore, type LocalMessage } from './chat-store';
import { ChatText } from './chat-text';
import { greeting } from './greeting';
import { Icon, WaldoMark } from './icons';

const useChat = (store: ChatStore) => useSyncExternalStore(store.subscribe, store.get, store.get);

const zoneOr = (zone: string | undefined) => { try { if (zone) { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } } catch { /* fall through */ } return Intl.DateTimeFormat().resolvedOptions().timeZone; };
const dayKey = (at: number, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const dayLabel = (at: number, zone: string, now: number) => {
  const key = dayKey(at, zone);
  if (key === dayKey(now, zone)) return 'Today';
  if (key === dayKey(now - 86_400_000, zone)) return 'Yesterday';
  return new Intl.DateTimeFormat('en', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', ...(key.slice(0, 4) === dayKey(now, zone).slice(0, 4) ? {} : { year: 'numeric' }) }).format(at);
};
const clock = (at: number, zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(at);
const exact = (at: number, zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
const elapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const CHANNEL: Record<string, string> = { telegram: 'Telegram', imessage: 'iMessage', whatsapp: 'WhatsApp' };
const KIND: Record<string, string> = { calendar_change: 'Calendar change', email_send: 'Email', message_send: 'Message', agent_mail_send: 'Email as Waldo', browser_submit: 'Web form', mcp_call: 'Connected tool', google_task_change: 'Google Tasks change' };
const humanize = (kind: string) => kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

// Suggestions use only what Waldo can do today: Calendar, Gmail, Tasks, reminders and the web.
const SUGGESTIONS = ['What’s on my calendar tomorrow?', 'Find me a free hour this week for deep work', 'Anything in my inbox that needs a reply?', 'Remind me to call home at 7 pm'];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1600); return () => window.clearTimeout(timer); }, [copied]);
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return null;
  return <button type="button" className="chat-action" aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy'} onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined); }}>
    <Icon name={copied ? 'check' : 'entry'}/><span>{copied ? 'Copied' : 'Copy'}</span></button>;
}

function Approval({ part, zone }: { part: Extract<ChatPart, { type: 'approval' }>; zone: string }) {
  const calendar = part.kind === 'calendar_change';
  return <div className="chat-card">
    <div className="chat-card-head"><span className="access-label needs">Needs your OK</span><span className="label">{KIND[part.kind] ?? humanize(part.kind)}</span></div>
    <p className="strong">{part.question ?? part.fallback_text.split('\n')[0]}</p>
    <details className="chat-fold"><summary>Exact details</summary><pre>{part.review}</pre></details>
    <p className="meta">{calendar ? 'Approve or decline it in Waiting.' : 'Approve it in the Waldo app; you can decline it in Waiting.'} Nothing happens until you decide. Open until {exact(part.expires_at, zone)}.</p>
    <a className="quiet-link" href="#/waiting">Review in Waiting</a>
  </div>;
}

// What Waldo's tools did on this turn, from their typed receipts, never from the reply's words.
function Trace({ part, zone }: { part: Extract<ChatPart, { type: 'receipt' }>; zone: string }) {
  const failed = part.items.filter(item => item.outcome === 'failed').length, unsure = part.items.filter(item => item.outcome === 'unconfirmed').length;
  const count = part.items.length + part.more;
  return <details className="chat-trace">
    <summary><span className={`trace-dot${failed ? ' failed' : unsure ? ' unsure' : ''}`} aria-hidden="true"/>What Waldo did <span className="count">{count}</span>{failed > 0 && <span className="access-label failed">{failed} failed</span>}{unsure > 0 && <span className="access-label">{unsure} unconfirmed</span>}</summary>
    <ol>{part.items.map((item, i) => <li key={i} style={{ '--i': i } as React.CSSProperties}>
      <span className={`trace-step ${item.outcome}`} aria-hidden="true">{item.outcome === 'failed' ? '!' : item.outcome === 'unconfirmed' ? '?' : <Icon name="check"/>}</span>
      <span className="trace-what"><span className="strong">{humanize(item.kind)}</span>{item.target && <span className="trace-target"> · {item.target}</span>}</span>
      <span className="meta time" title={exact(item.at, zone)}>{clock(item.at, zone)}</span>
      <span className="visually-hidden">{item.outcome === 'accepted' ? 'accepted by the tool' : item.outcome}</span>
    </li>)}{part.more > 0 && <li className="meta">and {part.more} more</li>}</ol>
    <p className="meta">Accepted means the tool took the request, not that the other system confirmed it.</p>
  </details>;
}

// `shown`: the draft this reply replaces, whose words stay as they were while only what came after them fades in.
function WaldoMessage({ message, zone, arrived, replies, onReply, shown }: { message: ChatMessage; zone: string; arrived: boolean; replies: boolean; onReply: (text: string) => void; shown?: string }) {
  const text = visibleText(message);
  return <article className={`chat-msg waldo${arrived ? ' arrived' : ''}`} aria-label="Waldo">
    <span className="chat-avatar" aria-hidden="true"><WaldoMark size={14}/></span>
    <div className="chat-body">
      {text && <div className="chat-prose"><ChatText text={text} reveal={shown === undefined ? undefined : { shown, key: message.id }}/></div>}
      {message.parts.map((part, i) => part.type === 'approval' ? <Approval key={i} part={part} zone={zone}/>
        : part.type === 'receipt' ? <Trace key={i} part={part} zone={zone}/>
          : part.type === 'artifact' ? <p key={i} className="meta">File: {part.title}. Open it in the Waldo app.</p>
            : part.type === 'operation' && part.state !== 'completed' ? <p key={i}><span className="access-label">{part.state === 'interrupted' ? 'Didn’t finish' : part.state === 'revoked' ? 'Stopped' : 'Still working'}</span></p> : null)}
      {replies && message.parts.filter((p): p is Extract<ChatPart, { type: 'quick_replies' }> => p.type === 'quick_replies').map((part, i) => <div key={`q${i}`} className="chat-replies" role="group" aria-label="Suggested replies">
        {part.choices.map((choice, n) => <button key={choice.id} type="button" style={{ '--i': n } as React.CSSProperties} onClick={() => onReply(choice.label)}>{choice.label}</button>)}</div>)}
      <div className="chat-meta">{message.created_at !== null && <time className="time" dateTime={new Date(message.created_at).toISOString()} title={exact(message.created_at, zone)}>{clock(message.created_at, zone)}</time>}
        {CHANNEL[message.channel] && <span>via {CHANNEL[message.channel]}</span>}<CopyButton text={text || message.text}/></div>
    </div>
  </article>;
}

function OwnerMessage({ text, at, zone, channel, status }: { text: string; at: number | null; zone: string; channel?: string; status?: React.ReactNode }) {
  return <article className="chat-msg owner" aria-label="You">
    <div className="chat-bubble"><ChatText text={text}/></div>
    <div className="chat-meta"><CopyButton text={text}/>{status}{channel && CHANNEL[channel] && <span>via {CHANNEL[channel]}</span>}
      {at !== null && <time className="time" dateTime={new Date(at).toISOString()} title={exact(at, zone)}>{clock(at, zone)}</time>}</div>
  </article>;
}

function localStatus(item: LocalMessage, store: ChatStore) {
  if (item.state === 'sending') return <span className="chat-status">Sending…</span>;
  if (item.state === 'failed') return <span className="chat-status failed" role="alert">Not sent. {item.error} <button type="button" className="quiet-link" onClick={() => store.retry(item.clientId)}>Retry</button> <button type="button" className="quiet-link" onClick={() => store.dismiss(item.clientId)}>Remove</button></span>;
  if (item.state === 'admitted' || item.state === 'running') return <span className="chat-status">Sent</span>;
  return null;
}

// The reply as it is written, laid out as the reply that will take its place, so that one lands where these words are. The words stay out
// of the live log: a screen reader hears the reply once, when it lands. `foot` is what shows under them while the turn runs.
function Draft({ id, text, foot }: { id: string; text: string; foot?: ReactNode }) {
  return <article className="chat-msg waldo streaming" aria-label="Waldo">
    <span className={`chat-avatar${foot ? ' pulse-ring' : ''}`} aria-hidden="true"><WaldoMark size={14}/></span>
    <div className="chat-body">
      <div className="chat-prose chat-draft" aria-hidden="true"><ChatText text={text} reveal={{ live: true, key: `draft-${id}` }}/></div>
      {foot}
    </div>
  </article>;
}

// A turn that closed without a normal reply says so, with what can be done next, under any words it had shown, which are kept as they
// were and offer nothing to copy: they are not a reply Waldo finished.
function Closure({ item, store }: { item: LocalMessage; store: ChatStore }) {
  // The server closes a stopped turn as interrupted, with this reason, whether it was stopped here or in the app.
  const stopped = item.closedReason === 'cancelled';
  const ended = item.closedReason === 'session_revoked';
  if (item.state === 'sending' || item.state === 'failed' || item.state === 'admitted' || item.state === 'running' || (item.state === 'completed' && !item.effectsUnconfirmed)) return null;
  const words = stopped ? 'You stopped this one.' : ended ? 'This sign-in ended before Waldo finished.' : item.state === 'interrupted' ? 'Waldo didn’t finish this one.' : item.state === 'revoked' ? 'Waldo stopped before replying.' : '';
  return <>
    {item.draft && <article className="chat-msg waldo chat-unfinished" aria-label="Waldo, unfinished">
      <span className="chat-avatar" aria-hidden="true"><WaldoMark size={14}/></span>
      <div className="chat-body"><div className="chat-prose"><ChatText text={item.draft}/></div></div>
    </article>}
    <div className="chat-closure" role="status"><Icon name="warning"/><div><p>{words}{item.effectsUnconfirmed ? ' Something Waldo had already started may have happened. Check before you rely on it.' : ''}</p>
      <div className="chat-closure-actions">{!stopped && <button type="button" className="quiet-link" onClick={() => store.askAgain(item.clientId)}>Ask again</button>}<button type="button" className="quiet-link" onClick={() => store.dismiss(item.clientId)}>Dismiss</button></div></div></div>
  </>;
}

// What the working row says while the turn's tools run and no reply is written yet.
const ACTIVITY_WORDS: Record<ChatActivityKind, string> = {
  mail: 'Checking your email…', calendar: 'Checking your calendar…', tasks: 'Checking your tasks…', web: 'Looking that up…',
  files: 'Reading your files…', health: 'Looking at your health data…', memory: 'Checking what I remember…', reminders: 'Checking your reminders…',
  artifacts: 'Working on the document…', settings: 'Checking your settings…', skills: 'Finding the right tool…', actions: 'Getting that ready…', working: 'Working on it',
};

function Working({ item, queued, store, now }: { item: LocalMessage; queued: number; store: ChatStore; now: number }) {
  const ms = now - item.sentAt;
  const status = <>
      <p className="chat-working"><span className="typing" aria-hidden="true"><i/><i/><i/></span><span className="shimmer">{item.state !== 'running' ? 'Waldo has your message' : item.activity && !item.draft ? ACTIVITY_WORDS[item.activity.kind] : 'Working on it'}</span>
        <span className="meta time" aria-label={`${Math.floor(ms / 1000)} seconds`}>{elapsed(ms)}</span>{queued > 0 && <span className="meta">· {queued} more queued</span>}</p>
      {ms > 45_000 && <p className="meta">Bigger errands can take a few minutes. You can leave this page; the reply will be here.</p>}
      <button type="button" className="quiet" disabled={item.stopping || item.state === 'sending'} onClick={() => void store.stop(item.clientId)}>{item.stopping ? 'Stopping…' : 'Stop'}</button>
  </>;
  if (item.draft) return <Draft id={item.clientId} text={item.draft} foot={<div className="chat-draft-foot" role="status" aria-live="polite">{status}</div>}/>;
  return <div className="chat-msg waldo working" role="status" aria-live="polite">
    <span className="chat-avatar pulse-ring" aria-hidden="true"><WaldoMark size={14}/></span>
    <div className="chat-body">{status}</div>
  </div>;
}

// One conversation: main, or a thread. `head` replaces the default heading; `locked` replaces the composer, as for an archived thread.
export function ChatPanel({ zone: rawZone, thread = null, store = chatStore(thread), head, locked }: { zone?: string; thread?: string | null; store?: ChatStore; head?: ReactNode; locked?: ReactNode }) {
  const chat = useChat(store);
  const zone = zoneOr(rawZone);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  const prepend = useRef<number | null>(null);
  const working = chat.local.filter(item => item.state === 'admitted' || item.state === 'running' || item.state === 'sending');
  const first = working.find(item => item.state !== 'sending');

  useEffect(() => { store.open(); return () => store.close(); }, [store]);
  useEffect(() => { if (!working.length) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [working.length]);
  useEffect(() => { if (window.matchMedia?.('(pointer:fine)').matches) input.current?.focus(); }, []);
  // Keep the textarea as tall as its text, up to a cap where it scrolls.
  useLayoutEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px`; }, [chat.draft]);

  const nearBottom = () => typeof window === 'undefined' || window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
  useEffect(() => { const onScroll = () => { pinned.current = nearBottom(); if (pinned.current) setBehind(false); }; window.addEventListener('scroll', onScroll, { passive: true }); return () => window.removeEventListener('scroll', onScroll); }, []);
  const toBottom = (smooth: boolean) => { const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; window.scrollTo?.({ top: document.documentElement.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' }); setBehind(false); };
  const count = chat.messages.length + chat.local.length;
  const loaded = chat.phase === 'ready';
  useLayoutEffect(() => {
    if (prepend.current !== null) { window.scrollTo?.(0, document.documentElement.scrollHeight - prepend.current + window.scrollY); prepend.current = null; return; }
    if (!loaded) return;
    if (pinned.current) toBottom(chat.arrived.size > 0); else setBehind(true);
  }, [count, loaded, first?.clientId, first?.state]);
  useLayoutEffect(() => { if (loaded) toBottom(false); }, [loaded]);

  const submit = () => {
    const text = chat.draft.trim();
    if (!text || text.length > CHAT_TEXT_MAX) return;
    pinned.current = true;
    if (store.send(text)) input.current?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    if (event.key === 'Escape' && first && !chat.draft) void store.stop(first.clientId);
  };
  const reply = (text: string) => { pinned.current = true; store.send(text); };

  if (chat.phase === 'signed-out') return <section className="tile notice" role="alert"><h1>Sign in to chat with Waldo.</h1><p>{chat.error}</p><a className="button-link" href={signInHref()}>Sign in</a></section>;

  const unlanded = chat.local.filter(item => !item.landed);
  const closures = chat.local.filter(item => item.landed && (item.state === 'interrupted' || item.state === 'revoked' || item.effectsUnconfirmed));
  // A closed turn whose reply has not landed yet: its last words hold the reply's place.
  const holding = chat.local.filter(item => item.state === 'completed' && item.draft && !item.effectsUnconfirmed);
  const lastAssistant = [...chat.messages].reverse().find(message => message.role === 'assistant');
  const repliesOn = lastAssistant !== undefined && chat.messages.at(-1)?.id === lastAssistant.id && !chat.local.some(item => !item.landed || item.state === 'admitted' || item.state === 'running');
  const length = chat.draft.trim().length, over = length > CHAT_TEXT_MAX;
  const empty = loaded && chat.messages.length === 0 && chat.local.length === 0;
  let lastDay = '';

  return <div className="chat">
    {head ?? <div className="chat-head reveal"><h1>Chat</h1><p className="label">Same conversation as your Waldo app.</p></div>}
    <div ref={log} className="chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-busy={chat.phase === 'loading'} aria-label="Conversation with Waldo">
      {chat.phase === 'loading' && <div className="chat-skeleton" role="status"><span className="visually-hidden">Loading your conversation…</span><i className="sk owner"/><i className="sk waldo"/><i className="sk waldo short"/></div>}
      {chat.phase === 'error' && <section className="panel" role="alert"><h2>Couldn’t load this chat.</h2><p>{chat.error}</p><div className="control-actions"><button onClick={() => store.retryLoad()}>Try again</button>{thread !== null && <a className="quiet-link" href="#/chat">Back to main chat</a>}</div></section>}
      {loaded && chat.nextCursor && <div className="chat-older"><button type="button" className="quiet" disabled={chat.older === 'loading'} onClick={() => { prepend.current = document.documentElement.scrollHeight - window.scrollY; void store.loadOlder(); }}>{chat.older === 'loading' ? 'Loading earlier messages…' : chat.older === 'error' ? 'Couldn’t load earlier messages. Try again' : 'Earlier messages'}</button></div>}
      {empty && <div className="chat-empty reveal"><span className="chat-avatar large" aria-hidden="true"><WaldoMark size={22}/></span><h2 className="chat-greeting">{(() => { const m = /^(Good )(\w+)(\.)$/.exec(greeting(zone, new Date(now))); return m ? <>{m[1]}<em>{m[2]}</em>{m[3]}</> : greeting(zone, new Date(now)); })()}</h2>
        <p>{thread === null ? 'Ask Waldo anything about your day. This is the same Waldo, with the same memory, as your app, Telegram and iMessage.' : 'A fresh chat with Waldo, with the same memory. What you say here stays in this chat.'}</p>
        <div className="chat-suggestions">{SUGGESTIONS.map((text, i) => <button key={text} type="button" style={{ '--i': i } as React.CSSProperties} onClick={() => { store.setDraft(text); input.current?.focus(); }}>{text}</button>)}</div></div>}
      {chat.messages.map(message => {
        const day = message.created_at === null ? lastDay : dayKey(message.created_at, zone);
        const divider = message.created_at !== null && day !== lastDay ? <div className="chat-day" role="separator"><span>{dayLabel(message.created_at, zone, now)}</span></div> : null;
        lastDay = day;
        return <div key={message.id} className="chat-row">{divider}{message.role === 'user'
          ? <OwnerMessage text={message.text} at={message.created_at} zone={zone} channel={message.channel}/>
          : <WaldoMessage message={message} zone={zone} arrived={chat.arrived.has(message.id)} replies={repliesOn && message.id === lastAssistant!.id} onReply={reply} shown={chat.streamed.get(message.id)}/>}</div>;
      })}
      {unlanded.map(item => <div key={item.clientId} className="chat-row local"><OwnerMessage text={item.text} at={item.sentAt} zone={zone} status={localStatus(item, store)}/>{item.state !== 'sending' && item.state !== 'failed' && <Closure item={item} store={store}/>}</div>)}
      {closures.map(item => <Closure key={item.clientId} item={item} store={store}/>)}
      {holding.map(item => <Draft key={item.clientId} id={item.clientId} text={item.draft!}/>)}
      {first && <Working item={first} queued={working.length - 1} store={store} now={now}/>}
    </div>
    <div className="chat-dock">
      {behind && <button type="button" className="chat-jump" onClick={() => toBottom(true)}><Icon name="arrow"/>Latest</button>}
      {chat.notice && <p className="chat-notice" role="status">{chat.notice}</p>}
      {locked ?? <form className={`composer${over ? ' over' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }}>
        <label className="visually-hidden" htmlFor="chat-input">Message Waldo</label>
        <textarea id="chat-input" ref={input} rows={1} value={chat.draft} placeholder="Message Waldo" aria-describedby="chat-hint" aria-invalid={over || undefined}
          disabled={chat.phase === 'loading' || chat.phase === 'error'} onChange={event => store.setDraft(event.target.value)} onKeyDown={onKey}/>
        <div className="composer-bar">
          <span id="chat-hint" className="meta">{over ? `${length.toLocaleString()} / ${CHAT_TEXT_MAX.toLocaleString()} characters. Shorten it to send.` : length > CHAT_TEXT_MAX - 400 ? `${(CHAT_TEXT_MAX - length).toLocaleString()} characters left` : 'Enter to send · Shift + Enter for a new line'}</span>
          {!length && first
            ? <button type="button" className="composer-send stop" aria-label="Stop Waldo" title="Stop · Esc" disabled={first.stopping} onClick={() => void store.stop(first.clientId)}><i aria-hidden="true"/></button>
            : <button type="submit" className="composer-send" aria-label="Send message" title="Send · Enter" disabled={!length || over || !loaded}><Icon name="arrow"/></button>}
        </div>
      </form>}
    </div>
  </div>;
}

// The top bar's way into chat; a dot shows while Waldo is working on something you sent here, in any chat.
export function ChatLink({ current, store }: { current: boolean; store?: ChatStore }) {
  const working = useSyncExternalStore(store ? store.subscribe : subscribeAnyChat, store ? () => store.working() : anyWorking, () => false);
  return <a className="chat-link" href="#/chat" aria-label={working ? 'Chat with Waldo, Waldo is working' : 'Chat with Waldo'} aria-current={current ? 'page' : undefined} title="Chat · G then C">
    <Icon name="chat"/>{working && <span className="chat-link-dot" aria-hidden="true"/>}</a>;
}
