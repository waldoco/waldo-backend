import {armAlarm} from '../scheduler/alarm-slot';
export const LINK_MODE='telegram_link_mode_v1';
export const LINK_ROWS='telegram_link_rows_v1';
export const LINK_DUE='telegram_link_due_v1';
// Same receipt bound as owner inbox; covers Telegram's documented <=24h update lifetime.
const RETENTION=25*60*60_000;
const CAPACITY=512;
export type LinkBinding={bot:string;subject:string;name:string};
export type LinkRow={id:number;digest:string;hash?:string;at:number;state:'admitted'|'attempting'|'frozen'|'completed';text?:string};
export class TelegramLinkInbox{
 constructor(private readonly storage:DurableObjectStorage,private readonly now:()=>number=Date.now){}
 async records():Promise<LinkRow[]>{return await this.storage.get<LinkRow[]>(LINK_ROWS)??[]}
 private async save(t:DurableObjectTransaction,rows:LinkRow[]):Promise<void>{
  const due=rows.length?Math.min(...rows.map(r=>r.state==='completed'?r.at+RETENTION:this.now()+250)):null;
  await t.put({[LINK_ROWS]:rows,[LINK_DUE]:due});
  if(due!==null){const existing=await t.getAlarm();await armAlarm(t,Math.max(this.now()+250,existing===null?due:Math.min(due,existing)))}
 }
 async admit(b:LinkBinding,id:number,digest:string,hash:string):Promise<'admitted'|'duplicate'|'conflict'|'capacity'>{
  return this.storage.transaction(async t=>{
   const mode=await t.get<LinkBinding>(LINK_MODE);
   if(mode&&(mode.bot!==b.bot||mode.subject!==b.subject||mode.name!==b.name))throw Error('routing binding conflict');
   if(await t.get('do_name')||await t.get('telegram_subject'))throw Error('routing object owner conflict');
   const all=await t.get<LinkRow[]>(LINK_ROWS)??[];const prior=all.find(r=>r.id===id);
   if(prior)return prior.digest===digest?'duplicate':'conflict';
   const rows=all.filter(r=>r.state!=='completed'||r.at+RETENTION>this.now());if(rows.length>=CAPACITY)return'capacity';
   rows.push({id,digest,hash,at:this.now(),state:'admitted'});await t.put(LINK_MODE,b);await this.save(t,rows);return'admitted';
  });
 }
 async begin(id:number):Promise<{hash:string}|null>{
  return this.storage.transaction(async t=>{const rows=await t.get<LinkRow[]>(LINK_ROWS)??[];const row=rows.find(r=>r.id===id);if(!row||row.state!=='admitted'||!row.hash)return null;
   const hash=row.hash;delete row.hash;row.state='attempting';await this.save(t,rows);return{hash};});
 }
 async freeze(id:number,text:string):Promise<void>{
  // Credential removal is separate from response freeze so a later freeze failure
  // never strands redeemable data in a recovered tombstone.
  await this.storage.transaction(async t=>{const rows=await t.get<LinkRow[]>(LINK_ROWS)??[];const row=rows.find(r=>r.id===id);if(!row)return;delete row.hash;if(row.state==='admitted')row.state='attempting';await this.save(t,rows)});
  await this.storage.transaction(async t=>{const rows=await t.get<LinkRow[]>(LINK_ROWS)??[];const row=rows.find(r=>r.id===id);if(!row||row.state==='completed'||row.state==='frozen')return;row.state='frozen';row.text=text;await this.save(t,rows)});
 }
 async complete(id:number):Promise<void>{await this.storage.transaction(async t=>{const rows=(await t.get<LinkRow[]>(LINK_ROWS)??[]).filter(r=>r.state!=='completed'||r.at+RETENTION>this.now());const row=rows.find(r=>r.id===id);if(row){row.state='completed';delete row.hash;delete row.text;}await this.save(t,rows)});}
}
