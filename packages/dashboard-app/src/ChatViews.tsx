import { useState, type CSSProperties } from 'react';
import type { ChatPart, ChatView } from './chat-model';
import { Icon } from './icons';

type Of<Kind extends ChatView['kind']> = Extract<ChatView, { kind: Kind }>;
const LABEL: Record<ChatView['kind'], string> = { options: 'Options', table: 'Table', steps: 'Plan', timeline: 'Timeline' };
const STATE_WORD = { done: 'done', current: 'in progress', todo: 'to do' } as const;
const TABLE_PREVIEW_ROWS = 8;
// A cell with a digit and no letters reads as an amount, time or count, and lines up on the right.
const AMOUNT = /^[^\p{L}]*\d[^\p{L}]*$/u;
const stagger = (i: number) => ({ '--i': i }) as CSSProperties;
const host = (link: string) => new URL(link).host.replace(/^www\./, '');

function Options({ view }: { view: Of<'options'> }) {
  return <ol className="view-options">{view.items.map((item, i) => <li key={i} className={`view-option${item.pick ? ' pick' : ''}`} style={stagger(i)}>
    <div className="view-option-head"><span className="strong">{item.title}</span>{item.pick && <span className="access-label pick">Waldo’s pick</span>}</div>
    {item.subtitle && <p className="meta">{item.subtitle}</p>}
    {item.facts.length > 0 && <dl className="view-facts">{item.facts.map((fact, n) => <div key={n}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
    {item.note && <p className="view-note">{item.note}</p>}
    {item.link && <a className="view-link" href={item.link} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{host(item.link)}<Icon name="arrow"/></a>}
  </li>)}</ol>;
}

function Table({ view }: { view: Of<'table'> }) {
  const [all, setAll] = useState(false);
  const amount = view.columns.map((_, c) => view.rows.some(row => row[c]) && view.rows.every(row => !row[c] || AMOUNT.test(row[c]!)));
  const rows = all ? view.rows : view.rows.slice(0, TABLE_PREVIEW_ROWS);
  return <>
    <div className="view-table-wrap" role="region" tabIndex={0} aria-label={view.title ?? 'Table'}>
      <table className="view-table">
        <thead><tr>{view.columns.map((column, c) => <th key={c} scope="col" className={amount[c] ? 'num' : undefined}>{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((value, c) => c === 0
          ? <th key={c} scope="row" className={amount[c] ? 'num' : undefined}>{value || '–'}</th>
          : <td key={c} className={amount[c] ? 'num' : undefined}>{value || '–'}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {view.rows.length > TABLE_PREVIEW_ROWS && <button type="button" className="quiet-link view-more" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show fewer rows' : `Show all ${view.rows.length} rows`}</button>}
  </>;
}

function Steps({ view }: { view: Of<'steps'> }) {
  return <ol className="view-steps">{view.items.map((item, i) => <li key={i} className={`view-step ${item.state ?? 'plain'}`} style={stagger(i)}>
    <span className="view-step-mark" aria-hidden="true">{item.state === 'done' ? <Icon name="check"/> : i + 1}</span>
    <div><span className="strong">{item.title}</span>{item.state && <span className="visually-hidden">, {STATE_WORD[item.state]}</span>}{item.detail && <p className="meta">{item.detail}</p>}</div>
  </li>)}</ol>;
}

function Timeline({ view }: { view: Of<'timeline'> }) {
  return <ol className="view-timeline">{view.items.map((item, i) => <li key={i} style={stagger(i)}>
    <span className="view-when">{item.when}</span><span className="view-rail" aria-hidden="true"/>
    <div><span className="strong">{item.title}</span>{item.detail && <p className="meta">{item.detail}</p>}</div>
  </li>)}</ol>;
}

// How far a plan has come, when it says: the bar fills to the steps done.
function Progress({ view }: { view: Of<'steps'> }) {
  if (!view.items.some(item => item.state)) return null;
  const done = view.items.filter(item => item.state === 'done').length;
  return <span className="view-progress"><span className="meta">{done} of {view.items.length} done</span>
    <span className="view-bar" role="progressbar" aria-label="Steps done" aria-valuemin={0} aria-valuemax={view.items.length} aria-valuenow={done}><i style={{ width: `${(done / view.items.length) * 100}%` }}/></span></span>;
}

export function ViewCard({ part }: { part: Extract<ChatPart, { type: 'view' }> }) {
  const { view } = part;
  return <section className={`chat-view chat-view-${view.kind}`} aria-label={view.title ?? LABEL[view.kind]}>
    <header className="chat-view-head"><span className="label">{LABEL[view.kind]}</span>{view.title && <h3>{view.title}</h3>}{view.kind === 'steps' && <Progress view={view}/>}</header>
    {view.kind === 'options' ? <Options view={view}/> : view.kind === 'table' ? <Table view={view}/> : view.kind === 'steps' ? <Steps view={view}/> : <Timeline view={view}/>}
  </section>;
}
