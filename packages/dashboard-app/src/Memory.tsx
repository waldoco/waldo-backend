import {buildMemoryDestination,parseMemoryDestination,type MemoryListDestination} from './destinations';
import {ControlsPanel} from './Controls';
import {MemoryActions} from './MemoryActions';
import {Icon} from './icons';
import {SourceBar} from './Infographics';
import {dayKey,SpotCalendar} from './SpotCalendar';
import {exactTime,relativeTime} from './time';
import {Branches} from '@lucasmarkes/hairline/react';
import {useEffect,useState} from 'react';
import {fetchMemory,memoryItemLink,MemoryReadError,type Claim,type MemoryStatus,type MemoryPage,type MemoryDetail} from './memory-model';
import {SignInRequired,signInHref} from './model';
const recorded=(value:string)=>Number.isNaN(Date.parse(value))?'Time unavailable':new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short',timeZoneName:undefined}).format(new Date(value));
const source=(value:string)=>value==='inferred'?'Waldo’s inference':value==='stated'?'You said this':value==='confirmed'?'You confirmed this':'Recorded source: '+value;
const sourceMix=(items:Claim[])=>{const counts=new Map<string,number>();for(const item of items)counts.set(item.source,(counts.get(item.source)??0)+1);
 const name=(key:string)=>({stated:'you said',confirmed:'you confirmed',inferred:'inferred'}[key]??key);
 return [...counts].sort((a,b)=>b[1]-a[1]).map(([key,count])=>({key,label:name(key),count}));};
