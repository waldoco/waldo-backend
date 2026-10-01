// Test-only Google adapter over the isolated, per-owner source world. Provider methods are
// intentionally narrow: unimplemented reads and all effects fail closed, never touch Google.
import type { CalendarItem, GoogleClient, MailItem, TaskItem, TaskStatusFilter, ThreadMessage } from '../src/connectors/google';
import { IsolatedSourceWorld } from './isolated-source-world';

const copy = <T>(value: unknown): T => structuredClone(value) as T;
const day = (date: string): number => Date.parse(date);
const rejectEffect = (): never => { throw new Error('fixture effect requires a separate intercepted approval path'); };
const rejectRead = (): never => { throw new Error('fixture source not implemented'); };

export const isolatedGoogleClient = (world: IsolatedSourceWorld, owner: string): GoogleClient => ({
  freeBusy: async()=>rejectRead(),
  mailPage:async(query,limit,pageToken)=>{
    // Fixture supports only the concrete read handler's Primary/date query, never
    // a general Gmail search oracle. Selection/owner boundary runs before collection.
    const range=/^in:inbox category:primary after:(-?\d+) before:(-?\d+)$/.exec(query);
    if(!range||!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error('unsupported fixture Gmail page request');
    const from=Number(range[1])*1000,to=Number(range[2])*1000;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from>=to)throw new Error('invalid fixture Gmail window');
    const rows=world.list(owner,'mail').filter(row=>{
      const at=day(String(row.at));
      if(!Number.isFinite(at))throw new Error('invalid fixture mail timestamp');
      return at>=from&&at<to&&row.in_inbox!==false&&(row.category===undefined||row.category==='primary');
    }).sort((a,b)=>day(String(b.at))-day(String(a.at))||(a.id<b.id?-1:a.id>b.id?1:0));
    const binding=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({owner,query,limit,rows}))))).map(n=>n.toString(16).padStart(2,'0')).join('');
    let offset=0;
    if(pageToken!==undefined){
      try{const token=JSON.parse(decodeURIComponent(pageToken));
        if(!token||token.binding!==binding||!Number.isSafeInteger(token.offset)||token.offset<1||token.offset>=rows.length||token.offset%limit!==0)throw new Error();
        offset=token.offset;
      }catch{throw new Error('fixture Gmail cursor owner/query/revision mismatch');}
    }
    const messages=rows.slice(offset,offset+limit).map(row=>{
      if(['thread_id','from','subject','snippet','at'].some(k=>typeof row[k]!=='string'))throw new Error('invalid fixture mail metadata');
      return {id:row.id,thread_id:String(row.thread_id),from:String(row.from),subject:String(row.subject),snippet:String(row.snippet),at:String(row.at)};
    });
    const next=offset+messages.length;
    return {messages,next_page_token:next<rows.length?encodeURIComponent(JSON.stringify({binding,offset:next})):null,result_size_estimate:rows.length};
  },
  events: async (from, to, limit, includeDeclined) => world.list(owner, 'calendar')
    .filter((row) => day(String(row.start)) < day(to) && day(String(row.end)) >= day(from) && (includeDeclined || row.status !== 'declined'))
    .slice(0, limit).map((row) => copy<CalendarItem>(row)),
  event: async (id) => { const row = world.read(owner, 'calendar', id); return row ? copy<CalendarItem>(row) : rejectRead(); },
  changedEvents: async () => rejectRead(),
  newMail: async (since, limit) => world.list(owner, 'mail').filter((row) => day(String(row.at)) >= since)
    .sort((a, b) => day(String(b.at)) - day(String(a.at))).slice(0, limit).map((row) => copy<MailItem>(row)),
  searchMail: async () => rejectRead(),
  readThread: async (threadId, limit) => world.list(owner, 'mail').filter((row) => row.thread_id === threadId)
    .slice(0, limit).map((row) => copy<ThreadMessage>(row)),
  tasks: async (status: TaskStatusFilter, limit) => world.list(owner, 'tasks')
    .filter((row) => status === 'all' || (status === 'done' ? row.status === 'done' : row.status === 'todo'))
    .slice(0, limit).map((row) => copy<TaskItem>(row)),
  draft: async () => rejectEffect(), sendRaw: async () => rejectEffect(), findSentByMessageId: async () => rejectRead(),
  createEvent: async () => rejectEffect(), moveEvent: async () => rejectEffect(), cancelEvent: async () => rejectEffect(),
});

// Explicit test-only effect opt-in. The regular adapter above continues to reject every
// mutation; an approval test must choose this wrapper and inspect the world outbox.
export const isolatedCalendarEffectClient = (world: IsolatedSourceWorld, owner: string): GoogleClient => {
  return {
    ...isolatedGoogleClient(world, owner),
    createEvent: async (input) => {
      return copy<CalendarItem>(world.commitCalendarCreate(owner, input, world.nextProviderKey(owner)));
    },
  };
};