const origin=(value:string)=>({owner:'Owner',agent:'Added by an agent',shared:'Shared · origin unverified',untrusted:'Untrusted origin',legacy:'Older record'}[value]??'Origin unavailable');
export function MemoryReadNotice({data}:{data:MemoryStatus}) {
 if(data.state==='available'&&data.complete)return null;
 return <div className="memory-read-notice" role="status"><strong>{data.state==='unavailable'?'Memory unavailable':'Incomplete Memory read'}</strong><p>These are only the records available in this read. Missing or withheld records are not an empty Memory or proof of completed removal.</p>{data.unavailable_claim_count>0&&<p>{data.unavailable_claim_count} claims withheld during removal. Retained text may still require a removal retry.</p>}</div>;
}
type MemoryView='list'|'calendar';
/** List or Calendar. The list opens first. */
export function ViewToggle({value,onChange}:{value:MemoryView;onChange:(v:MemoryView)=>void}) {
 const options:[MemoryView,string,'entry'|'calendar'][]=[['list','List','entry'],['calendar','Calendar','calendar']];
 return <div className="view-toggle" role="group" aria-label="How to show this">{options.map(([v,name,icon])=><button key={v} aria-pressed={value===v} onClick={()=>onChange(v)}><Icon name={icon}/>{name}</button>)}</div>;
}
export function MemoryList({data,onNext,onRestart,returnTo,initialView,view:shown,onView}:{data:MemoryPage;returnTo?:MemoryListDestination;onNext:()=>void;onRestart:()=>void;initialView?:MemoryView;view?:MemoryView;onView?:(v:MemoryView)=>void}) {
 const [own,setOwn]=useState<MemoryView>(initialView??'list');
 const view=shown??own;
 const setView=(v:MemoryView)=>{(onView??setOwn)(v);if(v!=='calendar')setDay(null);};
 const [filter,setFilter]=useState<'all'|'inferred'>('all');
 const [day,setDay]=useState<string|null>(null);
 const items=(filter==='inferred'?data.items.filter(item=>item.source==='inferred'):data.items).filter(item=>!day||dayKey(item.recorded_at)===day);
 return <><MemoryReadNotice data={data}/><SourceBar segments={sourceMix(data.items)} scope="Where each Spot came from, this page"/><div className="memory-list-toolbar"><p className="label">{data.page.returned} of {data.page.total} Spots in this read</p><button className="quiet" onClick={onRestart}>Refresh list</button></div>
 <ViewToggle value={view} onChange={setView}/>
 {view==='calendar'&&<SpotCalendar spots={data.items} selected={day} onSelect={setDay}/>}
 {day&&<p className="day-filter" role="status">Showing {new Intl.DateTimeFormat('en',{month:'short',day:'numeric'}).format(new Date(`${day}T12:00:00`))} <button className="quiet" onClick={()=>setDay(null)}>Show all</button></p>}
 <div className="memory-local-filters" role="group" aria-label="Filters for this returned page"><button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>All</button><button aria-pressed={filter==='inferred'} onClick={()=>setFilter('inferred')}>Inferred</button><span className="label">This page only, not all of Memory.</span></div>
 <div className="memory-record-list">{items.map(item=><a className="memory-record" key={item.id} href={memoryItemLink('spots',item.id,returnTo)}>
  <Icon name="spot" className="record-icon"/><div><h2>{item.text}</h2><p className="memory-meta">{source(item.source)}{item.origin!=='owner'?` · ${origin(item.origin)}`:''}{item.status!=='active'?` · ${item.status}`:''}</p><p className="muted" title={exactTime(item.recorded_at)}>Saved {relativeTime(item.recorded_at)}</p></div><span className="chevron" aria-hidden="true">→</span>
 </a>)}</div>
 {filter==='inferred'&&!items.length&&data.items.length>0&&<p role="status">No inferred Spots returned on this page.</p>}
 {!data.items.length&&data.complete&&data.state==='available'&&<section className="tile empty"><h2>{data.page.total===0?'No saved Spots yet.':'Nothing on this page.'}</h2><p>{data.page.total===0?'That’s the complete list in this read.':'Records may have changed since the last page. Go back to the first page or refresh.'}</p></section>}
 <nav className="memory-pagination" aria-label="Memory list pages"><button onClick={onRestart}>First page</button><button disabled={!data.page.next_cursor} onClick={onNext}>Next page</button></nav></>;
}
export function MemoryDetailView({data,returnTo}:{data:MemoryDetail;returnTo?:MemoryListDestination}) {
 const item=data.item,back=returnTo??{view:'spots' as const};
 return <><MemoryReadNotice data={data}/><a className="quiet-link back-link" href={buildMemoryDestination({kind:'list',...back})}>← Back to Spots</a><section className="memory-item-detail tile"><span className="label">Saved Spot</span><h2>{item.text}</h2>
 <p className="memory-meta">{source(item.source)} · {item.origin!=='owner'?`${origin(item.origin)} · `:''}{item.status}</p><section className="memory-evidence"><h3>Writer’s note · not proof of truth</h3><p>{item.evidence.text||'No writer note recorded.'}</p><p>{item.source_reference.state==='unverified'?'An unverified pointer is recorded. It is not an original-message link.':'No retrievable original-message source is available.'}</p></section><details className="memory-technical"><summary>Technical details</summary><dl><dt>Recorded source</dt><dd>{item.source||'Unavailable'}</dd><dt>Origin</dt><dd>{origin(item.origin)}</dd><dt>Kind</dt><dd>{item.kind}</dd><dt>Source pointer withheld</dt><dd>{item.source_reference.state}</dd><dt>Recorded</dt><dd>{recorded(item.recorded_at)}</dd><dt>Writer seen count</dt><dd>{item.writer_seen_count??'Unavailable'} · not independently verified observations</dd></dl></details>
 </section></>;
}
function locationState(){return parseMemoryDestination(typeof window==='undefined'?'#/memory/spots':window.location.hash);}
export function MemoryPanel({subview}:{subview:'spots'|'profile'}) {
 const [location,setLocation]=useState(locationState);const [retry,setRetry]=useState(0);
 const [view,setView]=useState<MemoryView>('list');
 const destination=location.kind==='valid-memory'?location.destination:null;
 const id=destination?.kind==='detail'?destination.id:null;
 const cursor=destination?.kind==='list'?destination.cursor:undefined;
 const returnTo=destination?.kind==='detail'?destination.returnTo:undefined;
 const navigate=(fragment:string)=>{setLocation(parseMemoryDestination(fragment));window.location.hash=fragment;};
 const [state,setState]=useState<{kind:'loading'}|{kind:'ready';data:MemoryPage|MemoryDetail}|{kind:'error';message:string;code?:string;signedOut:boolean}>({kind:'loading'});
 useEffect(()=>{const change=()=>{setLocation(locationState());};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
 useEffect(()=>{
  if(subview==='profile'||!destination)return;
  const abort=new AbortController();setState({kind:'loading'});
  const params=new URLSearchParams(id?{view:'detail',id}:{view:'claims',limit:'25'});
  if(cursor)params.set('cursor',cursor);
  fetchMemory(params,abort.signal).then(data=>{if(!abort.signal.aborted)setState({kind:'ready',data});}).catch(e=>{if(!abort.signal.aborted)setState({kind:'error',message:e instanceof Error?e.message:'Memory unavailable.',code:e instanceof MemoryReadError?e.code:undefined,signedOut:e instanceof SignInRequired});});return()=>abort.abort();
 },[subview,id,cursor,retry,location.kind]);
 const restart=()=>{if(destination?.kind==='list'&&cursor)navigate(buildMemoryDestination({kind:'list',view:destination.view}));else setRetry(n=>n+1);};
 const next=(value:string|null)=>{if(value&&destination?.kind==='list')navigate(buildMemoryDestination({...destination,cursor:value}));};
 return <><div className="page-heading"><h1>Memory.</h1><p>What he’s saved about you, and the evidence behind it. Confirm anything, or have him forget it.</p><Branches className="figure heading-figure" label="A commit graph, an interactive illustration. Decorative."/></div><nav className="segmented" aria-label="Memory subviews">{(['spots','profile'] as const).map(v=><a href={`#/memory/${v}`} aria-current={v===subview?'page':undefined} key={v}><Icon name={v==='spots'?'spot':'person'}/>{v==='spots'?'Spots':'Profile'}</a>)}</nav>
 {!destination?<section className="tile" role="alert"><h2>Memory link unavailable.</h2><p>This link has unsupported or invalid selectors. No Memory read or action was requested.</p><a className="quiet-link" href="#/memory/spots">Return to Spots</a></section>:subview==='profile'?<ControlsPanel key="profile" view="profile" embedded/>:state.kind==='loading'?<p role="status">Loading your saved {id?'item':'Spots'}…</p>:state.kind==='error'?<section className="tile" role="alert"><h2>Memory unavailable.</h2><p>{state.message}</p>{state.signedOut?<a href={signInHref()}>Sign in</a>:<><button onClick={restart}>{state.code==='cursor_invalid'?'Restart list':'Retry read'}</button> <a href={buildMemoryDestination({kind:'list',...(returnTo??{view:'spots'})})}>Back to list</a></>}</section>:state.data.view==='detail'?<MemoryDetailView data={state.data} returnTo={returnTo}/>:<MemoryList view={view} onView={setView} data={state.data} returnTo={{view:'spots',...(cursor?{cursor}:{})}} onRestart={restart} onNext={()=>next(state.data.view==='claims'?state.data.page.next_cursor:null)}/>}
 {id&&subview!=='profile'&&<MemoryActions key={id} id={id} onChanged={restart}/>}
 </>;
}
